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
 * Resource limits on `additionalWorkRoots[]` (CodeX PR #38 Attempt 4
 * MED 2 — unbounded allow-list amplifies every guarded spawn/tmux
 * path into O(n) disk work via `ensureWorkRootMetadata()` /
 * `validateCwd()`. Without a ceiling, a caller can grow the array
 * indefinitely and turn each future session-start into a slow
 * fan-out across stale entries — a durable server-side DoS vector).
 *
 * - `MAX_WORK_ROOTS`: ceiling on `additionalWorkRoots.length`. 32 is
 *   well above any realistic individual-developer workload (typical
 *   KB users have 1–5 active project trees) while keeping the
 *   per-spawn fan-out bounded.
 * - `MAX_WORK_ROOT_PATH_LENGTH`: per-entry path length cap. 4096 matches
 *   Linux `PATH_MAX`; Windows long-path support (32k) is out of scope
 *   here because the cwd allow-list itself is only used for `claude`
 *   spawn cwd and tmux `-c`, both of which the OS clamps anyway.
 */
const MAX_WORK_ROOTS = 32
const MAX_WORK_ROOT_PATH_LENGTH = 4096

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

    // Step 0: per-entry path-length cap. We check this before any I/O
    // so an oversized path is rejected without touching the disk —
    // half of the allow-list resource-exhaustion mitigation (CodeX
    // PR #38 Attempt 4 MED 2). The complementary count cap is
    // enforced inside the CAS loop after we have a fresh setting
    // snapshot.
    if (input.length > MAX_WORK_ROOT_PATH_LENGTH) {
      sendError(
        res,
        400,
        'path_too_long',
        `Path exceeds the per-entry length cap (${MAX_WORK_ROOT_PATH_LENGTH} chars)`,
        input,
      )
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

    // Step 6 precondition: confirm `setting.json` exists *before*
    // running the probe. The probe writes a sentinel file into the
    // user-supplied directory to detect FS case sensitivity, so
    // running it for a request that will subsequently return
    // `no_setting` would leak a filesystem side effect on an
    // attacker-controlled path before the endpoint has even
    // confirmed that allow-list mutation is currently legal (CodeX
    // PR #38 Attempt 4 MED 1).
    const precheck = readSettingWithRevision(fs)
    if (!precheck) {
      sendError(
        res,
        400,
        'no_setting',
        'Settings file is not initialised; complete onboarding first',
        input,
      )
      return
    }
    // Resource-exhaustion ceiling on `additionalWorkRoots[]`. We
    // check the current count outside the CAS loop so an oversized
    // allow-list short-circuits before the probe is run. The
    // canonical, race-tolerant check still happens inside the loop
    // below — this one is best-effort but covers the common case.
    if ((precheck.setting.additionalWorkRoots ?? []).length >= MAX_WORK_ROOTS) {
      sendError(
        res,
        400,
        'too_many_roots',
        `Cannot add more than ${MAX_WORK_ROOTS} additional work roots`,
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
        // Setting file vanished between the precheck and the CAS
        // loop (e.g. a `setting.json` deletion concurrent with our
        // request). Treat as `no_setting` rather than crashing.
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
      // Race-tolerant count ceiling: re-check inside the lock so two
      // concurrent POSTs cannot both squeeze past `MAX_WORK_ROOTS - 1`.
      if (existingRoots.length >= MAX_WORK_ROOTS) {
        sendError(
          res,
          400,
          'too_many_roots',
          `Cannot add more than ${MAX_WORK_ROOTS} additional work roots`,
          input,
        )
        return
      }
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
        // Log the raw exception (which can contain filesystem paths,
        // lock-library platform details, etc.) but surface only a
        // fixed client-safe message to the renderer. The WorkRootsPage
        // displays `body.message` verbatim, so leaking `err.message`
        // would surface absolute paths / internal state to the UI
        // (CodeX PR #38 Attempt 7 LOW 3).
        workRootsLog.error({ err }, '[work-roots] write failed')
        sendError(
          res,
          500,
          'write_error',
          'Failed to update work roots. See server logs for details.',
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

    // Canonicalise the delete input so it matches the form stored by
    // POST (`realpathSync`). Without this step a trailing slash, a
    // symlink form, or a case-variant on a case-insensitive FS would
    // miss the stored entry and silently leave the work root active
    // (CodeX PR #38 Attempt 4 LOW 3).
    //
    // If `realpath` fails (the underlying directory is gone since
    // the entry was added) we fall back to the verbatim input so
    // stale entries can still be revoked.
    let lookupKey = input
    try {
      lookupKey = fs.realpathSync(input)
    } catch {
      lookupKey = input
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
      // Try the canonicalised form first, then fall back to the
      // verbatim input. The fallback covers two edge cases:
      //   - the lookup `realpath` failed above (stale entry); the
      //     stored value may match the user's exact input
      //   - the entry pre-dates the POST canonicalisation contract
      const targetKey = existingRoots.includes(lookupKey)
        ? lookupKey
        : existingRoots.includes(input)
          ? input
          : null
      if (targetKey === null) {
        sendError(res, 404, 'not_found', 'Path is not in additionalWorkRoots', input)
        return
      }

      const existingMeta = setting.workRootsMetadata ?? {}
      const nextMeta: Record<string, (typeof existingMeta)[string]> = { ...existingMeta }
      delete nextMeta[targetKey]

      const next = {
        ...setting,
        additionalWorkRoots: existingRoots.filter((p) => p !== targetKey),
        workRootsMetadata: nextMeta,
      }

      try {
        writeSettingCas(fs, next, current.revision)
        res.status(200).json({
          // Report the actual stored entry we removed (post-realpath),
          // not the verbatim caller input — the renderer relies on
          // this to refresh its list view (CodeX PR #38 Attempt 4
          // LOW 3 follow-through).
          removedPath: targetKey,
          additionalWorkRoots: next.additionalWorkRoots,
        })
        return
      } catch (err) {
        if (err instanceof SettingConflictError) {
          await sleep(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)])
          attempt++
          continue
        }
        // Same client-safe envelope as the POST path. Internal
        // exception details stay in the server log only (CodeX PR
        // #38 Attempt 7 LOW 3).
        workRootsLog.error({ err }, '[work-roots] delete write failed')
        sendError(
          res,
          500,
          'write_error',
          'Failed to update work roots. See server logs for details.',
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
