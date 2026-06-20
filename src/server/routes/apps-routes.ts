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

import { resolve as resolvePath } from 'path'

import type { FileAccessLayer } from '../fs-layer'
import {
  acquireAppLock,
  AppLockWaitTimeoutError,
} from '../handlerDispatcher'
import { isWithin } from '../pathResolver'
import type { AppManifest } from '../../shared/app-manifest-types'
import type { ServerToClientEvent } from '../../shared/ws-events'
import {
  getAppManifestPath,
  readAppManifestAtPath,
} from '../services/app-manifest'

/** Maximum length of a user-provided menu label string. */
export const MENU_LABEL_MAX_LENGTH = 80

// Spec note (attempt 8): the previously-defined
// MENU_ORDER_MAX_ENTRIES = 1000 cap is removed. The DoS surface
// it guarded (lock amplification on a flood of fake appIds) is
// already bounded by Express's default JSON body-size limit
// (`app.use(express.json())` with no `limit` option, 100 KB
// default) — a worst-case order entry is ~55 bytes serialised,
// so the body parser already rejects payloads above ~1900
// entries before any handler code runs. Removing the application
// -level cap eliminates the spec drift (the wire contract
// described an open `0..count-1` closed-world batch, the cap
// added an undocumented rejection path) without re-exposing
// a meaningful new DoS surface.

/** Path parameter regex shared with `/api/apps/:appId/request-removal`. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

type BroadcastFn = (event: ServerToClientEvent) => void

interface CreateAppsRouterDeps {
  fs: FileAccessLayer
  projectRoot: string
  broadcast: BroadcastFn
  apiLogger: Logger
  /**
   * Optional case-A backfill pre-scan
   * (`app-directory-extension.md` v1.8 §6.9.7 option A). Invoked at the top
   * of `PUT /api/apps/menu-order`, before the eligible scan, so a
   * manifest-less self-made app is backfilled (and therefore observable
   * by `scanAppManifests`) even when the client PUTs without a prior
   * `/menu-entries` GET. Wired in `index.ts` to {@link runMenuBackfillScan}.
   * Omitted in unit tests that drive the batch directly with
   * pre-written manifests.
   */
  runBackfillScan?: () => void
}

/**
 * Build the apps router. Mounted at `/api/apps` after the global
 * `verifyTokenAndOrigin` chain (see `src/server/index.ts`), so handlers
 * never need to re-verify auth.
 */
export function createAppsRouter(deps: CreateAppsRouterDeps): Router {
  const { fs, projectRoot, broadcast, apiLogger, runBackfillScan } = deps
  const router = Router()

  // -----------------------------------------------------------------
  // PUT /api/apps/menu-order — closed-world batch order update.
  // -----------------------------------------------------------------
  router.put('/menu-order', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawOrder = body.order
    const rawSnapshot = body.snapshotVersion

    if (!Array.isArray(rawOrder)) {
      respondAndAudit(res, apiLogger, {
        status: 400,
        body: { error: 'InvalidMenuOrder' },
        audit: {
          method: 'PUT',
          path: '/api/apps/menu-order',
          pathParams: {},
          audit: { action: 'menu-order-update' },
          errorCode: 'InvalidMenuOrder',
        },
      })
      return
    }

    // Validate every entry shape before touching disk so a malformed
    // payload cannot leave the lock acquired for partial work.
    // (The previously-defined `MENU_ORDER_MAX_ENTRIES` cap is now
    // delegated to the Express body-size limit — see the comment
    // block at the top of this file for the derivation.)
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

    // Case-A backfill pre-scan (app-directory-extension.md v1.8
    // §6.9.7 option A): run the menu-extraction backfill BEFORE the
    // eligible scan so a manifest-less self-made app is written to
    // disk (and therefore observable by `scanAppManifests` below)
    // even when the client PUTs without a prior `/menu-entries` GET.
    // Best-effort: the backfill is internally try/caught per app
    // (§6.9.5), so a write failure leaves that app ineligible rather
    // than throwing here. Any residual size-`N` observation drift
    // between this pre-scan and the locked eligible scan is the
    // benign drift the spec accepts (§6.9.7 F5): the client refetches
    // `/menu-entries` and re-PUTs on a `MenuOrderCoverageMismatch`.
    if (runBackfillScan) {
      try {
        runBackfillScan()
      } catch (err) {
        apiLogger.warn(
          { err },
          'PUT /api/apps/menu-order: case-A backfill pre-scan failed; continuing with current eligible set',
        )
      }
    }

    // ---------------------------------------------------------------
    // Lock-then-read ordering (Spec note (attempt 1)):
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
    let postCommit:
      | { newSnapshot: string; updatedCount: number; broadcast: boolean }
      | null = null
    // Spec note (attempt 3): wrap the lock-protected
    // section in an outer try/catch so an unexpected throw from
    // anywhere inside (notably a non-timeout rejection from
    // `acquireAppLock` whose contract only models the wait-timeout
    // path) lands on a structured 500 JSON envelope instead of
    // Express's default HTML error handler. The lock-release
    // `finally` stays attached to the inner try so locks are
    // released along every path, including a thrown
    // unexpected error.
    try {
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
            respondAndAudit(res, apiLogger, {
              status: 503,
              body: { error: 'AppLockTimeout' },
              audit: {
                method: 'PUT',
                path: '/api/apps/menu-order',
                pathParams: {},
                audit: { action: 'menu-order-update' },
                errorCode: 'AppLockTimeout',
              },
            })
            return
          }
          throw lockErr
        }
      }

      // Scan happens UNDER the locks: a concurrent per-app writer
      // can no longer mutate any of the manifests we are about to
      // copy / rewrite. The eligible set we observe here is the
      // single source of truth for coverage and snapshot validation.
      //
      // Spec note (attempt 8): the scan itself routes every
      // read through the boundary check (`resolveManifestPathInAppRoot`)
      // and reads from the canonical path, so a planted
      // `app/<appId>` symlink can no longer make the scan open a
      // file outside <projectRoot>/app/. (attempt 7) boundary check
      // protected the write path only; this extends the gate to the
      // read path as well. Spec SSOT: recipe-system v1.11 §10.9.3
      // step 2.5 + security-threat-model.md path-boundary layer.
      const manifests: AppManifest[] = []
      const canonicalManifestPaths = new Map<string, string>()
      // Spec note (attempt 12) + Finding 3 fix: verify the
      // `app/` root itself BEFORE any readdirSync. Without this
      // gate an `app -> /elsewhere` symlink would let the scan
      // enumerate the foreign directory before per-entry checks
      // got a chance to run; the per-entry check would still
      // reject each manifest, but the readdirSync I/O against the
      // foreign location is itself a violation of the
      // `<projectRoot>/app/**` boundary. The helper also returns a
      // distinct error class for root-level failures so they
      // surface as 500 rather than being downgraded to a per-entry
      // skip (Finding 3).
      const rootCheck = verifyAppRoot(fs, projectRoot)
      if ('error' in rootCheck) {
        apiLogger.warn(
          { kind: rootCheck.error },
          'PUT /api/apps/menu-order: app root failed boundary check',
        )
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuOrderAtomicWriteFailed' },
          audit: {
            method: 'PUT',
            path: '/api/apps/menu-order',
            pathParams: {},
            audit: { action: 'menu-order-update' },
            errorCode: 'MenuOrderAtomicWriteFailed',
          },
        })
        return
      }
      const appRootDir = rootCheck.appBoundary
      let appDirEntries: string[]
      try {
        appDirEntries = fs.existsSync(appRootDir)
          ? fs.readdirSync(appRootDir)
          : []
      } catch (err) {
        apiLogger.error(
          { err },
          'PUT /api/apps/menu-order: readdir on app root failed',
        )
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuOrderAtomicWriteFailed' },
          audit: {
            method: 'PUT',
            path: '/api/apps/menu-order',
            pathParams: {},
            audit: { action: 'menu-order-update' },
            errorCode: 'MenuOrderAtomicWriteFailed',
          },
        })
        return
      }
      for (const entry of appDirEntries) {
        const pathCheck = resolveManifestPathInAppRoot(
          fs,
          projectRoot,
          entry,
        )
        if ('error' in pathCheck) {
          if (pathCheck.error === 'not-found') {
            // Directory exists but the entry has no manifest. Skip;
            // it is not eligible (matches the previous
            // `scanAppManifests` semantics).
            continue
          }
          if (pathCheck.error === 'resolve-failed') {
            // Spec note (attempt 10): a transient
            // realpathSync failure (broken symlink chain, ELOOP,
            // missing intermediate component, etc.) on one
            // directory entry must NOT take down the entire
            // closed-world batch for every other app. The spec
            // defines the eligible set as "apps with a readable
            // AppManifest", so a structurally unreadable entry
            // is treated the same way `scanAppManifests` already
            // treats parse-fail manifests: skipped from the
            // eligible set. Confirmed `escaped` path-boundary
            // violations stay fail-closed below — only that
            // class signals an active attempt to redirect a
            // write outside <projectRoot>/app/.
            apiLogger.warn(
              { appId: entry, kind: pathCheck.error },
              'PUT /api/apps/menu-order: manifest path resolve failed; treating as ineligible',
            )
            continue
          }
          // `escaped` only: the boundary check confirmed the
          // symlink resolves outside the app root, which is the
          // active "attempt to redirect a write" signal. Fail
          // closed.
          apiLogger.warn(
            { appId: entry, kind: pathCheck.error },
            'PUT /api/apps/menu-order: manifest path failed boundary check',
          )
          respondAndAudit(res, apiLogger, {
            status: 500,
            body: { error: 'MenuOrderAtomicWriteFailed' },
            audit: {
              method: 'PUT',
              path: '/api/apps/menu-order',
              pathParams: {},
              audit: { action: 'menu-order-update' },
              errorCode: 'MenuOrderAtomicWriteFailed',
            },
          })
          return
        }
        // Read from the canonical path the boundary check approved.
        const manifest = readAppManifestAtPath(fs, pathCheck.canonical, entry)
        if (manifest === null) continue
        // Spec note (attempt 9): refuse manifests whose
        // internal `appId` does not match the directory name.
        // Without this check, a corrupt manifest at
        // `app/alpha/manifest.json` carrying `appId: "beta"` would
        // make the batch acquire the `beta` lock while writing
        // through the canonical path that resolves under `alpha`,
        // reintroducing the cross-app race the per-app locks are
        // supposed to prevent. Skipping it (rather than returning
        // 500) matches the existing scan-skip semantics for
        // missing / parse-fail manifests: the entry simply does
        // not appear in the eligible set, which makes the request
        // either fail closed with `MenuOrderCoverageMismatch` or
        // succeed against only the well-formed manifests.
        if (manifest.appId !== entry) {
          apiLogger.warn(
            {
              directory: entry,
              manifestAppId: manifest.appId,
              path: pathCheck.canonical,
            },
            'PUT /api/apps/menu-order: manifest.appId does not match directory name; treating as ineligible',
          )
          continue
        }
        // Spec note (attempt 17) Finding 1: also re-apply the
        // public `APP_ID_PATTERN` to the on-disk identity. A
        // corrupt `manifest.json` that paired a bad-shape
        // directory name with a matching bad-shape `appId`
        // would otherwise slip into the eligible set even
        // though the request validator rejects every client
        // submission for that id (path-parameter / order entry
        // both gate on `APP_ID_PATTERN`). That mismatch would
        // wedge the whole reorder endpoint into a permanent
        // `MenuOrderCoverageMismatch`. The scan now treats any
        // such entry as ineligible (same shape as the previous
        // skip semantics for missing / parse-fail manifests).
        if (!APP_ID_PATTERN.test(entry) || !APP_ID_PATTERN.test(manifest.appId)) {
          apiLogger.warn(
            {
              directory: entry,
              manifestAppId: manifest.appId,
              path: pathCheck.canonical,
            },
            'PUT /api/apps/menu-order: manifest appId fails public APP_ID_PATTERN; treating as ineligible',
          )
          continue
        }
        manifests.push(manifest)
        canonicalManifestPaths.set(manifest.appId, pathCheck.canonical)
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

      // Spec note (attempt 3): no-op short-circuit. When
      // the requested order already matches what is on disk for
      // every eligible app, skip the rewrite + broadcast pair so
      // an authenticated caller cannot turn repeated no-op
      // submissions into a DoS surface (full app-set lock
      // contention + N writeFileAtomic calls every time). The
      // wire-contract surface is unchanged — clients still get a
      // 200 with the same `snapshotVersion` they would have seen
      // had we rewritten the manifests — only the audit field
      // `updatedCount` drops to 0 so the no-op path stays
      // distinguishable in the server log.
      const isNoOp = manifests.every(
        (m) => orderMap.get(m.appId) === m.menuOrder,
      )

      if (
        requestedSnapshot !== undefined &&
        requestedSnapshot !== currentSnapshot
      ) {
        respondAndAudit(res, apiLogger, {
          status: 409,
          body: { error: 'MenuOrderSnapshotDrift' },
          audit: {
            
            method: 'PUT',
            path: '/api/apps/menu-order',
            pathParams: {},
            audit: {
            action: 'menu-order-update',
            snapshotProvided: true,
            },
            errorCode: 'MenuOrderSnapshotDrift',
            
          },
        })
        return
      }

      if (isNoOp) {
        // Skip write + broadcast (Finding 2 fix). The 200 audit
        // still fires so the no-op submission is auditable —
        // `updatedCount: 0` already distinguishes the no-op case
        // from a real batch update without introducing extra
        // schema fields (Spec note (attempt 6), audit-logging
        // v1.2 §6.6.3 endpoint-specific field set is closed). We
        // fall through to the `finally` block (locks are released
        // in the normal order) and the post-lock response code
        // picks up `postCommit` to emit the 200 envelope and the
        // matching audit record after the response is sent
        // (Spec note (attempt 6), audit-logging v1.2 §6.6.2).
        postCommit = {
          newSnapshot: currentSnapshot,
          updatedCount: 0,
          broadcast: false,
        }
      } else {

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
      // Use the canonical paths captured under the boundary check
      // above so a TOCTOU swap of an original symlink between the
      // gate and the rewrite cannot redirect a write out of
      // <projectRoot>/app/ (mirror of PR #56 bundled-installer step
      // 3.5 TOCTOU defence; Spec note (attempt 7)).
      const previousBytes = new Map<string, string>()
      const writtenAppIds: string[] = []
      try {
        for (const manifest of manifests) {
          const path = canonicalManifestPaths.get(manifest.appId)
          if (path === undefined) {
            // Defensive — every appId went through the boundary
            // check loop above before we got here.
            throw new Error(
              `menu-order: ${manifest.appId} missing canonical path`,
            )
          }
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
          const path = canonicalManifestPaths.get(manifest.appId)!
          fs.writeFileAtomic(path, JSON.stringify(updated, null, 2) + '\n')
          writtenAppIds.push(manifest.appId)
        }
      } catch (writeErr) {
        // Rollback every successful write to the pre-snapshot bytes.
        // Use the same canonical paths the forward write used so the
        // rollback cannot follow a different symlink target.
        for (const appId of writtenAppIds) {
          const path = canonicalManifestPaths.get(appId)
          if (path === undefined) continue
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
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuOrderAtomicWriteFailed' },
          audit: {
            
            method: 'PUT',
            path: '/api/apps/menu-order',
            pathParams: {},
            audit: { action: 'menu-order-update' },
            errorCode: 'MenuOrderAtomicWriteFailed',
            
          },
        })
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
      postCommit = {
        newSnapshot,
        updatedCount: manifests.length,
        broadcast: true,
      }
      }
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
    } catch (unexpectedErr) {
      // Spec note (attempt 3): anything that escapes the
      // inner try block lands here. Treat it as an unexpected
      // server error — emit the audit record, return the JSON
      // envelope the API contract promises, and avoid Express's
      // default HTML error handler. `res.headersSent` is the gate
      // for callers that already responded inside the inner block;
      // we never send a second response.
      apiLogger.error(
        { err: unexpectedErr },
        'PUT /api/apps/menu-order: unexpected exception',
      )
      if (!res.headersSent) {
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuOrderAtomicWriteFailed' },
          audit: {
            
            method: 'PUT',
            path: '/api/apps/menu-order',
            pathParams: {},
            audit: { action: 'menu-order-update' },
            errorCode: 'MenuOrderAtomicWriteFailed',
            
          },
        })
      }
      return
    }

    // Reachable only on the success path: every error path inside
    // the try block returned without setting `postCommit`. We could
    // not run the broadcast + response inside the locked section
    // because broadcast latency would extend the time the per-app
    // locks are held.
    if (postCommit === null) return

    // Send the HTTP response FIRST, then emit the audit record,
    // then defer the ws broadcast onto the next tick via
    // `setImmediate`. Without the defer, a slow ws subscriber
    // (or a buggy broadcaster) would bleed its latency into the
    // request-critical path and the audit emission would also
    // wait on the fan-out — a ws backpressure incident would
    // turn into both API latency AND audit timing drift
    // (Spec note (attempt 14) Finding 2: pre-response broadcast
    // latency).
    res.json({
      updated: postCommit.updatedCount,
      snapshotVersion: postCommit.newSnapshot,
    })
    // Audit AFTER res.json so the timestamp reflects the spec's
    // "immediately after the response is sent" requirement
    // (audit-logging v1.2 §6.6.2).
    emitHttpRouteAudit(apiLogger, {
      method: 'PUT',
      path: '/api/apps/menu-order',
      pathParams: {},
      status: 200,
      audit: {
        action: 'menu-order-update',
        updatedCount: postCommit.updatedCount,
        snapshotProvided: requestedSnapshot !== undefined,
      },
    })
    // Defer the ws fan-out so it cannot bleed back into the
    // request-critical path (Finding 2 above). Errors stay
    // best-effort; the disk transaction has already committed.
    if (postCommit.broadcast) {
      setImmediate(() => {
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
      })
    }
  })

  // -----------------------------------------------------------------
  // PATCH /api/apps/:appId/menu-label — single-app override / reset.
  // -----------------------------------------------------------------
  router.patch('/:appId/menu-label', async (req, res) => {
    const appId = req.params.appId
    if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
      // Spec note (attempt 12): do NOT record the raw rejected
      // appId in audit. Express's route pattern accepts an
      // arbitrary path segment, so a caller could otherwise
      // submit very long / hostile bytes and force unbounded
      // audit-log amplification per request. The rejected
      // segment's BYTE LENGTH is the only forensic signal worth
      // keeping, and the verbose detail (capped to 1024 bytes
      // to stay bounded under abuse) goes to the server log,
      // not the HTTP route audit stream — keeping it out of
      // `audit.labelLength` avoids overloading that field with
      // two different meanings (the canonical meaning is
      // userMenuLabel length on the menu-label-update path;
      // Spec note (attempt 16) Finding 1 fix).
      const rawAppIdLength =
        typeof appId === 'string' ? Math.min(appId.length, 1024) : 0
      apiLogger.warn(
        { rawAppIdLength },
        'PATCH /api/apps/:appId/menu-label: rejected invalid appId',
      )
      respondAndAudit(res, apiLogger, {
        status: 400,
        body: { error: 'InvalidAppId' },
        audit: {
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          // appId is intentionally absent from pathParams here —
          // the value failed the regex and would be a bad audit
          // payload.
          pathParams: {},
          audit: {
            action: 'menu-label-update',
          },
          errorCode: 'InvalidAppId',
        },
      })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const rawLabel = body.userMenuLabel

    let userMenuLabel: string | null
    if (rawLabel === null) {
      userMenuLabel = null
    } else if (typeof rawLabel === 'string') {
      if (rawLabel.length === 0) {
        respondAndAudit(res, apiLogger, {
          status: 400,
          body: { error: 'MenuLabelEmpty' },
          audit: {
            
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: {
            appId,
            action: 'menu-label-update',
            labelLength: 0,
            },
            errorCode: 'MenuLabelEmpty',
            
          },
        })
        return
      }
      if (rawLabel.length > MENU_LABEL_MAX_LENGTH) {
        respondAndAudit(res, apiLogger, {
          status: 400,
          body: { error: 'MenuLabelTooLong' },
          audit: {
            
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: {
            appId,
            action: 'menu-label-update',
            labelLength: rawLabel.length,
            },
            errorCode: 'MenuLabelTooLong',
            
          },
        })
        return
      }
      userMenuLabel = rawLabel
    } else {
      respondAndAudit(res, apiLogger, {
        status: 400,
        body: { error: 'InvalidMenuLabel' },
        audit: {
          
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'InvalidMenuLabel',
          
        },
      })
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
        respondAndAudit(res, apiLogger, {
          status: 503,
          body: { error: 'AppLockTimeout' },
          audit: {
            
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'AppLockTimeout',
            
          },
        })
        return
      }
      apiLogger.error(
        { err: lockErr, appId },
        'PATCH /api/apps/:appId/menu-label: acquireAppLock unexpected',
      )
      respondAndAudit(res, apiLogger, {
        status: 500,
        body: { error: 'MenuLabelAtomicWriteFailed' },
        audit: {
          
          method: 'PATCH',
          path: '/api/apps/:appId/menu-label',
          pathParams: { appId },
          audit: { appId, action: 'menu-label-update' },
          errorCode: 'MenuLabelAtomicWriteFailed',
          
        },
      })
      return
    }

    // Captured before the lock is released so the post-commit
    // broadcast + 200 response can read the committed values back.
    // Stays `null` on every error path within the try block (which
    // sends its own response and returns), so we use that as the
    // "response already sent above" sentinel after `finally` runs.
    // Mirrors the PUT /api/apps/menu-order structure introduced in
    // Spec note (attempt 1) — both endpoints now keep the
    // app lock as short as possible by moving the post-commit
    // broadcast / response outside the locked region (codex attempt
    // 2 Finding 2: keeping the lock during broadcast can turn a
    // slow ws fan-out into AppLockTimeout for the same app).
    let postCommit:
      | { userMenuLabel: string | null; broadcast: boolean }
      | null = null
    // Spec note (attempt 9): wrap the locked section in an
    // outer try / catch so an unexpected throw — anywhere between
    // boundary check, manifest read, atomic write, audit emit, or
    // the inner try / finally itself — lands on a structured 500
    // JSON envelope instead of Express's default HTML error handler.
    // This mirrors the same guard PUT /api/apps/menu-order gained
    // in attempt 3. The inner try / finally still releases the lock
    // along every path.
    try {
    try {
      // The existence check is what distinguishes 404 AppNotFound
      // from 500 AppManifestUnreadable: a missing file is a
      // legitimate "no such app" signal, while a present-but-broken
      // file is server-side state that the user must repair.
      // The boundary check that follows the existsSync path also
      // rejects symlinks whose canonical target escapes
      // <projectRoot>/app/ — Spec note (attempt 7),
      // recipe-system v1.11 §10.9.3 step 2.5 path-boundary
      // verification SSOT replicated for apps-routes.
      const pathCheck = resolveManifestPathInAppRoot(fs, projectRoot, appId)
      if ('error' in pathCheck) {
        if (pathCheck.error === 'not-found') {
          respondAndAudit(res, apiLogger, {
            status: 404,
            body: { error: 'AppNotFound' },
            audit: {
              method: 'PATCH',
              path: '/api/apps/:appId/menu-label',
              pathParams: { appId },
              audit: { appId, action: 'menu-label-update' },
              errorCode: 'AppNotFound',
            },
          })
          return
        }
        // Both 'escaped' and 'resolve-failed' collapse into the
        // existing 500 AppManifestUnreadable wire-contract surface
        // (http-api-contract v1.7.3 §6.3.9.A): from the client's
        // viewpoint the manifest is no longer addressable in a
        // way the server is willing to honour. The forensic
        // distinction lives in the server log line below.
        apiLogger.warn(
          { appId, kind: pathCheck.error },
          'PATCH /api/apps/:appId/menu-label: manifest path failed boundary check',
        )
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'AppManifestUnreadable' },
          audit: {
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'AppManifestUnreadable',
          },
        })
        return
      }

      // Spec note (attempt 1) + attempt 8 Finding 1 fix:
      // route the read through `readAppManifestAtPath()` so this
      // endpoint agrees with `services/app-manifest.ts` on what
      // counts as a readable manifest AND opens the canonical path
      // that the boundary check above already approved. Going
      // through `readAppManifest(fs, projectRoot, appId)` here
      // would re-resolve `app/<appId>/manifest.json` and follow
      // any planted symlink, defeating the boundary gate. The
      // helper still returns `null` on read failure / JSON parse
      // failure / schema mismatch with a structured warn line in
      // each case, so all three are collapsed into one 500
      // AppManifestUnreadable surface here.
      const manifest = readAppManifestAtPath(fs, pathCheck.canonical, appId)
      if (manifest === null) {
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'AppManifestUnreadable' },
          audit: {
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'AppManifestUnreadable',
          },
        })
        return
      }

      // Spec note (attempt 9): refuse a manifest whose
      // internal `appId` field disagrees with the path parameter.
      // A corrupt manifest stored at `app/alpha/manifest.json`
      // carrying `appId: "beta"` would otherwise let this route
      // update the wrong app under the alpha-path lock, breaking
      // the cross-app exclusion the per-app lock is meant to
      // provide. Treat the mismatch as an unreadable manifest
      // (500 AppManifestUnreadable) so the wire surface stays
      // identical to every other corrupt-manifest path.
      if (manifest.appId !== appId) {
        apiLogger.warn(
          {
            requestedAppId: appId,
            manifestAppId: manifest.appId,
            path: pathCheck.canonical,
          },
          'PATCH /api/apps/:appId/menu-label: manifest.appId does not match path parameter',
        )
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'AppManifestUnreadable' },
          audit: {
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'AppManifestUnreadable',
          },
        })
        return
      }

      // Spec note (attempt 4): no-op short-circuit
      // (symmetric with PUT /api/apps/menu-order's no-op path
      // added in attempt 3). When the persisted userMenuLabel
      // is already equal to the requested value — including
      // the explicit `null` reset case applied to a manifest
      // whose userMenuLabel is already missing or null — skip
      // the writeFileAtomic call and the broadcast. The 200
      // audit still fires with the no-op marker so the
      // submission is auditable, and the response payload is
      // identical to what a real write would have produced.
      // This makes repeated identical PATCHes O(1) on disk +
      // ws fan-out, closing the DoS amplification surface.
      const currentLabel: string | null = manifest.userMenuLabel ?? null
      const isNoOp = currentLabel === userMenuLabel

      if (isNoOp) {
        postCommit = { userMenuLabel, broadcast: false }
        // Fall through to the `finally` block so the lock is
        // released; the post-lock response path then picks up
        // `postCommit`, returns 200, and emits the audit record
        // AFTER res.json (audit-logging v1.2 §6.6.2).
      } else {

      const updated: AppManifest = { ...manifest, userMenuLabel }
      try {
        // Use the canonical path captured under the boundary check
        // above so a TOCTOU swap of the original symlink between
        // the gate and the write cannot redirect us out of
        // <projectRoot>/app/ (mirror of PR #56 bundled-installer
        // step 3.5 TOCTOU fix).
        fs.writeFileAtomic(
          pathCheck.canonical,
          JSON.stringify(updated, null, 2) + '\n',
        )
      } catch (writeErr) {
        apiLogger.error(
          { err: writeErr, appId, path: pathCheck.canonical },
          'PATCH /api/apps/:appId/menu-label: atomic write failed',
        )
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuLabelAtomicWriteFailed' },
          audit: {
            
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'MenuLabelAtomicWriteFailed',
            
          },
        })
        return
      }

      // Still inside the lock-protected section. Capture the
      // post-commit payload before releasing the lock — the
      // broadcast + response + audit emission all happen after
      // `finally` so the lock hold time stays tight AND the audit
      // record reflects the spec's "after the response is sent"
      // ordering (audit-logging v1.2 §6.6.2).
      postCommit = { userMenuLabel, broadcast: true }
      }
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
    } catch (unexpectedErr) {
      // Spec note (attempt 9): anything that escapes the
      // inner try / finally lands here. Treat it as an unexpected
      // server error — emit the audit record, return the JSON
      // envelope the API contract promises, and avoid Express's
      // default HTML error handler. `res.headersSent` is the gate
      // for callers that already responded inside the inner block;
      // we never send a second response.
      apiLogger.error(
        { err: unexpectedErr, appId },
        'PATCH /api/apps/:appId/menu-label: unexpected exception',
      )
      if (!res.headersSent) {
        respondAndAudit(res, apiLogger, {
          status: 500,
          body: { error: 'MenuLabelAtomicWriteFailed' },
          audit: {
            method: 'PATCH',
            path: '/api/apps/:appId/menu-label',
            pathParams: { appId },
            audit: { appId, action: 'menu-label-update' },
            errorCode: 'MenuLabelAtomicWriteFailed',
          },
        })
      }
      return
    }

    // Reachable only on the success path: every error path inside
    // the try block returned without setting `postCommit`. We could
    // not run the broadcast + response inside the locked section
    // because broadcast latency would extend the time the per-app
    // lock is held (Spec note (attempt 2) — symmetric with
    // PUT /api/apps/menu-order).
    if (postCommit === null) return

    // Send the HTTP response FIRST, then emit the audit record,
    // then defer the ws broadcast onto the next tick via
    // `setImmediate` (symmetric with PUT, Spec note (attempt 14)
    // Finding 2). A slow ws subscriber would otherwise bleed
    // its latency into the request-critical path and the audit
    // emission would also wait on the fan-out.
    res.json({ appId, userMenuLabel: postCommit.userMenuLabel })
    // Audit AFTER res.json (audit-logging v1.2 §6.6.2). The raw
    // user-input label is never recorded — only its length, so
    // the redaction pipeline stays unburdened by free-form input.
    emitHttpRouteAudit(apiLogger, {
      method: 'PATCH',
      path: '/api/apps/:appId/menu-label',
      pathParams: { appId },
      status: 200,
      audit: {
        appId,
        action: 'menu-label-update',
        labelLength:
          postCommit.userMenuLabel === null
            ? null
            : postCommit.userMenuLabel.length,
      },
    })
    // Defer the ws fan-out so it cannot bleed back into the
    // request-critical path (Finding 2 above). Errors stay
    // best-effort; the disk transaction has already committed.
    if (postCommit.broadcast) {
      setImmediate(() => {
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
      })
    }
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
  respondAndAudit(res, apiLogger, {
    status: 400,
    body: { error: errorCode },
    audit: {
      method: 'PUT',
      path: '/api/apps/menu-order',
      pathParams: {},
      audit: { action: 'menu-order-update' },
      errorCode,
    },
  })
}

/**
 * Verify that the canonical path of `app/<appId>/manifest.json` stays
 * under `<projectRoot>/app/` before any read or write touches it.
 *
 * Without this gate, a planted `app/<appId>` symlink pointing at an
 * external directory (e.g. `/etc/`) would let the route operate on
 * `/etc/manifest.json` instead of the intended file. The check is
 * borrowed from `bundled-installer.ts` step 3.5 introduced in PR #56
 * for the same class of issue
 * (`recipe-system.md` v1.11 §10.9.3 step 2.5 path-boundary
 * verification) — the apps-routes parallel was missed in attempt 1-6
 * and surfaced in attempt 7 Finding 1.
 *
 * `realpathSync` resolves every intermediate symlink, so a chain of
 * links is normalised before the containment check. `isWithin` uses
 * the trailing-separator prefix rule from `pathResolver.ts` so a
 * `<projectRoot>/app-other/<appId>/...` target is correctly rejected
 * even though `app-other` starts with the same letters as `app`.
 *
 * Returns the canonical path on success, or `null` if the file does
 * not exist, cannot be resolved, or resolves outside the app root.
 * Callers funnel a `null` return into the existing
 * `404 AppNotFound` (when the missing path is just absent) or
 * `500 AppManifestUnreadable` (when the resolved target escaped the
 * boundary) decision the route already makes for unreadable files.
 */
/**
 * Verify that `<projectRoot>/app` is the literal sub-path of the
 * canonical project root, with no symlink redirection. Returns the
 * canonical app boundary on success, or a structured error so the
 * caller can distinguish root-level failures (which should surface
 * as 500) from per-entry failures (which can be skipped). Codex
 * attempt 12 Finding 1 + Finding 3 fix: PUT /api/apps/menu-order
 * must run this check ONCE before `readdirSync`, so an `app/`
 * symlink to an external directory cannot make the scan enumerate
 * a foreign location.
 */
function verifyAppRoot(
  fs: FileAccessLayer,
  projectRoot: string,
):
  | { appBoundary: string }
  | { error: 'project-root-resolve-failed' | 'app-root-resolve-failed' | 'app-root-escaped' } {
  let canonicalProjectRoot: string
  try {
    canonicalProjectRoot = fs.realpathSync(projectRoot)
  } catch {
    return { error: 'project-root-resolve-failed' }
  }
  const appBoundary = resolvePath(canonicalProjectRoot, 'app')
  let appBoundaryResolved: string
  try {
    appBoundaryResolved = fs.realpathSync(appBoundary)
  } catch {
    return { error: 'app-root-resolve-failed' }
  }
  if (appBoundaryResolved !== appBoundary) {
    return { error: 'app-root-escaped' }
  }
  return { appBoundary }
}

function resolveManifestPathInAppRoot(
  fs: FileAccessLayer,
  projectRoot: string,
  appId: string,
): { canonical: string } | { error: 'not-found' | 'escaped' | 'resolve-failed' } {
  // Spec note (attempt 15) Finding 2: check the `app/<appId>`
  // directory itself BEFORE looking at the manifest file inside
  // it. Without this gate, `app/<appId>` could be a symlink to
  // an external directory that simply lacks `manifest.json`; the
  // later `lstatSync(manifestPath)` would then return ENOENT and
  // the helper would mis-classify the case as `not-found` (→ 404
  // AppNotFound) even though the directory-level escape is the
  // primary anomaly the boundary check is meant to catch.
  const appDir = resolvePath(projectRoot, 'app', appId)
  try {
    fs.lstatSync(appDir)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') {
      return { error: 'not-found' }
    }
    return { error: 'resolve-failed' }
  }
  // Resolve `app/<appId>` to its canonical path and verify it
  // lives under `<canonicalProjectRoot>/app`. `verifyAppRoot()`
  // already pinned the parent boundary in the calling sites; here
  // we ensure the per-entry directory stays inside it.
  let canonicalAppDir: string
  try {
    canonicalAppDir = fs.realpathSync(appDir)
  } catch {
    return { error: 'resolve-failed' }
  }
  let canonicalProjectRoot: string
  try {
    canonicalProjectRoot = fs.realpathSync(projectRoot)
  } catch {
    return { error: 'resolve-failed' }
  }
  const appBoundary = resolvePath(canonicalProjectRoot, 'app')
  if (!isWithin(canonicalAppDir, appBoundary)) {
    return { error: 'escaped' }
  }

  const manifestPath = getAppManifestPath(projectRoot, appId)
  // Use `lstatSync` (not `existsSync`) so a dangling symlink is
  // distinguishable from a genuinely missing file: `existsSync`
  // follows the symlink and would return false for a broken
  // target, collapsing both "no file" and "broken-on-disk state"
  // into 404 AppNotFound. We want 404 only for the true-absence
  // case so the corrupt path surfaces as 500 AppManifestUnreadable
  // (Spec note (attempt 13)).
  try {
    fs.lstatSync(manifestPath)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') {
      return { error: 'not-found' }
    }
    // Any other error (EACCES, EIO, ENAMETOOLONG, etc.) is a
    // genuine resolution problem and must surface as such; a
    // permission-denied lstat is server-side state the user
    // needs to repair, not the API contract's "no such app".
    return { error: 'resolve-failed' }
  }
  // Resolve the manifest file itself and verify its canonical
  // path stays inside the boundary the per-entry check above
  // already approved. This second `isWithin` catches the rare
  // case where `manifest.json` is itself a symlink pointing
  // outside the per-entry `app/<appId>/` directory (even though
  // the directory itself was already in-bounds).
  let canonical: string
  try {
    canonical = fs.realpathSync(manifestPath)
  } catch {
    return { error: 'resolve-failed' }
  }
  if (!isWithin(canonical, appBoundary)) {
    return { error: 'escaped' }
  }
  return { canonical }
}

/**
 * Send the HTTP response first, THEN emit the `HttpRouteAuditEntry`
 * record. The order matters for `audit-logging.md` v1.2 §6.6.2,
 * which pins audit emission at "immediately after the response is
 * sent" so the audit log cannot record a status that never made it
 * to the wire (e.g. if the response write itself fails). Express
 * 5's `res.status().json()` synchronously queues the status code,
 * headers, and body to the kernel socket buffer; reading the status
 * back out of `res.statusCode` after that call is the closest we
 * can get to "after sent" without wiring an `on-finished` hook for
 * every route in the file.
 *
 * Spec note (attempt 6) (medium, audit integrity).
 */
function respondAndAudit(
  res: import('express').Response,
  apiLogger: Logger,
  opts: {
    status: number
    body: Record<string, unknown>
    audit: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      path: string
      pathParams: Record<string, string>
      audit: HttpRouteAuditPayload
      errorCode?: string
    }
  },
): void {
  res.status(opts.status).json(opts.body)
  emitHttpRouteAudit(apiLogger, { ...opts.audit, status: opts.status })
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
