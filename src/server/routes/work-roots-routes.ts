/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Work-roots API router (spec `cwd-allowlist.md` v1.0 §5.3 / §6.2).
 *
 *   GET    /api/work-roots          — list additionalWorkRoots[] (canonical)
 *   POST   /api/work-roots          — add a new work root (strict validation)
 *   DELETE /api/work-roots          — remove an existing work root
 *
 * Why a dedicated endpoint instead of `PUT /api/config/setting`:
 *   The setting writer treats `additionalWorkRoots[]` /
 *   `workRootsMetadata` / `revision` as protected fields (spec §5.3 —
 *   generic config writes MUST reject paths into them; the
 *   recipe-system §6.6 hardcoded exclusion covers the corresponding
 *   write-file gate). All allow-list mutations therefore funnel
 *   through this router, where we can run §6.2.2's 7-step validation
 *   before touching disk.
 *
 * Error contract (§6.2.2 / §6.2.3):
 *   POST / DELETE responses use the endpoint-local envelope
 *   `{ error, message, path }`. This is intentionally **not** the
 *   §6.4 envelope that `validateCwd()` consumers use — the two
 *   represent different categories (endpoint operation error vs.
 *   consumer cwd-validation error) and conflating them in the UI
 *   would lose the operational distinction (Codex Attempt 1 MEDIUM 3
 *   fix).
 *
 * CAS retry (§7.5):
 *   POST / DELETE drive their own CAS retry policy (3 attempts with
 *   50/100/200 ms exponential backoff). The backoff is async
 *   (`await sleep(...)`) so contention does not block the event loop
 *   (CodeX Attempt 1 MEDIUM 2). When the budget is exhausted we
 *   surface HTTP 409 + `setting_collision` so the client can retry at
 *   its own pace.
 */
import { Router, type Response } from 'express'
import { isAbsolute } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import {
  readSettingWithRevision,
  writeSettingCas,
  SettingConflictError,
} from '../setting-manager'
import { isDenylisted, getDenylistAnchors } from '../cwdValidator'
import { probeWorkRoot } from '../fs-probe'
import { lazyChildLogger } from '../logger'

const workRootsLog = lazyChildLogger('work-roots-routes')

/** Maximum CAS retries per request (§7.5). */
const CAS_MAX_RETRIES = 3
/** Exponential backoff between CAS retries (ms). */
const CAS_BACKOFF_MS = [50, 100, 200] as const

/**
 * Build the work-roots router. The router is mounted at
 * `/api/work-roots` by `src/server/index.ts`.
 */
export function createWorkRootsRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // GET /api/work-roots
  router.get('/', (_req, res) => {
    const result = readSettingWithRevision(fs)
    res.json({
      additionalWorkRoots: result?.setting.additionalWorkRoots ?? [],
    })
  })

  // POST /api/work-roots
  router.post('/', async (req, res) => {
    const input = req.body?.path
    if (typeof input !== 'string') {
      sendError(res, 400, 'not_absolute', 'Path must be a string', input)
      return
    }

    // Step 1: absolute-only (§6.2.2 normative).
    if (!isAbsolute(input)) {
      sendError(res, 400, 'not_absolute', 'Path must be an absolute path', input)
      return
    }

    // Step 2: realpath (resolves existence, symlink loops, and
    // permission errors in one call). We do not pre-check with
    // `existsSync()` because it flattens EACCES / ELOOP into a falsy
    // answer and would lose the dedicated `permission_denied` /
    // `symlink_loop` error cases (CodeX Attempt 2 LOW 4).
    let canonical: string
    try {
      canonical = fs.realpathSync(input)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        sendError(res, 400, 'not_found', 'Path does not exist', input)
        return
      }
      if (code === 'ELOOP') {
        sendError(res, 400, 'symlink_loop', 'Symlink loop detected', input)
        return
      }
      if (code === 'EACCES') {
        sendError(res, 400, 'permission_denied', 'Permission denied', input)
        return
      }
      // Unknown errno: fail-closed via not_found so we never claim
      // the path is valid.
      sendError(res, 400, 'not_found', 'Path does not exist', input)
      return
    }

    // Step 3: isDirectory check on the canonical form (so a symlink
    // pointing at a non-directory is rejected on its actual target).
    let stat
    try {
      stat = fs.statSync(canonical)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES') {
        sendError(res, 400, 'permission_denied', 'Permission denied', input)
        return
      }
      if (code === 'ENOENT') {
        sendError(res, 400, 'not_found', 'Path does not exist', input)
        return
      }
      sendError(res, 400, 'not_found', 'Path does not exist', input)
      return
    }
    if (!stat.isDirectory) {
      sendError(res, 400, 'not_directory', 'Path is not a directory', input)
      return
    }

    // Step 5: denylist.
    const anchors = getDenylistAnchors()
    if (isDenylisted(canonical, anchors.homedir, anchors.kbRepoRoot)) {
      sendError(
        res,
        400,
        'denylisted_root',
        'Path is a system directory or KB repo root and cannot be added as a work root for security reasons',
        input,
      )
      return
    }

    // Step 7 (run before the CAS loop so a probe failure short-
    // circuits without paying for repeated reads). The probe is
    // FS-state-dependent but does not modify the allow-list, so
    // running it once outside the CAS loop is safe — duplicate
    // detection (Step 6) still happens inside the loop where we have
    // a fresh setting snapshot.
    const metadata = probeWorkRoot(canonical, fs)
    if (!metadata) {
      sendError(
        res,
        400,
        'probe_failed',
        `FS case-sensitivity probe failed for ${canonical}. Cannot add as work root without metadata.`,
        input,
      )
      return
    }

    // Steps 6 + write under CAS retry.
    let attempt = 0
    while (attempt < CAS_MAX_RETRIES) {
      const current = readSettingWithRevision(fs)
      if (!current) {
        // Setting file does not exist yet — onboarding has not run.
        // Block the add: there is no baseline to attach the work
        // root to, and the wizard is the canonical place to seed it.
        sendError(
          res,
          400,
          'no_setting',
          'Settings file is not initialised; complete onboarding first',
          input,
        )
        return
      }

      const setting = current.setting
      const existingRoots = setting.additionalWorkRoots ?? []
      if (existingRoots.includes(canonical)) {
        sendError(res, 400, 'duplicate', 'Path is already in additionalWorkRoots', input)
        return
      }

      const next = {
        ...setting,
        additionalWorkRoots: [...existingRoots, canonical],
        workRootsMetadata: {
          ...(setting.workRootsMetadata ?? {}),
          [canonical]: metadata,
        },
      }

      try {
        writeSettingCas(fs, next, current.revision)
        res.status(200).json({
          addedPath: canonical,
          additionalWorkRoots: next.additionalWorkRoots,
        })
        return
      } catch (err) {
        if (err instanceof SettingConflictError) {
          await sleep(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)])
          attempt++
          continue
        }
        workRootsLog.error({ err }, '[work-roots] write failed')
        sendError(
          res,
          500,
          'write_error',
          err instanceof Error ? err.message : String(err),
          input,
        )
        return
      }
    }

    sendError(
      res,
      409,
      'setting_collision',
      'Another process is updating settings. Please retry.',
      input,
    )
  })

  // DELETE /api/work-roots
  router.delete('/', async (req, res) => {
    const input = req.body?.path
    if (typeof input !== 'string' || input.length === 0) {
      sendError(res, 400, 'invalid_path', 'Path must be a non-empty string', input)
      return
    }

    let attempt = 0
    while (attempt < CAS_MAX_RETRIES) {
      const current = readSettingWithRevision(fs)
      if (!current) {
        sendError(res, 404, 'not_found', 'Settings file is not initialised', input)
        return
      }
      const setting = current.setting
      const existingRoots = setting.additionalWorkRoots ?? []
      if (!existingRoots.includes(input)) {
        sendError(res, 404, 'not_found', 'Path is not in additionalWorkRoots', input)
        return
      }

      const existingMeta = setting.workRootsMetadata ?? {}
      const nextMeta: Record<string, (typeof existingMeta)[string]> = { ...existingMeta }
      delete nextMeta[input]

      const next = {
        ...setting,
        additionalWorkRoots: existingRoots.filter((p) => p !== input),
        workRootsMetadata: nextMeta,
      }

      try {
        writeSettingCas(fs, next, current.revision)
        res.status(200).json({
          removedPath: input,
          additionalWorkRoots: next.additionalWorkRoots,
        })
        return
      } catch (err) {
        if (err instanceof SettingConflictError) {
          await sleep(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)])
          attempt++
          continue
        }
        workRootsLog.error({ err }, '[work-roots] delete write failed')
        sendError(
          res,
          500,
          'write_error',
          err instanceof Error ? err.message : String(err),
          input,
        )
        return
      }
    }

    sendError(
      res,
      409,
      'setting_collision',
      'Another process is updating settings. Please retry.',
      input,
    )
  })

  return router
}

// --- internal helpers ---------------------------------------------------

function sendError(
  res: Response,
  status: number,
  error: string,
  message: string,
  path: unknown,
): void {
  res.status(status).json({
    error,
    message,
    path,
  })
}

/**
 * Async sleep used between CAS retries. Yields the event loop instead of
 * blocking it (the previous `Atomics.wait()` implementation stalled
 * unrelated traffic for 50/100/200 ms per conflicting write — CodeX
 * Attempt 1 MEDIUM 2). All `/api/work-roots` handlers are `async`, so
 * `await sleep(...)` is the natural fit.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
