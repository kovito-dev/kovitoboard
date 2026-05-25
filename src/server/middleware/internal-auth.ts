/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Host-only issuance gate for the capture-mount + capture-token EPs
 * (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6.9).
 *
 * The trusted-host-mediated identity design (PR #30 attempt 4)
 * requires that **only the host renderer + the server itself** can
 * mint or revoke capture identities. The renderer holds the
 * `KB_INTERNAL_TOKEN` in a module-scope closure inside the
 * `injectKb` bootstrap (recipe code is forbidden from seeing it via
 * `window` / DOM / `localStorage`), and attaches it to every
 * `/api/app/capture-mount/{open,close}` and
 * `/api/app/capture-token/{issue,revoke}` request via the
 * `X-KB-Internal-Auth` header.
 *
 * The middleware checks the header against the launch-time mint with
 * constant-time compare so a hostile probe cannot exfiltrate the
 * token byte-by-byte via response timing.
 *
 * Honest claim
 * ------------
 * Spec v1.7 §6.10.6.11 (`v0.2.x-known-limitation`) makes it explicit
 * that the v0.2.x architecture cannot **structurally** isolate
 * recipe JS from host JS — they share a realm. The token is
 * **hardening** against direct unauthenticated forgery, not
 * structural secrecy. Same-realm transport interception
 * (monkey-patching `fetch`, paused-scope inspection of the
 * `injectKb` closure) remains possible until v0.3.0 isolation work
 * lands (§6.10.6.12 roadmap).
 *
 * @see recipe-system.md v1.7 §6.10.6.9
 * @see http-api-contract.md v1.5 §10.6.7.6
 * @stable v0.2.0
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'

const INTERNAL_AUTH_HEADER = 'x-kb-internal-auth'

/**
 * Required token shape: 32 lowercase hex characters (128 bits of
 * entropy). Same format as `KB_LAUNCH_TOKEN`, so the renderer-side
 * "safe to interpolate into HTML" assumption carries over.
 */
const TOKEN_FORMAT_RE = /^[0-9a-f]{32}$/

/**
 * Resolve the expected internal token from the environment. Throws
 * on missing / malformed input so the server refuses to boot with a
 * degraded auth posture.
 *
 * The supervisor (`tools/kb-start.mjs`) mints the value via
 * `randomBytes(16).toString('hex')` on every launch — including each
 * SIGUSR2 restart — and feeds it through `KB_INTERNAL_TOKEN`.
 * Ad-hoc launches outside the supervisor must export the variable
 * manually; we refuse to fall back to a generated value because that
 * would normalise a degraded mode.
 */
export function resolveInternalTokenOrThrow(): string {
  const token = process.env.KB_INTERNAL_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'KB_INTERNAL_TOKEN is missing. The supervisor (tools/kb-start.mjs) ' +
        'must set this env var before spawning the server. Direct ' +
        'launches must export it manually (32-char lowercase hex).',
    )
  }
  if (!TOKEN_FORMAT_RE.test(token)) {
    throw new Error(
      'KB_INTERNAL_TOKEN must be a 32-character lowercase hex string ' +
        '(the supervisor mints it via randomBytes(16).toString("hex")).',
    )
  }
  return token
}

/**
 * Constant-time compare. Returns false on length mismatch without
 * allocating a same-length buffer to compare against (the
 * allocation itself would be a side channel).
 */
function tokensMatch(actual: string | undefined | null, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length === 0) return false
  if (actual.length !== expected.length) return false
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Express middleware factory. Builds a `verifyInternalAuth` handler
 * bound to the expected token captured at construction time.
 *
 * Wire contract (spec v1.5 §10.6.7.1〜§10.6.7.4):
 *   - Missing header → 401 `MissingInternalAuth`.
 *   - Header present but mismatched → 401 `InvalidInternalAuth`.
 *   - Match → `next()`.
 *
 * The renderer treats a `InvalidInternalAuth` 401 from any of the
 * four EPs as a "KB restarted" signal and triggers the restart
 * recovery contract (spec v1.7 §6.10.6.14: reject all pending capture
 * Promises with `RestartReloadError`, then `window.location.reload()`).
 */
export function createInternalAuthGuard(expectedToken: string) {
  return function verifyInternalAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const headerValue = req.headers[INTERNAL_AUTH_HEADER]
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
    if (typeof headerToken !== 'string' || headerToken.length === 0) {
      res.status(401).json({
        error: 'MissingInternalAuth',
        message:
          'X-KB-Internal-Auth header is required. This endpoint is host-only — ' +
          'recipe code cannot mint or revoke capture identities directly.',
      })
      return
    }
    if (!tokensMatch(headerToken, expectedToken)) {
      res.status(401).json({
        error: 'InvalidInternalAuth',
        message:
          'X-KB-Internal-Auth does not match the current launch. The KB process ' +
          'has likely restarted; the renderer should reload to pick up the new token.',
      })
      return
    }
    next()
  }
}

/**
 * Test seam: re-export the constants for unit tests so they can
 * build synthetic requests without re-deriving the rules.
 */
export const __testing = {
  INTERNAL_AUTH_HEADER,
  TOKEN_FORMAT_RE,
}
