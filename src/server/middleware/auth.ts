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
 * Token-stale marker emitted as a `WWW-Authenticate` response header
 * whenever the launch token check fails. The renderer's kbFetch
 * helper reloads the page only when this exact value is present, so
 * a future application-level 401 (e.g. an in-app permission check)
 * can return 401 without accidentally triggering the launch-token
 * reload flow. Format: a bespoke scheme name (`KbLaunchToken`)
 * because launch-token authentication is not RFC 7235 Bearer.
 */
const TOKEN_AUTH_SCHEME = 'KbLaunchToken'

/**
 * Required token shape: 32 lowercase hex characters (128 bits of
 * entropy, the format the supervisor's `randomBytes(16).toString('hex')`
 * produces). Validating the format at boot lets us treat the token as
 * a safe substring when it is later interpolated into the index.html
 * meta tag, which is otherwise a HTML/JS injection vector if a
 * misconfigured operator points `KB_LAUNCH_TOKEN` at attacker-controlled
 * text. The regex does not need to be timing-safe — it runs once at
 * startup, never against user input.
 */
const TOKEN_FORMAT_RE = /^[0-9a-f]{32}$/

/**
 * Build the exact-origin allowlist for this launch from the env vars
 * the supervisor (`tools/kb-start.mjs`) already feeds the server:
 *
 *   - `PORT`      — the Express backend port the renderer's HTTP /
 *                   WebSocket calls land on directly.
 *   - `VITE_PORT` — the dev-mode frontend port that proxies through
 *                   Vite into the same backend.
 *
 * Direct launches (`npm run prod`) only set `PORT`; that is fine
 * because there is no Vite dev server in that mode. Ad-hoc / test
 * launches that set neither still get the historical default of
 * `3001` (the value `src/server/index.ts` falls through to when
 * `process.env.PORT` is missing) so a supervisor-less `tsx` run does
 * not reject every request out of the gate.
 *
 * Each port is expanded to the three loopback hostnames a browser
 * can plausibly produce — `localhost`, `127.0.0.1`, and the IPv6
 * `[::1]` — because OS-level resolution of `localhost` varies. https
 * is intentionally excluded; the supervisor does not serve TLS.
 *
 * Resolved once at boot. Adding a new port at runtime would require a
 * server restart, which is consistent with how the rest of the
 * launch contract behaves (token, PID, project root all baked at
 * boot too).
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const

function buildAllowedOriginSet(): Set<string> {
  const ports = new Set<string>()
  const backendPort = (process.env.PORT ?? '').trim()
  const vitePort = (process.env.VITE_PORT ?? '').trim()
  if (backendPort) ports.add(backendPort)
  if (vitePort) ports.add(vitePort)
  if (ports.size === 0) {
    ports.add('3001')
  }
  const origins = new Set<string>()
  for (const port of ports) {
    for (const host of LOOPBACK_HOSTS) {
      origins.add(`http://${host}:${port}`)
    }
  }
  return origins
}

const ALLOWED_ORIGINS = buildAllowedOriginSet()

/**
 * Resolve the expected per-launch token from the environment, throwing
 * if it is missing or malformed. Called once at server boot —
 * `kb-start.mjs` (the supervisor) is the canonical injection point.
 * If the server is launched outside the supervisor (e.g. for an
 * ad-hoc unit test) the caller must set `KB_LAUNCH_TOKEN` explicitly;
 * we refuse to start with a generated fallback to avoid normalizing
 * a degraded mode.
 *
 * The format is enforced (32 lowercase hex chars) so the token can
 * be safely interpolated into the index.html meta tag downstream.
 * Anything else — empty, partial hex, longer string, characters
 * outside `[0-9a-f]` — would either compromise the entropy assumption
 * or open an HTML/JS injection vector at the meta-tag substitution
 * site, so we fail closed.
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
  if (!TOKEN_FORMAT_RE.test(token)) {
    throw new Error(
      'KB_LAUNCH_TOKEN must be a 32-character lowercase hex string ' +
        '(the supervisor mints it via randomBytes(16).toString("hex")). ' +
        'Ad-hoc launches that hand-set the value must follow the same ' +
        'format to avoid HTML injection at the meta-tag substitution site.',
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
  return ALLOWED_ORIGINS.has(origin)
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
      // The renderer keys its stale-token reload off the
      // `WWW-Authenticate` scheme so that an unrelated 401 from a
      // future per-route permission check can coexist without
      // bouncing the page back to a full reload.
      res.setHeader('WWW-Authenticate', TOKEN_AUTH_SCHEME)
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
  ALLOWED_ORIGINS,
  TOKEN_AUTH_SCHEME,
}
