/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Configuration API router
 *
 * GET  /api/config/setting       — Get KovitoBoard settings
 * PUT  /api/config/setting       — Update KovitoBoard settings
 * GET  /api/config/project-root  — Return the projectRoot resolved at startup (DEC-009)
 * POST /api/config/setup-agent-ref — Create agent-ref symlink (deprecated; copy approach preferred)
 */
import { serverLogger } from '../logger'
import { Router } from 'express'
import { join, resolve } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting, writeSetting, validateSetting } from '../setting-manager'
import { installAgentRefDocs } from '../agent-ref-installer'
import { maybeInjectClaudeMdGuidance } from '../services/claude-md-guidance'

/**
 * Build the configuration router.
 *
 * @param projectRoot         supervisor-resolved absolute path
 * @param projectRootSource   how the supervisor arrived at that path
 *                            (cli-arg / env / setting-json / cwd-fallback).
 *                            Defaults to 'cli-arg' when omitted so existing
 *                            callers that have not been updated keep working
 *                            in tests and ad-hoc scripts; the production
 *                            wiring in `src/server/index.ts` always passes
 *                            the actual source resolved at startup.
 */
export function createConfigRouter(
  fs: FileAccessLayer,
  projectRoot: string,
  projectRootSource: 'cli-arg' | 'env' | 'setting-json' | 'cwd-fallback' = 'cli-arg',
): Router {
  const router = Router()

  // GET /api/config/setting
  router.get('/setting', (_req, res) => {
    const setting = readSetting(fs)
    if (!setting) {
      res.json(null)
      return
    }
    res.json(setting)
  })

  // PUT /api/config/setting
  router.put('/setting', async (req, res) => {
    const body = req.body
    if (!validateSetting(body)) {
      res.status(400).json({ error: 'Invalid setting data' })
      return
    }
    // SECURITY: `claudeMdGuidance.lastInjectedAt` is a server-managed
    // audit field. The injection helper records it after a real write
    // (see the follow-up `writeSetting` below). Strip any client-
    // supplied value before persistence so a crafted PUT cannot forge
    // an injection timestamp — including the `disabled = true` case
    // where no CLAUDE.md write happens, which would otherwise let the
    // client persist arbitrary timestamps unattended.
    if (body.claudeMdGuidance && 'lastInjectedAt' in body.claudeMdGuidance) {
      delete body.claudeMdGuidance.lastInjectedAt
    }
    try {
      // Detect the onboarding-completion transition
      // (`onboarding.completedAt: null/undefined → string`) BEFORE
      // writing the new setting. Spec
      // `claude-md-guidance-injection.md` v1.2 §8.3 ("notification
      // is fired exactly once on onboarding completion") gates the
      // CLAUDE.md guidance injection on this transition. Reading
      // the prior file before write is the only way to know whether
      // this PUT is the first completion.
      const prev = readSetting(fs)
      const prevCompleted = prev?.onboarding?.completedAt ?? null
      const nextCompleted = body.onboarding?.completedAt ?? null
      const isOnboardingCompletionTransition =
        prevCompleted == null && typeof nextCompleted === 'string'

      // PUT /api/config/setting is a full-document write. Without
      // merging the persisted `claudeMdGuidance` block back in, two
      // regressions surface:
      //
      //   (a) any later unrelated update (e.g. avatar change) would
      //       erase the server-managed `lastInjectedAt` audit field
      //       recorded by a previous injection — clients never resend
      //       it because we strip it from the request body above.
      //   (b) a wizard run that omits `claudeMdGuidance` entirely
      //       would silently clear an already-persisted `disabled =
      //       true` opt-out (the wizard sends `claudeMdGuidance` only
      //       when the user actively checks the opt-out box).
      //
      // Spread order: persisted server-managed fields first, then any
      // client-supplied fields on top. Clients that explicitly send
      // `disabled: false` still see that take effect (opt-in remains
      // possible); clients that omit the block preserve persisted
      // state. The server-managed `lastInjectedAt` is already stripped
      // from the body above, so it can only come from `prev` here.
      if (prev?.claudeMdGuidance) {
        body.claudeMdGuidance = {
          ...prev.claudeMdGuidance,
          ...(body.claudeMdGuidance ?? {}),
        }
      }

      // SECURITY: overwrite the client-supplied `project.path` with
      // the supervisor-trusted `projectRoot` before persisting.
      // `validateSetting` only checks the type and non-emptiness,
      // not the location, so a crafted PUT could otherwise persist
      // an attacker-controlled path into `.kovitoboard/setting.json`
      // and influence later code that reads `setting.project.path`
      // (notably `config.ts` `resolveProjectRootWithSource`
      // priority-3 when CLI / env are unset). Since the wizard
      // reads its displayed value from `GET /api/config/project-root`
      // (which already returns the supervisor-trusted root),
      // legitimate clients send the same value we are about to
      // overwrite — this normalization is a no-op for them and a
      // defense-in-depth strip for everything else.
      body.project = { ...body.project, path: projectRoot }

      // Persist the new setting first so the onboarding-completion
      // marker (`onboarding.completedAt`) is durable before any
      // user-facing file (CLAUDE.md) is touched. If injection runs
      // first and `writeSetting` then fails, CLAUDE.md is mutated
      // while `setting.json` still says onboarding is incomplete —
      // the marker prevents a re-injection on retry, so the two
      // states diverge silently. Writing the setting first keeps
      // recovery deterministic.
      //
      // `writeSetting()` is async since spec cwd-allowlist.md v1.1
      // §7.5 (CodeX PR #38 Attempt 3 MED 1 mitigation — async CAS
      // backoff to avoid event-loop blocking).
      await writeSetting(fs, body)

      // Install agent-ref docs on setting write (R12).
      //
      // SECURITY (Phase 2-A hardening): the destination root is
      // anchored on the *server-trusted* `projectRoot` resolved by
      // the supervisor at startup, NOT on `body.project.path` from
      // the request body. Trusting the client payload here would let
      // a crafted PUT redirect the agent-ref tree (and the bundled
      // .md docs it carries) outside the project root — any caller
      // of `PUT /api/config/setting` can put any string into
      // `project.path` because `validateSetting` only checks type
      // and non-emptiness, not the location. This mirrors the
      // CLAUDE.md guidance injection pattern (PR #19, D-trusted-root)
      // applied below.
      try {
        const result = installAgentRefDocs(fs, projectRoot, body.locale)
        if (result.installed) {
          serverLogger.info(
            `[config-routes] Installed agent-ref docs to ${projectRoot}/.kovitoboard/agent-ref/`
          )
        }
      } catch (refErr) {
        serverLogger.warn({ err: refErr }, '[config-routes] Failed to install agent-ref docs')
      }

      // Run guidance injection AFTER the setting write is durable.
      // The helper anchors its target on the server-trusted
      // `projectRoot` rather than `body.project.path`, so a crafted
      // PUT cannot redirect the write outside the project root.
      // Best-effort: failures are logged inside the helper.
      if (isOnboardingCompletionTransition) {
        const injection = maybeInjectClaudeMdGuidance(fs, body, projectRoot)
        serverLogger.info(
          {
            injected: injection.injected,
            reason: injection.reason,
          },
          '[config-routes] CLAUDE.md guidance injection result',
        )
        if (injection.injected && injection.injectedAt) {
          // Record `lastInjectedAt` with a follow-up write so the
          // setting reflects the actual injection timestamp. If
          // this write fails the file is still in place; the
          // marker check on the next attempt would short-circuit
          // anyway, so the missing timestamp is benign (it just
          // means the audit log loses one timestamp entry).
          try {
            const refreshed = readSetting(fs) ?? body
            await writeSetting(fs, {
              ...refreshed,
              claudeMdGuidance: {
                ...(refreshed.claudeMdGuidance ?? {}),
                lastInjectedAt: injection.injectedAt,
              },
            })
          } catch (writeErr) {
            serverLogger.warn(
              { err: writeErr },
              '[config-routes] Failed to record claudeMdGuidance.lastInjectedAt',
            )
          }
        }
      }

      res.json({ success: true })
    } catch (err) {
      serverLogger.error({ err }, '[config-routes] Failed to write setting:')
      res.status(500).json({ error: 'Failed to write setting' })
    }
  })

  // GET /api/config/project-root (DEC-009: for Step 3 display).
  // Now also returns the resolution `source`
  // (cli-arg / env / setting-json / cwd-fallback) so the
  // ProjectRootBanner can flag a cwd-fallback as a warning state
  // (process-lifecycle.md v1.2 §3, M-2 in
  // shared-installation-prevention-request.md). Adding `source` is
  // additive — existing callers that only read `projectRoot`
  // continue to work unchanged.
  router.get('/project-root', (_req, res) => {
    res.json({ projectRoot, source: projectRootSource })
  })

  // POST /api/config/setup-agent-ref
  // DEPRECATED: Symlink approach — prefer the copy-based installation via
  // installAgentRefDocs() which runs automatically on PUT /api/config/setting.
  // Symlinks can break if the KB install directory moves; copies are more robust.
  // Kept for backward compatibility.
  router.post('/setup-agent-ref', (_req, res) => {
    try {
      const kbRoot = resolve(projectRoot, 'kovitoboard')
      const source = join(kbRoot, 'docs', 'agent-ref')
      const targetDir = join(projectRoot, 'docs')
      const targetLink = join(targetDir, 'agent-ref')

      // Skip if source does not exist
      if (!fs.existsSync(source)) {
        res.json({ success: true, skipped: true, reason: 'source docs/agent-ref/ not found' })
        return
      }

      // Skip if target already exists (avoid overwriting existing files)
      if (fs.existsSync(targetLink)) {
        res.json({ success: true, skipped: true, reason: 'docs/agent-ref/ already exists' })
        return
      }

      // Create docs/ directory if it does not exist
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }

      // Create the symlink
      fs.symlinkSync(source, targetLink, 'dir')
      res.json({ success: true, skipped: false, link: targetLink, target: source })
    } catch (err) {
      serverLogger.error({ err }, '[config-routes] Failed to create agent-ref symlink:')
      res.status(500).json({ error: 'Failed to create agent-ref symlink' })
    }
  })

  return router
}
