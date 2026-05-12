/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture-mount lifecycle endpoints
 * (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6 / v1.5 §10.6.7.1〜§10.6.7.2).
 *
 * The host renderer asks for a server-issued `mountId` whenever a
 * `RecipePageHost` mounts. The `mountId` is the authority for the
 * active recipe identity (I-CR4 / I-CR6) — `req.body.appId` is
 * accepted here only as the *input* the server validates against its
 * own manifest store, and the resulting record is signed off the
 * `mountId` from then on. The capture-token endpoint and the
 * capture endpoint both resolve appId through the mountStore rather
 * than from caller-supplied input.
 *
 * Endpoints:
 *   - `POST /api/app/capture-mount/open` — mint a fresh `mountId`.
 *     Returns `{ mountId, expiresAt }` on success, or a structured
 *     fail response: 400 for bad appId, 401 for missing /
 *     mismatched internal auth, 404 for unknown appId, 200 with
 *     `mountId: null, reason: 'grandfather-no-capture'` for
 *     grandfather recipes (so the renderer fail-fasts without
 *     consuming a slot), 503 for per-app / global quota exhaustion.
 *   - `POST /api/app/capture-mount/close` — drop the mount entry +
 *     atomically delete the bound capture token (H-CR4). Idempotent.
 *
 * Both endpoints assume `verifyTokenAndOrigin` already ran (mounted
 * once at `app.use('/api', verifyTokenAndOrigin)` in
 * `src/server/index.ts`). This router only adds `verifyInternalAuth`
 * on top.
 *
 * @see recipe-system.md v1.7 §6.10.6 (I-CR4〜I-CR8 + H-CR1〜H-CR5)
 * @see http-api-contract.md v1.5 §10.6.7.1〜§10.6.7.2
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Logger } from 'pino'
import {
  openMount,
  closeMount,
  countMountsForApp,
  MAX_ACTIVE_MOUNTS_PER_APP,
  MAX_ACTIVE_MOUNTS_GLOBAL,
  MOUNT_QUOTA_RETRY_AFTER_S,
  MOUNT_ID_PATTERN,
  __sizeForTests as mountStoreSize,
} from '../recipe-capture-mount-sessions.js'
import {
  revokeCaptureTokenByMountId,
  withCriticalSection,
} from '../recipe-capture-sessions.js'
import type { RecipeManifest } from '../recipe/apiTypes.js'
import { MAX_APP_ID_LENGTH } from '../../shared/security-limits.js'

/**
 * Minimal manifest-store contract this router depends on. Kept
 * narrower than the real `RecipeManifestStore` so unit tests can
 * inject a stub without rebuilding the whole class.
 */
export interface CaptureMountManifestLookup {
  get(appId: string): RecipeManifest | null
}

export interface CreateCaptureMountRouterOptions {
  manifestStore: CaptureMountManifestLookup
  logger: Logger
  /**
   * `verifyInternalAuth` middleware. The router itself does not
   * resolve `KB_INTERNAL_TOKEN` — the caller (index.ts) builds the
   * middleware once with the resolved token and passes it in. This
   * keeps unit tests trivial: pass a stub `(req, _res, next) =>
   * next()` and the router stays composable.
   */
  verifyInternalAuth: RequestHandler
}

/** Same shape as `markInstalledValidator.APP_ID_PATTERN`. */
const APP_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$`,
)

export function createCaptureMountRouter(
  opts: CreateCaptureMountRouterOptions,
): Router {
  const router = Router()
  const { manifestStore, logger, verifyInternalAuth } = opts

  // Both endpoints require the host-only internal auth header on
  // top of the launch token + Origin allowlist already mounted at
  // /api by index.ts. Spec v1.5 §10.6.7.0 middleware order:
  //   verifyTokenAndOrigin (existing) → verifyInternalAuth (here)
  //   → individual handler.
  router.use(verifyInternalAuth)

  /**
   * POST /api/app/capture-mount/open
   *
   * Issue a fresh `mountId` for the given `appId`. Spec contract
   * (`http-api-contract.md` v1.5 §10.6.7.1):
   *   - 200 `{ mountId, expiresAt, reason: null }` on success.
   *   - 200 `{ mountId: null, expiresAt: null, reason: 'grandfather-no-capture' }`
   *     when `manifest.captureRequires.length === 0` (grandfather skip).
   *   - 400 `InvalidAppId` on malformed appId.
   *   - 404 `NoMatchingManifest` when the appId is unknown.
   *   - 503 `MountQuotaPerAppExceeded` / `MountStoreFull` on capacity.
   */
  router.post('/open', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawAppId = body.appId

    if (typeof rawAppId !== 'string' || !APP_ID_PATTERN.test(rawAppId)) {
      res.status(400).json({
        error: 'InvalidAppId',
        message:
          `appId must match /^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$/.`,
        details: {
          appId:
            typeof rawAppId === 'string' ? rawAppId.slice(0, 64) : null,
        },
      })
      return
    }
    const appId = rawAppId

    const manifest = manifestStore.get(appId)
    if (!manifest) {
      res.status(404).json({
        error: 'NoMatchingManifest',
        message: `No installed recipe matches appId "${appId}".`,
        details: { appId },
      })
      logger.info({ appId }, 'capture-mount open: no matching manifest')
      return
    }

    // Grandfather skip (spec v1.7 §6.10.6.7). A recipe that
    // declared no captures cannot legitimately mount a capture
    // identity. Returning `mountId: null` lets the host renderer
    // fail-fast without occupying a slot in the per-app cap.
    if (manifest.captureRequires.length === 0) {
      res.status(200).json({
        mountId: null,
        expiresAt: null,
        reason: 'grandfather-no-capture',
      })
      logger.info(
        { appId, recipeId: manifest.recipeId, trustLevel: manifest.trustLevel },
        'capture-mount open: grandfather skip',
      )
      return
    }

    // H-CR4 critical section: every store mutation lives in the
    // synchronous slice this handler occupies. The lint gate
    // (tools/check-release-hygiene.mjs) refuses to ship if a
    // future maintainer accidentally adds `await` here.
    const result = withCriticalSection('capture-mount/open', () =>
      openMount(appId),
    )
    if (!result.ok) {
      if (result.reason === 'PerAppQuotaExceeded') {
        res.status(503).json({
          error: 'MountQuotaPerAppExceeded',
          message:
            `Recipe "${appId}" already has ${MAX_ACTIVE_MOUNTS_PER_APP} active ` +
            'capture mounts. Close another panel of this recipe and retry.',
          details: {
            appId,
            currentLimit: MAX_ACTIVE_MOUNTS_PER_APP,
            retryAfter: MOUNT_QUOTA_RETRY_AFTER_S,
          },
        })
        logger.warn(
          {
            appId,
            recipeId: manifest.recipeId,
            currentLimit: MAX_ACTIVE_MOUNTS_PER_APP,
            liveCount: countMountsForApp(appId),
          },
          'capture-mount open: per-app quota exceeded',
        )
        return
      }
      // StoreFull
      res.status(503).json({
        error: 'MountStoreFull',
        message:
          `Capture-mount store is full (max ${MAX_ACTIVE_MOUNTS_GLOBAL} active mounts). ` +
          'Close another recipe page and retry.',
        details: {
          currentLimit: MAX_ACTIVE_MOUNTS_GLOBAL,
          retryAfter: MOUNT_QUOTA_RETRY_AFTER_S,
        },
      })
      logger.warn(
        {
          appId,
          recipeId: manifest.recipeId,
          currentLimit: MAX_ACTIVE_MOUNTS_GLOBAL,
          liveCount: mountStoreSize(),
        },
        'capture-mount open: store full',
      )
      return
    }

    res.status(200).json({
      mountId: result.mountId,
      expiresAt: result.expiresAt,
      reason: null,
    })
    logger.info(
      { appId, recipeId: manifest.recipeId, mountId: result.mountId },
      'capture-mount open: ok',
    )
  })

  /**
   * POST /api/app/capture-mount/close
   *
   * Drop the mount entry + atomically revoke any capture token
   * bound to that mountId. Idempotent.
   */
  router.post('/close', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawMountId = body.mountId

    if (typeof rawMountId !== 'string' || !MOUNT_ID_PATTERN.test(rawMountId)) {
      res.status(400).json({
        error: 'InvalidMountId',
        message:
          'mountId must be a 32-character lowercase hex string.',
      })
      return
    }
    const mountId = rawMountId

    // H-CR4 critical section: mountStore + tokenStore atomic delete
    // in a single synchronous slice. Spec v1.7 §6.10.6.15.
    const closed = withCriticalSection('capture-mount/close', () => {
      const mountWasPresent = closeMount(mountId)
      // Always sweep the matching token even if the mount was
      // already gone — the token store could outlive the mount
      // through a race we want to clean up regardless.
      revokeCaptureTokenByMountId(mountId)
      return mountWasPresent
    })

    res.status(200).json({ ok: true, closed })
    logger.info({ mountId, closed }, 'capture-mount close')
  })

  return router
}
