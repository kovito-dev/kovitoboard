/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App menu-metadata routes — `PUT /api/apps/menu-order` and
 * `PATCH /api/apps/:appId/menu-label`.
 *
 * Phase 2 of the BL-2026-162 cycle (judgment doc v2.8 §4.6 / §4.7 /
 * §4.11 / §4.12 / §4.13 / §4.14). Both endpoints persist to
 * `AppManifest` only (the L12 cascade pin: `RecipeManifest` carries
 * no menu metadata field). `menu-order` is a closed-world batch
 * update (L13): the request body must cover every eligible app in
 * `app/<appId>/` with a contiguous `0..N-1` integer range, and the
 * server writes every manifest atomically with a temp-file +
 * rename-with-rollback dance. `menu-label` is a single-app update
 * with an explicit `null` reset path.
 *
 * Each successful write fires an `app_menu_changed` ws-event so the
 * renderer can refetch without polling, and emits an
 * `HttpRouteAuditEntry` (see `audit-logging.md` v1.2 §6.6) through the
 * server pino sink. Raw user-input strings (notably `userMenuLabel`)
 * are never recorded in the audit — only their lengths.
 *
 * @see docs/specs/http-api-contract.md v1.7.3 §6.3.9.A
 * @see docs/specs/app-directory-extension.md v1.6 §6.2 / §6.8
 * @see docs/specs/data-persistence.md v1.4 §6.8
 * @see docs/specs/audit-logging.md v1.2 §6.6
 * @see docs/specs/ws-event-contract.md v1.4 §6.1 / §7.6.2
 * @stable v0.2.1
 */
import { createHash } from 'crypto'
import { Router } from 'express'
import type { Logger } from 'pino'

import type { FileAccessLayer } from '../fs-layer'
import {
  acquireAppLock,
  AppLockWaitTimeoutError,
} from '../handlerDispatcher'
import type { AppManifest } from '../../shared/app-manifest-types'
import type { ServerToClientEvent } from '../../shared/ws-events'
import {
  getAppManifestPath,
  readAppManifest,
  scanAppManifests,
} from '../services/app-manifest'

/** Maximum length of a user-provided menu label string. */
export const MENU_LABEL_MAX_LENGTH = 80

/** Path parameter regex shared with `/api/apps/:appId/request-removal`. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

type BroadcastFn = (event: ServerToClientEvent) => void

interface CreateAppsRouterDeps {
  fs: FileAccessLayer
  projectRoot: string
  broadcast: BroadcastFn
  apiLogger: Logger
}

/**
 * Build the apps router. Mounted at `/api/apps` after the global
 * `verifyTokenAndOrigin` chain (see `src/server/index.ts`), so handlers
 * never need to re-verify auth.
 */
export function createAppsRouter(deps: CreateAppsRouterDeps): Router {
  const { fs, projectRoot, broadcast, apiLogger } = deps
  const router = Router()

  // -----------------------------------------------------------------
  // PUT /api/apps/menu-order — closed-world batch order update.
  // -----------------------------------------------------------------
  router.put('/menu-order', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawOrder = body.order
    const rawSnapshot = body.snapshotVersion

    if (!Array.isArray(rawOrder)) {
      emitHttpRouteAudit(apiLogger, {
        method: 'PUT',
        path: '/api/apps/menu-order',
        pathParams: {},
        status: 400,
        audit: { action: 'menu-order-update' },
        errorCode: 'InvalidMenuOrder',
      })
      res.status(400).json({ error: 'InvalidMenuOrder' })
      return
    }

    // Validate every entry shape before touching disk so a malformed
    // payload cannot leave the lock acquired for partial work.
    const requestedAppIds = new Set<string>()
    const orderMap = new Map<string, number>()
    for (const entry of rawOrder) {
      if (!isPlainObject(entry)) {
        respondMenuOrderError(res, apiLogger, 'InvalidMenuOrder')
        return
      }
      const appId = entry.appId
      const menuOrder = entry.menuOrder
      if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
        respondMenuOrderError(res, apiLogger, 'InvalidMenuOrder')
        return
      }
      if (
        typeof menuOrder !== 'number' ||
        !Number.isInteger(menuOrder) ||
        menuOrder < 0
      ) {
        respondMenuOrderError(res, apiLogger, 'InvalidMenuOrder')
        return
      }
      if (requestedAppIds.has(appId)) {
        respondMenuOrderError(res, apiLogger, 'MenuOrderDuplicateAppId')
        return
      }
      requestedAppIds.add(appId)
      orderMap.set(appId, menuOrder)
    }

    if (rawSnapshot !== undefined && typeof rawSnapshot !== 'string') {
      respondMenuOrderError(res, apiLogger, 'InvalidMenuOrder')
      return
    }
    const requestedSnapshot =
      typeof rawSnapshot === 'string' ? rawSnapshot : undefined

    // ---------------------------------------------------------------
    // Lock-then-read ordering (codex attempt 1 Finding 1 fix):
    //
    // Earlier versions of this handler scanned the AppManifest set
    // and computed the drift snapshot *before* acquiring per-app
    // locks. Between the unlocked read and the locked write, a
    // concurrent `PATCH /menu-label`, bundled `enable` / `disable`,
    // or handler dispatch could mutate one of the manifests — the
    // batch handler would then write back a stale in-memory copy
    // (clobbering the newer fields) and the drift detector would
    // silently miss the change.
    //
    // The fix is to take every lock first (using only the appId set
    // that the client supplied, in deterministic sorted order to
    // avoid dead-locks against any other multi-lock path), and only
    // then scan / validate / write. The scan and the drift snapshot
    // both observe the locked filesystem snapshot, so neither the
    // coverage check nor the snapshot drift detector can race with
    // the per-app writers anymore. If a concurrent path created /
    // removed a manifest between the request leaving the renderer
    // and our lock acquisition, that surfaces as a 400
    // `MenuOrderCoverageMismatch` from the post-lock validation —
    // exactly the same contract the renderer already handles.
    //
    // Disk-mutating section. Wrap in a try/catch so unexpected
    // failures land on a structured 500 instead of Express's default
    // HTML error handler.
    // ---------------------------------------------------------------
    const sortedAppIds = [...requestedAppIds].sort()
    const releases: Array<() => void> = []
    // Captured before the lock is released so the post-commit
    // broadcast + response (which must not run while holding the
    // app lock — broadcast latency would extend the locked region)
    // can still report the new state. Stays `null` on every error
    // path inside the try block; the post-lock code uses that as
    // the "response was already sent above" sentinel.
    let postCommit: { newSnapshot: string; updatedCount: number } | null = null
    try {
      for (const appId of sortedAppIds) {
        try {
          releases.push(await acquireAppLock(appId))
        } catch (lockErr) {
          if (lockErr instanceof AppLockWaitTimeoutError) {
            apiLogger.warn(
              { err: lockErr, appId },
              'PUT /api/apps/menu-order rejected (app lock timeout)',
            )
            emitHttpRouteAudit(apiLogger, {
              method: 'PUT',
              path: '/api/apps/menu-order',
              pathParams: {},
              status: 503,
              audit: { action: 'menu-order-update' },
              errorCode: 'AppLockTimeout',
            })
            res.status(503).json({ error: 'AppLockTimeout' })
            return
          }
          throw lockErr
        }
      }

      // Scan happens UNDER the locks: a concurrent per-app writer
      // can no longer mutate any of the manifests we are about to
      // copy / rewrite. The eligible set we observe here is the
      // single source of truth for coverage and snapshot validation.
      let manifests: AppManifest[]
      try {
        manifests = scanAppManifests(fs, projectRoot)
      } catch (err) {
        apiLogger.error(
          { err },
          'PUT /api/apps/menu-order: scanAppManifests threw',
        )
        emitHttpRouteAudit(apiLogger, {
          method: 'PUT',
          path: '/api/apps/menu-order',
          pathParams: {},
          status: 500,
          audit: { action: 'menu-order-update' },
          errorCode: 'MenuOrderAtomicWriteFailed',
        })
        res.status(500).json({ error: 'MenuOrderAtomicWriteFailed' })
        return
      }

      // Eligible set R is the appIds with a readable AppManifest.
      const eligibleAppIds = new Set(manifests.map((m) => m.appId))
      if (eligibleAppIds.size !== requestedAppIds.size) {
        respondMenuOrderError(res, apiLogger, 'MenuOrderCoverageMismatch')
        return
      }
      for (const appId of requestedAppIds) {
        if (!eligibleAppIds.has(appId)) {
          respondMenuOrderError(res, apiLogger, 'MenuOrderCoverageMismatch')
          return
        }
      }
      for (const appId of eligibleAppIds) {
        if (!requestedAppIds.has(appId)) {
          respondMenuOrderError(res, apiLogger, 'MenuOrderCoverageMismatch')
          return
        }
      }

      // Contiguous 0..(N-1) check on menuOrder values.
      const N = manifests.length
      const seenValues = new Set<number>()
      for (const value of orderMap.values()) {
        if (value >= N) {
          respondMenuOrderError(res, apiLogger, 'MenuOrderNonContiguous')
          return
        }
        if (seenValues.has(value)) {
          respondMenuOrderError(res, apiLogger, 'MenuOrderNonContiguous')
          return
        }
        seenValues.add(value)
      }
      // The pair (size N, all values 0..(N-1) unique) is equivalent
      // to "exact coverage of 0..(N-1) with no gaps".

      // Optional snapshot drift detection. Now keyed on the locked
      // snapshot so a stale view from before the lock can no longer
      // slip through.
      const currentSnapshot = computeMenuOrderSnapshot(manifests)
      if (
        requestedSnapshot !== undefined &&
        requestedSnapshot !== currentSnapshot
      ) {
        emitHttpRouteAudit(apiLogger, {
          method: 'PUT',
          path: '/api/apps/menu-order',
          pathParams: {},
          status: 409,
          audit: {
            action: 'menu-order-update',
            snapshotProvided: true,
          },
          errorCode: 'MenuOrderSnapshotDrift',
        })
        res.status(409).json({ error: 'MenuOrderSnapshotDrift' })
        return
      }

      // Atomic batch write. There is no POSIX primitive for "rename
      // many files atomically", so we fall back to (a) snapshot the
      // old bytes per file, (b) issue every write sequentially, (c)
      // on the first failure rewrite the already-committed files
      // back to their pre-snapshot bytes. The rollback path is
      // best-effort because a disk that just failed mid-write may
      // keep failing — when that happens we log loudly so the
      // operator can investigate.
      //
      // Every manifest write happens while the corresponding app's
      // lock is still held (acquired above), so a concurrent
      // bundled enable/disable / handler dispatch cannot observe a
      // half-applied batch.
      const previousBytes = new Map<string, string>()
      const writtenAppIds: string[] = []
      try {
        for (const manifest of manifests) {
          const path = getAppManifestPath(projectRoot, manifest.appId)
          previousBytes.set(path, fs.readFileSync(path, 'utf-8'))
        }
        for (const manifest of manifests) {
          const desired = orderMap.get(manifest.appId)
          if (desired === undefined) {
            // Defensive — exact coverage was already enforced above.
            throw new Error(
              `menu-order: ${manifest.appId} missing from validated order`,
            )
          }
          const updated: AppManifest = { ...manifest, menuOrder: desired }
          const path = getAppManifestPath(projectRoot, manifest.appId)
          fs.writeFileAtomic(path, JSON.stringify(updated, null, 2) + '\n')
          writtenAppIds.push(manifest.appId)
        }
      } catch (writeErr) {
        // Rollback every successful write to the pre-snapshot bytes.
        for (const appId of writtenAppIds) {
          const path = getAppManifestPath(projectRoot, appId)
          const prev = previousBytes.get(path)
          if (prev === undefined) continue
          try {
            fs.writeFileAtomic(path, prev)
          } catch (rollbackErr) {
            apiLogger.error(
              { err: rollbackErr, appId, path },
              'PUT /api/apps/menu-order rollback failed; manifest may be in updated state',
            )
          }
        }
        apiLogger.error(
          { err: writeErr },
          'PUT /api/apps/menu-order atomic batch failed; rolled back committed writes',
        )
        emitHttpRouteAudit(apiLogger, {
          method: 'PUT',
          path: '/api/apps/menu-order',
          pathParams: {},
          status: 500,
          audit: { action: 'menu-order-update' },
          errorCode: 'MenuOrderAtomicWriteFailed',
        })
        res.status(500).json({ error: 'MenuOrderAtomicWriteFailed' })
        return
      }

      // Still inside the lock-protected section. Build the post-write
      // manifest set, compute the new snapshot, and emit the 200
      // audit record before we release the locks. The broadcast +
      // response will happen after `finally` runs.
      const newManifests: AppManifest[] = manifests.map((m) => ({
        ...m,
        menuOrder: orderMap.get(m.appId),
      }))
      const newSnapshot = computeMenuOrderSnapshot(newManifests)
      emitHttpRouteAudit(apiLogger, {
        method: 'PUT',
        path: '/api/apps/menu-order',
        pathParams: {},
        status: 200,
        audit: {
          action: 'menu-order-update',
          updatedCount: manifests.length,
          snapshotProvided: requestedSnapshot !== undefined,
        },
      })
      postCommit = { newSnapshot, updatedCount: manifests.length }
    } finally {
      // Always release in reverse acquisition order. Failures here
      // can only happen if the lock has already been released; we
      // swallow them silently because every path that reaches this
      // finally has either succeeded or already responded.
      for (let i = releases.length - 1; i >= 0; i--) {
        try {
          releases[i]()
        } catch (releaseErr) {
          apiLogger.warn(
            { err: releaseErr },
            'PUT /api/apps/menu-order: release lock failed',
          )
        }
      }
    }

    // Reachable only on the success path: every error path inside
    // the try block returned without setting `postCommit`. We could
    // not run the broadcast + response inside the locked section
    // because broadcast latency would extend the time the per-app
    // locks are held.
    if (postCommit === null) return

    try {
      broadcast({
        type: 'app_menu_changed',
        payload: { event: 'menu-order-update', ts: Date.now() },
      })
    } catch (broadcastErr) {
      apiLogger.warn(
        { err: broadcastErr },
        'app_menu_changed broadcast failed (non-fatal post-commit)',
      )
    }

    res.json({
      updated: postCommit.updatedCount,
      snapshotVersion: postCommit.newSnapshot,
    })
  })

  // -----------------------------------------------------------------
  // PATCH /api/apps/:appId/menu-label — single-app override / reset.
  // -----------------------------------------------------------------
  router.patch('/:appId/menu-label', async (req, res) => {
    const appId = req.params.appId
    if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
      emitHttpRouteAudit(apiLogger, {
        method: 'PATCH',
        path: '/api/apps/:appId/menu-label',
        pathParams: { appId: String(appId ?? '') },
        status: 400,
        audit: { action: 'menu-label-update' },
        errorCode: 'InvalidAppId',
      })
      res.status(400).json({ error: 'InvalidAppId' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const rawLabel = body.userMenuLabel

    let userMenuLabel: string | null
    if (rawLabel === null) {
      userMenuLabel = null
    } else if (typeof rawLabel === 'string') {
      if (rawLabel.length === 0) {
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 400,
          audit: {
            appId,
            action: 'menu-label-update',
            labelLength: 0,
          },
          errorCode: 'MenuLabelEmpty',
        })
        res.status(400).json({ error: 'MenuLabelEmpty' })
        return
      }
      if (rawLabel.length > MENU_LABEL_MAX_LENGTH) {
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 400,
          audit: {
            appId,
            action: 'menu-label-update',
            labelLength: rawLabel.length,
          },
          errorCode: 'MenuLabelTooLong',
        })
        res.status(400).json({ error: 'MenuLabelTooLong' })
        return
      }
      userMenuLabel = rawLabel
    } else {
      emitHttpRouteAudit(apiLogger, {
        method: 'PATCH',
        path: '/api/apps/:appId/menu-label',
        pathParams: { appId },
        status: 400,
        audit: { appId, action: 'menu-label-update' },
        errorCode: 'InvalidMenuLabel',
      })
      res.status(400).json({ error: 'InvalidMenuLabel' })
      return
    }

    // Acquire the app lock before reading the manifest so a
    // concurrent bundled enable / handler dispatch cannot leave us
    // with a stale read.
    let release: () => void
    try {
      release = await acquireAppLock(appId)
    } catch (lockErr) {
      if (lockErr instanceof AppLockWaitTimeoutError) {
        apiLogger.warn(
          { err: lockErr, appId },
          'PATCH /api/apps/:appId/menu-label rejected (app lock timeout)',
        )
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 503,
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'AppLockTimeout',
        })
        res.status(503).json({ error: 'AppLockTimeout' })
        return
      }
      apiLogger.error(
        { err: lockErr, appId },
        'PATCH /api/apps/:appId/menu-label: acquireAppLock unexpected',
      )
      emitHttpRouteAudit(apiLogger, {
        method: 'PATCH',
        path: '/api/apps/:appId/menu-label',
        pathParams: { appId },
        status: 500,
        audit: { appId, action: 'menu-label-update' },
        errorCode: 'MenuLabelAtomicWriteFailed',
      })
      res.status(500).json({ error: 'MenuLabelAtomicWriteFailed' })
      return
    }

    // Captured before the lock is released so the post-commit
    // broadcast + 200 response can read the committed values back.
    // Stays `null` on every error path within the try block (which
    // sends its own response and returns), so we use that as the
    // "response already sent above" sentinel after `finally` runs.
    // Mirrors the PUT /api/apps/menu-order structure introduced in
    // codex attempt 1 Finding 1 fix — both endpoints now keep the
    // app lock as short as possible by moving the post-commit
    // broadcast / response outside the locked region (codex attempt
    // 2 Finding 2: keeping the lock during broadcast can turn a
    // slow ws fan-out into AppLockTimeout for the same app).
    let postCommit: { userMenuLabel: string | null } | null = null
    try {
      const manifestPath = getAppManifestPath(projectRoot, appId)
      // The existence check is what distinguishes 404 AppNotFound
      // from 500 AppManifestUnreadable: a missing file is a
      // legitimate "no such app" signal, while a present-but-broken
      // file is server-side state that the user must repair.
      if (!fs.existsSync(manifestPath)) {
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 404,
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'AppNotFound',
        })
        res.status(404).json({ error: 'AppNotFound' })
        return
      }

      // Codex attempt 1 Finding 2 fix: route the read through the
      // canonical `readAppManifest()` so this endpoint agrees with
      // `services/app-manifest.ts` and `scanAppManifests` on what
      // counts as a readable manifest. `readAppManifest` returns
      // null for read failure / JSON parse failure / schema
      // mismatch alike and emits a structured warn line in each
      // case, so all three are collapsed into one 500
      // AppManifestUnreadable surface here.
      const manifest = readAppManifest(fs, projectRoot, appId)
      if (manifest === null) {
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 500,
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'AppManifestUnreadable',
        })
        res.status(500).json({ error: 'AppManifestUnreadable' })
        return
      }

      const updated: AppManifest = { ...manifest, userMenuLabel }
      try {
        fs.writeFileAtomic(
          manifestPath,
          JSON.stringify(updated, null, 2) + '\n',
        )
      } catch (writeErr) {
        apiLogger.error(
          { err: writeErr, appId, path: manifestPath },
          'PATCH /api/apps/:appId/menu-label: atomic write failed',
        )
        emitHttpRouteAudit(apiLogger, {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          status: 500,
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'MenuLabelAtomicWriteFailed',
        })
        res.status(500).json({ error: 'MenuLabelAtomicWriteFailed' })
        return
      }

      // Still inside the lock-protected section. Emit the 200
      // audit record and capture the post-commit payload before
      // releasing the lock — the broadcast + response will run
      // after `finally` so the lock hold time stays tight.
      emitHttpRouteAudit(apiLogger, {
        method: 'PATCH',
        path: '/api/apps/:appId/menu-label',
        pathParams: { appId },
        status: 200,
        audit: {
          appId,
          action: 'menu-label-update',
          // Log the length of the user input but never the value.
          labelLength: userMenuLabel === null ? null : userMenuLabel.length,
        },
      })
      postCommit = { userMenuLabel }
    } finally {
      try {
        release()
      } catch (releaseErr) {
        apiLogger.warn(
          { err: releaseErr, appId },
          'PATCH /api/apps/:appId/menu-label: release lock failed',
        )
      }
    }

    // Reachable only on the success path: every error path inside
    // the try block returned without setting `postCommit`. We could
    // not run the broadcast + response inside the locked section
    // because broadcast latency would extend the time the per-app
    // lock is held (codex attempt 2 Finding 2 — symmetric with
    // PUT /api/apps/menu-order).
    if (postCommit === null) return

    try {
      broadcast({
        type: 'app_menu_changed',
        payload: {
          event: 'menu-label-update',
          appId,
          ts: Date.now(),
        },
      })
    } catch (broadcastErr) {
      apiLogger.warn(
        { err: broadcastErr, appId },
        'app_menu_changed broadcast failed (non-fatal post-commit)',
      )
    }

    res.json({ appId, userMenuLabel: postCommit.userMenuLabel })
  })

  return router
}

// =====================================================================
// Helpers
// =====================================================================

function respondMenuOrderError(
  res: import('express').Response,
  apiLogger: Logger,
  errorCode:
    | 'InvalidMenuOrder'
    | 'MenuOrderDuplicateAppId'
    | 'MenuOrderCoverageMismatch'
    | 'MenuOrderNonContiguous',
): void {
  emitHttpRouteAudit(apiLogger, {
    method: 'PUT',
    path: '/api/apps/menu-order',
    pathParams: {},
    status: 400,
    audit: { action: 'menu-order-update' },
    errorCode,
  })
  res.status(400).json({ error: errorCode })
}

/**
 * Compute a stable snapshot version string for a list of manifests,
 * keyed on `(appId → menuOrder)` pairs. Used by the optional drift
 * detection path of `PUT /api/apps/menu-order`.
 *
 * The snapshot is intentionally derived purely from the menu order
 * tuple (not the full manifest content) so an unrelated manifest
 * mutation (display name edit, source bump on bundled enable) does
 * not look like drift to a queued reorder.
 */
function computeMenuOrderSnapshot(manifests: AppManifest[]): string {
  const sorted = manifests
    .map((m) => `${m.appId}:${m.menuOrder ?? ''}`)
    .sort()
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Emit an `HttpRouteAuditEntry` (audit-logging.md v1.2 §6.6) through
 * the pino sink already attached to `apiLogger`. The `kind:
 * 'http-route'` discriminator lets readers filter route audit lines
 * apart from the regular server log records.
 *
 * Raw user-input strings (notably `userMenuLabel`) are never passed
 * to this helper — the audit payload only carries metadata
 * (`labelLength` etc.).
 */
interface HttpRouteAuditPayload {
  recipeId?: string
  appId?: string
  action?: 'enable' | 'disable' | 'menu-order-update' | 'menu-label-update'
  source?: 'bundled' | 'sample' | 'import' | 'url'
  updatedCount?: number
  snapshotProvided?: boolean
  labelLength?: number | null
}

function emitHttpRouteAudit(
  apiLogger: Logger,
  record: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    pathParams: Record<string, string>
    status: number
    audit: HttpRouteAuditPayload
    errorCode?: string
  },
): void {
  const { errorCode, ...rest } = record
  const audit: HttpRouteAuditPayload & { errorCode?: string } = { ...rest.audit }
  if (errorCode !== undefined) {
    audit.errorCode = errorCode
  }
  apiLogger.info(
    {
      kind: 'http-route',
      method: rest.method,
      path: rest.path,
      pathParams: rest.pathParams,
      status: rest.status,
      audit,
    },
    `${rest.method} ${rest.path} ${rest.status}`,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Re-export internal helpers for tests that want to exercise the
// snapshot computation independently of the HTTP wiring.
export const __test_only__ = {
  computeMenuOrderSnapshot,
}
