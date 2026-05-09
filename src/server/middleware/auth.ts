/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-launch token authentication for HTTP and WebSocket entry points.
 *
 * Threat model (narrow)
 * ---------------------
 * KovitoBoard is a local-first tool that runs without an authentication
 * layer in front of its privileged HTTP API, WebSocket bridge, and
 * admin restart/stop endpoints. Pinning the listeners to 127.0.0.1
 * (PR #14 / supervisor-startup §5.9.3) closes the LAN exposure, but
 * any browser tab pointed at a different origin on the same machine
 * (`http://attacker.example`, a stale tab from another local app, etc.)
 * can still issue cross-origin fetches and WebSocket upgrades against
 * the loopback ports. This middleware closes that specific gap by
 * requiring:
 *
 *   - A loopback `Origin` (or no Origin) on every privileged HTTP
 *     request and every WebSocket upgrade. Browsers cannot lie about
 *     `Origin`, so a tab loaded from `http://attacker.example` is
 *     rejected at the boundary.
 *   - A per-launch token on every privileged HTTP request and every
 *     WebSocket upgrade. Because browsers also enforce CORS on custom
 *     headers, a malicious origin cannot ride an existing user
 *     session by attaching `X-Kovitoboard-Token` from script.
 *
 * Out of scope (what this middleware does NOT defend against)
 * ----------------------------------------------------------
 * The launch token is delivered to the renderer through a `<meta>` tag
 * embedded into `index.html`, and the HTML itself is served without
 * authentication so the renderer can bootstrap. A malicious process
 * already running on the same machine (or a recipe app misbehaving
 * inside its sandbox) can therefore read the token by issuing
 * `GET /` and parsing the meta tag, then forge any privileged call.
 * Defending against co-resident hostile processes requires a different
 * transport (Unix-domain socket, Electron-style IPC, OS-level user
 * scoping) and is intentionally deferred. The current goal is to shrink
 * the attack surface to "another local user's process explicitly
 * loaded our HTML", not to provide capability-style isolation.
 *
 * Token rotation
 * --------------
 * The supervisor mints a fresh token on every launch — including each
 * SIGUSR2-driven restart — so any token captured before a reboot is
 * invalidated when the server reboots. Already-open browsers fall back
 * to a stale token; the renderer detects the resulting 401 and forces
 * a full reload to pick up the new HTML / new meta tag.
 */

import type { Request, Response, NextFunction } from 'express'
import type { IncomingMessage } from 'http'
import { timingSafeEqual } from 'crypto'

const TOKEN_HEADER = 'x-kovitoboard-token'
const TOKEN_QUERY_KEY = 'token'

/**
 * Origin allowlist regex. Matches:
 *   http://localhost:<port>
 *   http://127.0.0.1:<port>
 *
 * Port is required because both supervisor children always bind to a
 * concrete port. https / IPv6 [::1] are intentionally excluded — the
 * supervisor does not serve over them today and adding them would
 * widen the trust set without a corresponding need.
 */
const ALLOWED_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/

/**
 * Resolve the expected per-launch token from the environment, throwing
 * if it is missing. Called once at server boot — `kb-start.mjs` (the
 * supervisor) is the canonical injection point. If the server is
 * launched outside the supervisor (e.g. for an ad-hoc unit test) the
 * caller must set `KB_LAUNCH_TOKEN` explicitly; we refuse to start
 * with a generated fallback to avoid normalizing a degraded mode.
 */
export function resolveLaunchTokenOrThrow(): string {
  const token = process.env.KB_LAUNCH_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'KB_LAUNCH_TOKEN is missing. The supervisor (tools/kb-start.mjs) ' +
        'must set this env var before spawning the server. Direct ' +
        'launches must export it manually.',
    )
  }
  return token
}

/**
 * Constant-time comparison so that an attacker cannot probe the token
 * byte-by-byte from response timing. Returns false on length mismatch
 * (without allocating a same-length buffer to compare against, which
 * would itself be a side channel).
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
 * Validate the `Origin` header when present. An absent `Origin` is
 * considered out-of-band (curl, programmatic test runner) and deferred
 * to the token check; that is consistent with how browsers themselves
 * treat same-origin GETs. A present `Origin` that does not match the
 * loopback allowlist is rejected outright.
 */
function originAllowed(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return true
  return ALLOWED_ORIGIN_RE.test(origin)
}

/**
 * Express middleware factory. The expected token is captured at
 * construction time so the per-request hot path stays cheap.
 */
export function createTokenAndOriginGuard(expectedToken: string) {
  return function verifyTokenAndOrigin(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin
    if (!originAllowed(origin)) {
      res.status(403).json({ error: 'Origin not allowed' })
      return
    }
    const headerValue = req.headers[TOKEN_HEADER]
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
    if (!tokensMatch(headerToken, expectedToken)) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    next()
  }
}

/**
 * Verify a WebSocket upgrade request. `ws` calls this from
 * `WebSocketServer({ verifyClient })` before invoking the connection
 * handler; returning `false` causes the upgrade to be rejected with
 * the supplied status code.
 *
 * Browsers cannot attach custom headers to the upgrade, so the token
 * is supplied via the query string (`/api/ws?token=<token>`). Origin
 * is honoured the same way as for HTTP — the renderer is served from
 * a loopback origin, and any other origin is by construction
 * malicious in the local-first model.
 */
export function createWsClientVerifier(expectedToken: string) {
  return function verifyClient(
    info: { origin: string; req: IncomingMessage; secure: boolean },
    cb: (verified: boolean, code?: number, message?: string) => void,
  ): void {
    if (!originAllowed(info.origin)) {
      cb(false, 403, 'Origin not allowed')
      return
    }
    // Parse query string from the request URL. `info.req.url` looks
    // like `/api/ws?token=...`; we do not assume any particular base
    // since `URL` requires one.
    const rawUrl = info.req.url ?? ''
    const queryIdx = rawUrl.indexOf('?')
    let queryToken: string | undefined
    if (queryIdx >= 0) {
      const params = new URLSearchParams(rawUrl.slice(queryIdx + 1))
      queryToken = params.get(TOKEN_QUERY_KEY) ?? undefined
    }
    if (!tokensMatch(queryToken, expectedToken)) {
      cb(false, 401, 'Authentication required')
      return
    }
    cb(true)
  }
}

/**
 * Test seam: re-export the constants for unit tests so they can build
 * synthetic requests / origins without re-deriving the rules.
 */
export const __testing = {
  TOKEN_HEADER,
  TOKEN_QUERY_KEY,
  ALLOWED_ORIGIN_RE,
}
