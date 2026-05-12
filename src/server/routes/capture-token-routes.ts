/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture-token issuance + revocation endpoints
 * (v0.2.0 Phase 1 ①, spec v1.6 §6.10.6 / v1.4 §10.6.7).
 *
 * Mounted under `/api/app/capture-token` and serves the lifecycle
 * half of the per-recipe-page capture token mechanism:
 *
 *   - `POST /api/app/capture-token/issue` — recipe page mount-time
 *     mint. `captureBridge.ts` calls this from `injectKb` and
 *     caches the response token in a closure for the lifetime of
 *     the mount. Grandfather recipes
 *     (`manifest.captureRequires.length === 0`) get a
 *     `{ token: null, reason: 'grandfather-no-capture' }` response
 *     so the client can fail-fast without holding a useless token.
 *   - `POST /api/app/capture-token/revoke` — recipe page unmount-time
 *     teardown. Idempotent; double-revoke during React cleanup
 *     races is safe.
 *
 * The capture endpoint
 * (`/api/app/capture/<kind>`, see `capture-routes.ts`) reads the
 * resulting token from the `X-KB-Capture-Token` header on every
 * request and derives the authoritative `appId` from the token
 * store. `req.body.appId` is ignored end-to-end (I-CR4).
 *
 * Wire authentication is provided by the existing
 * `createTokenAndOriginGuard` middleware mounted at `app.use('/api',
 * verifyTokenAndOrigin)` in `src/server/index.ts`; this router only
 * implements the capture-token-specific contract on top.
 *
 * @see recipe-system.md v1.6 §6.10.6
 * @see http-api-contract.md v1.4 §10.6.7
 * @see app-directory-extension.md v1.3 §10.5.2
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { Logger } from 'pino'
import {
  issueCaptureToken,
  revokeCaptureToken,
  MAX_ACTIVE_TOKENS,
  TOKEN_TTL_MS,
} from '../recipe-capture-sessions.js'
import type { RecipeManifest } from '../recipe/apiTypes.js'
import { MAX_APP_ID_LENGTH } from '../../shared/security-limits.js'

/**
 * Same narrow contract as `CaptureManifestLookup` in
 * `capture-routes.ts` — kept duplicated rather than coupling the
 * two routers, because each lookup tests a different invariant
 * (the token endpoint cares about grandfather skipping, the
 * capture endpoint cares about declaration / consent).
 */
export interface CaptureTokenManifestLookup {
  get(appId: string): RecipeManifest | null
}

export interface CreateCaptureTokenRouterOptions {
  manifestStore: CaptureTokenManifestLookup
  logger: Logger
}

/** Same shape as `markInstalledValidator.APP_ID_PATTERN`. */
const APP_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$`,
)

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** Retry-After window communicated on 503 responses, in seconds. */
const STORE_FULL_RETRY_AFTER_S = 30

export function createCaptureTokenRouter(
  opts: CreateCaptureTokenRouterOptions,
): Router {
  const router = Router()
  const { manifestStore, logger } = opts

  /**
   * POST /api/app/capture-token/issue
   *
   * Mint a capture token bound to the given `appId`. The response
   * shape matches `http-api-contract.md` v1.4 §10.6.7.1: 200 +
   * token on success, 200 + `token: null` for grandfather installs,
   * 400 for malformed `appId`, 404 for unknown `appId`, 503 when
   * the in-memory store is at the {@link MAX_ACTIVE_TOKENS} cap.
   */
  router.post('/issue', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawAppId = body.appId

    if (typeof rawAppId !== 'string' || !APP_ID_PATTERN.test(rawAppId)) {
      res.status(400).json({
        error: 'InvalidAppId',
        message:
          `appId must match /^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$/.`,
        details: {
          // Echo only the truncated prefix back — the validator
          // already refused the value, and any longer echo would
          // amplify hostile inputs into the response body.
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
      logger.info({ appId }, 'capture-token issue: no matching manifest')
      return
    }

    // Grandfather skip: a recipe that declared nothing under
    // `capture.requires` cannot legitimately make capture calls
    // (spec v1.6 §6.10.6.7). Returning `token: null` lets the
    // client fail-fast without consuming a store slot.
    if (manifest.captureRequires.length === 0) {
      res.status(200).json({
        token: null,
        expiresAt: null,
        reason: 'grandfather-no-capture',
      })
      logger.info(
        { appId, recipeId: manifest.recipeId, trustLevel: manifest.trustLevel },
        'capture-token issue: grandfather skip',
      )
      return
    }

    const result = issueCaptureToken(appId)
    if (!result.ok) {
      res.status(503).json({
        error: 'CaptureTokenStoreFull',
        message:
          `Capture-token store is full (max ${MAX_ACTIVE_TOKENS} active tokens). ` +
          'Retry after waiting or after another recipe page unmounts.',
        details: {
          maxActiveTokens: MAX_ACTIVE_TOKENS,
          retryAfter: STORE_FULL_RETRY_AFTER_S,
        },
      })
      logger.warn(
        { appId, recipeId: manifest.recipeId, maxActiveTokens: MAX_ACTIVE_TOKENS },
        'capture-token issue: store full',
      )
      return
    }

    res.status(200).json({
      token: result.token,
      expiresAt: result.expiresAt,
      reason: null,
    })
    logger.info(
      { appId, recipeId: manifest.recipeId, ttlMs: TOKEN_TTL_MS },
      'capture-token issue: ok',
    )
  })

  /**
   * POST /api/app/capture-token/revoke
   *
   * Drop a token from the store. Idempotent — a second revoke
   * during a React cleanup race is harmless. Spec
   * `http-api-contract.md` v1.4 §10.6.7.2:
   *   - 200 `{ ok: true, revoked: true }` when the entry existed.
   *   - 200 `{ ok: true, revoked: false }` when the entry was
   *     already gone (expired sweep, double-revoke).
   *   - 401 when the `X-KB-Capture-Token` header is missing.
   *   - 400 when the header value is malformed.
   */
  router.post('/revoke', (req, res) => {
    const headerToken = req.header('x-kb-capture-token')
    if (typeof headerToken !== 'string' || headerToken.length === 0) {
      res.status(401).json({
        error: 'MissingCaptureToken',
        message:
          'X-KB-Capture-Token header is required to revoke a capture token.',
      })
      return
    }
    if (!TOKEN_PATTERN.test(headerToken)) {
      res.status(400).json({
        error: 'InvalidCaptureToken',
        message:
          'X-KB-Capture-Token must be a 32-character lowercase hex string.',
      })
      return
    }
    const revoked = revokeCaptureToken(headerToken)
    res.status(200).json({ ok: true, revoked })
    logger.info({ revoked }, 'capture-token revoke')
  })

  return router
}
