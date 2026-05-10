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
import type { KovitoboardSetting } from '../../shared/setting-types'

export function createConfigRouter(fs: FileAccessLayer, projectRoot: string): Router {
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
  router.put('/setting', (req, res) => {
    const body = req.body
    if (!validateSetting(body)) {
      res.status(400).json({ error: 'Invalid setting data' })
      return
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

      // Run guidance injection while we still have the original body
      // — if the injection records a `lastInjectedAt`, we merge it
      // into the body so a single `writeSetting` persists everything.
      // Best-effort: failures are logged inside the helper and never
      // bubble up.
      let toWrite: KovitoboardSetting = body
      if (isOnboardingCompletionTransition) {
        const injection = maybeInjectClaudeMdGuidance(fs, body)
        if (injection.injected && injection.injectedAt) {
          toWrite = {
            ...body,
            claudeMdGuidance: {
              ...(body.claudeMdGuidance ?? {}),
              lastInjectedAt: injection.injectedAt,
            },
          }
        }
        serverLogger.info(
          {
            injected: injection.injected,
            reason: injection.reason,
          },
          '[config-routes] CLAUDE.md guidance injection result',
        )
      }

      writeSetting(fs, toWrite)

      // Install agent-ref docs on setting write (R12)
      try {
        const result = installAgentRefDocs(fs, body.project.path, body.locale)
        if (result.installed) {
          serverLogger.info(
            `[config-routes] Installed agent-ref docs to ${body.project.path}/.kovitoboard/agent-ref/`
          )
        }
      } catch (refErr) {
        serverLogger.warn({ err: refErr }, '[config-routes] Failed to install agent-ref docs')
      }

      res.json({ success: true })
    } catch (err) {
      serverLogger.error({ err }, '[config-routes] Failed to write setting:')
      res.status(500).json({ error: 'Failed to write setting' })
    }
  })

  // GET /api/config/project-root (DEC-009: for Step 3 display)
  router.get('/project-root', (_req, res) => {
    res.json({ projectRoot })
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
