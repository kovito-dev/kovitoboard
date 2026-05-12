/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture-token issuance + revocation endpoints
 * (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6 / v1.5 §10.6.7.3〜§10.6.7.4).
 *
 * Mounted under `/api/app/capture-token`:
 *   - `POST /api/app/capture-token/issue` — mint a fresh token
 *     against a server-issued `mountId`. The `appId` is derived from
 *     the mountStore record, **never** from caller-supplied input
 *     (I-CR4). Spec v1.7 changed the request body from `{ appId }`
 *     to `{ mountId }` to close the upstream `req.body.appId`
 *     forgery the previous capture-token mechanism still allowed
 *     (PR #30 attempt 4 CodeX HIGH).
 *   - `POST /api/app/capture-token/revoke` — drop a token by its
 *     header value. Idempotent.
 *
 * Both endpoints require the host-only `verifyInternalAuth`
 * middleware on top of the launch-token + Origin allowlist already
 * mounted at `/api`. The capture-runtime endpoint
 * (`/api/app/capture/<kind>`) does **not** run `verifyInternalAuth`
 * — that path is the legitimate recipe-page route, gated by the
 * `X-KB-Capture-Token` header instead.
 *
 * @see recipe-system.md v1.7 §6.10.6 (I-CR4〜I-CR8 + H-CR1〜H-CR5)
 * @see http-api-contract.md v1.5 §10.6.7.3〜§10.6.7.4
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Logger } from 'pino'
import {
  issueCaptureToken,
  revokeCaptureToken,
  withCriticalSection,
  MAX_ACTIVE_TOKENS,
  TOKEN_TTL_MS,
} from '../recipe-capture-sessions.js'
import { getMount, MOUNT_ID_PATTERN } from '../recipe-capture-mount-sessions.js'

export interface CreateCaptureTokenRouterOptions {
  logger: Logger
  /** Host-only auth middleware bound to the current launch token. */
  verifyInternalAuth: RequestHandler
}

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** Retry-After window communicated on 503 responses, in seconds. */
const STORE_FULL_RETRY_AFTER_S = 30

export function createCaptureTokenRouter(
  opts: CreateCaptureTokenRouterOptions,
): Router {
  const router = Router()
  const { logger, verifyInternalAuth } = opts

  // Spec v1.5 §10.6.7.0: capture-token endpoints are host-only and
  // sit behind `verifyInternalAuth` on top of the launch-token
  // guard already mounted at /api.
  router.use(verifyInternalAuth)

  /**
   * POST /api/app/capture-token/issue
   *
   * Mint a fresh capture token bound to the given `mountId`. The
   * appId is derived from the mountStore record (`getMount`); the
   * request body's `mountId` is the only caller-supplied input the
   * router trusts (I-CR4).
   *
   * Spec v1.5 §10.6.7.3 contract:
   *   - 200 `{ token, expiresAt }` on success.
   *   - 400 `InvalidMountId` on malformed mountId.
   *   - 401 `MountNotFound` when the mountId is unknown / expired.
   *   - 503 `CaptureTokenStoreFull` when the store is at the cap.
   *
   * Per-mount idempotency: a second `/issue` against the same
   * `mountId` atomically replaces the existing token (H-CR4 SSOT).
   * The replacement does not count against the cap.
   */
  router.post('/issue', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawMountId = body.mountId

    if (typeof rawMountId !== 'string' || !MOUNT_ID_PATTERN.test(rawMountId)) {
      res.status(400).json({
        error: 'InvalidMountId',
        message:
          'mountId must be a 32-character lowercase hex string ' +
          '(server-issued by /api/app/capture-mount/open).',
        details: {
          mountId:
            typeof rawMountId === 'string' ? rawMountId.slice(0, 64) : null,
        },
      })
      return
    }
    const mountId = rawMountId

    // The mount lookup is the **only** path through which `appId`
    // enters this handler. `req.body.appId` is intentionally never
    // read — that was the attempt-4 cross-app capability theft
    // (I-CR4).
    const mountResult = getMount(mountId)
    if (!mountResult.ok) {
      res.status(401).json({
        error: 'MountNotFound',
        message:
          mountResult.reason === 'expired'
            ? 'mountId has expired. Re-open the mount to mint a fresh identity.'
            : 'mountId is not registered. The mount may never have been opened, ' +
              'or it was closed in the meantime.',
        details: { mountId },
      })
      logger.info({ mountId, reason: mountResult.reason }, 'capture-token issue: mount not found')
      return
    }
    const appId = mountResult.appId

    const result = withCriticalSection('capture-token/issue', () =>
      issueCaptureToken({ mountId, appId }),
    )
    if (!result.ok) {
      res.status(503).json({
        error: 'CaptureTokenStoreFull',
        message:
          `Capture-token store is full (max ${MAX_ACTIVE_TOKENS} active tokens). ` +
          'Retry after waiting or after another recipe page unmounts.',
        details: {
          currentLimit: MAX_ACTIVE_TOKENS,
          retryAfter: STORE_FULL_RETRY_AFTER_S,
        },
      })
      logger.warn(
        { mountId, appId, currentLimit: MAX_ACTIVE_TOKENS },
        'capture-token issue: store full',
      )
      return
    }

    res.status(200).json({
      token: result.token,
      expiresAt: result.expiresAt,
    })
    logger.info(
      { mountId, appId, ttlMs: TOKEN_TTL_MS },
      'capture-token issue: ok',
    )
  })

  /**
   * POST /api/app/capture-token/revoke
   *
   * Drop a token from the store. Idempotent — a second revoke
   * during a React cleanup race is harmless. Spec v1.5 §10.6.7.4:
   *   - 200 `{ ok: true, revoked: true|false }`.
   *   - 401 when `X-KB-Capture-Token` header is missing.
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
    const revoked = withCriticalSection('capture-token/revoke', () =>
      revokeCaptureToken(headerToken),
    )
    res.status(200).json({ ok: true, revoked })
    logger.info({ revoked }, 'capture-token revoke')
  })

  return router
}
