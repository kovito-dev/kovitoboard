/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Host-side audit endpoints (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6.13).
 *
 * `POST /api/audit/host-bootstrap` lets the host renderer record a
 * sentinel for every `RecipePageHost` mount that proves the host
 * bootstrap (`injectKb`'s pristine-globals capture step) completed
 * **before** the recipe content renders. The check is "host-emitted"
 * (not recipe-cooperative): the recipe author does not write the
 * assertion themselves, the `RecipePageHost` wrapper fires it on
 * their behalf so a malicious recipe cannot opt out of being
 * observed.
 *
 * The event landing in the audit log is the operational truth: a
 * `host-bootstrap-violation` record means a recipe page mounted
 * before the bootstrap fence, which spec v1.7 §6.10.6.13 H-CR1
 * forbids. L1 E2E asserts the absence of `host-bootstrap-violation`
 * and the matching count of `host-bootstrap-verified` across every
 * fixture.
 *
 * Wire contract:
 *   - 204 No Content on success.
 *   - 400 on malformed body.
 *   - 401 (from `verifyInternalAuth`) when the host-only token is
 *     missing or mismatched.
 *
 * @see recipe-system.md v1.7 §6.10.6.13 (H-CR1)
 * @see app-directory-extension.md v1.4 §10.5.2 (host-emitted sentinel)
 * @stable v0.2.0
 */
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Logger } from 'pino'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

export interface CreateAuditRouterOptions {
  projectRoot: string
  logger: Logger
  /** Host-only auth middleware bound to the current launch token. */
  verifyInternalAuth: RequestHandler
}

const ALLOWED_EVENTS = new Set([
  'host-bootstrap-verified',
  'host-bootstrap-violation',
])

const MAX_FIELD_LENGTH = 256

function clipString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > MAX_FIELD_LENGTH
    ? value.slice(0, MAX_FIELD_LENGTH)
    : value
}

export function createAuditRouter(opts: CreateAuditRouterOptions): Router {
  const router = Router()
  const { projectRoot, logger, verifyInternalAuth } = opts

  // The host-bootstrap audit log path is global (one file for the
  // whole instance) because the sentinel proves a property about
  // host bootstrap, not about any particular recipe.
  const logPath = join(projectRoot, 'app', '_host-bootstrap-audit.log')

  router.use(verifyInternalAuth)

  /**
   * POST /api/audit/host-bootstrap
   *
   * Body:
   *   {
   *     event: 'host-bootstrap-verified' | 'host-bootstrap-violation',
   *     recipePath?: string,
   *     appId?: string,
   *     when?: string,
   *   }
   *
   * Writes a JSONL record to `app/_host-bootstrap-audit.log` with
   * the additional `timestamp` field stamped server-side so the
   * log reader can dedupe / order replay attempts.
   */
  router.post('/host-bootstrap', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawEvent = body.event
    if (typeof rawEvent !== 'string' || !ALLOWED_EVENTS.has(rawEvent)) {
      res.status(400).json({
        error: 'InvalidEvent',
        message:
          `event must be one of: ${Array.from(ALLOWED_EVENTS).join(', ')}.`,
      })
      return
    }

    const entry = {
      timestamp: new Date().toISOString(),
      event: rawEvent,
      recipePath: clipString(body.recipePath),
      appId: clipString(body.appId),
      when: clipString(body.when),
    }

    try {
      const dir = dirname(logPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err) {
      logger.error(
        { err, event: rawEvent, recipePath: entry.recipePath },
        'host-bootstrap audit: write failed',
      )
      // Still respond 204 — the audit log write is best-effort and
      // should not block the renderer. Operators see the failure
      // via the structured logger.
    }

    if (rawEvent === 'host-bootstrap-violation') {
      logger.error(
        {
          recipePath: entry.recipePath,
          appId: entry.appId,
          when: entry.when,
        },
        'host bootstrap violation: recipe mounted before host bootstrap completed',
      )
    } else {
      logger.debug(
        {
          recipePath: entry.recipePath,
          appId: entry.appId,
          when: entry.when,
        },
        'host bootstrap verified',
      )
    }

    res.status(204).end()
  })

  return router
}

/**
 * Test seam — re-export so unit tests can build synthetic requests
 * without re-deriving the contract.
 */
export const __testing = {
  ALLOWED_EVENTS,
  MAX_FIELD_LENGTH,
}
