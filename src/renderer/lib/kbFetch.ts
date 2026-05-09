/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-launch authentication helpers for the renderer.
 *
 * The supervisor (`tools/kb-start.mjs`) mints a fresh token at every
 * launch — including SIGUSR2-driven restarts — and the Vite plugin
 * (`vite.config.ts`) / Express prod fallback (`src/server/index.ts`)
 * embed that token in `index.html` as `<meta name="kb-launch-token">`.
 * The renderer reads it once at module init time and:
 *
 *   - `kbFetch(...)` adds an `X-Kovitoboard-Token` header to every
 *     same-origin `/api/*` request the UI makes, so the server's auth
 *     middleware accepts the call. Cross-origin URLs and non-`/api`
 *     paths are forwarded without the header so the launch token is
 *     never sent to an unintended destination.
 *   - `appendLaunchTokenQuery(...)` rewrites a WebSocket URL to
 *     include `?token=<token>` for the upgrade handshake (browsers
 *     cannot attach custom headers to a WS upgrade).
 *
 * 401 handling is bounded by a one-shot reload: the helper retries via
 * a single full-page reload (so the renderer re-reads the freshly
 * minted token from the new HTML), then surfaces a fatal bootstrap
 * error if the next request still fails. Without that bound, a broken
 * token bootstrap would put the page into an endless reload loop.
 */

const META_TAG_NAME = 'kb-launch-token'
const RELOAD_MARKER_KEY = 'kb:launch-token-reload-attempted'
const API_PREFIX = '/api'

let cachedToken: string | null = null

/**
 * Per-document guard so that several in-flight 401s scheduled in the
 * same tick cannot stack multiple reloads on top of each other.
 * `sessionStorage` (see `RELOAD_MARKER_KEY`) is what guards across
 * reloads — this one only matters within a single document.
 */
let reloadScheduled = false

/**
 * Read the per-launch token from the DOM. The `<meta>` tag is set by
 * the Vite plugin in dev and by the Express prod fallback in
 * production; both insert exactly the same hex string. Cached after
 * the first lookup because the value cannot change without a full
 * page reload (which itself re-reads the freshly served HTML).
 */
export function getLaunchToken(): string {
  if (cachedToken !== null) return cachedToken
  if (typeof document === 'undefined') {
    cachedToken = ''
    return cachedToken
  }
  const el = document.querySelector<HTMLMetaElement>(`meta[name="${META_TAG_NAME}"]`)
  cachedToken = el?.content ?? ''
  return cachedToken
}

/**
 * Decide whether the launch token should ride along with this
 * particular request. The token is a bearer credential for our own
 * Express middleware; sending it to anything other than the local
 * Express API would either leak it or upset CORS preflight. The
 * helper API accepts the same `RequestInfo | URL` shape as the
 * platform `fetch`, so we normalise each variant against the document
 * origin first. Anything we cannot parse — Symbol-keyed shims, broken
 * relative URLs without a `location.origin` — is forwarded without
 * the header rather than throwing, because callers reasonably treat
 * `kbFetch` as a drop-in replacement for `fetch`.
 */
function shouldAttachToken(input: RequestInfo | URL): boolean {
  if (typeof location === 'undefined') return false
  let target: URL
  try {
    if (typeof input === 'string') {
      target = new URL(input, location.origin)
    } else if (input instanceof URL) {
      target = input
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      target = new URL(input.url, location.origin)
    } else {
      return false
    }
  } catch {
    return false
  }
  return target.origin === location.origin && target.pathname.startsWith(API_PREFIX)
}

function readReloadMarker(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_MARKER_KEY) === '1'
  } catch {
    return false
  }
}

function writeReloadMarker(): void {
  try {
    sessionStorage.setItem(RELOAD_MARKER_KEY, '1')
  } catch {
    /* sessionStorage unavailable (Safari private mode, sandboxed iframe) */
  }
}

function clearReloadMarker(): void {
  try {
    sessionStorage.removeItem(RELOAD_MARKER_KEY)
  } catch {
    /* sessionStorage unavailable */
  }
}

/**
 * Mount a minimal fatal-error overlay so that an operator hitting the
 * "two 401s in a row" path actually sees the failure mode instead of a
 * blank screen. The overlay deliberately does not fetch i18n strings
 * (a fetch is the very thing that just failed) and does not import
 * React (this file must stay framework-agnostic so unit tests can
 * import it without bootstrapping a renderer).
 */
function showFatalBootstrapError(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('kb-bootstrap-error')) return
  const overlay = document.createElement('div')
  overlay.id = 'kb-bootstrap-error'
  overlay.setAttribute('role', 'alert')
  overlay.style.cssText =
    'position:fixed;inset:0;background:#1f2937;color:#f9fafb;z-index:2147483647;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'padding:24px;font-family:system-ui,sans-serif;text-align:center;'
  const heading = document.createElement('h1')
  heading.textContent = 'KovitoBoard authentication failed'
  heading.style.cssText = 'font-size:20px;margin:0 0 12px;'
  const detail = document.createElement('p')
  detail.textContent =
    'The renderer could not authenticate against the local server even after a reload. Restart KovitoBoard from a terminal (npm start) and reopen this tab.'
  detail.style.cssText = 'max-width:520px;line-height:1.5;margin:0;'
  overlay.appendChild(heading)
  overlay.appendChild(detail)
  if (document.body) {
    document.body.appendChild(overlay)
  } else {
    document.documentElement.appendChild(overlay)
  }
}

function handleStaleTokenResponse(): void {
  if (reloadScheduled) return
  if (typeof location === 'undefined') return
  reloadScheduled = true
  if (readReloadMarker()) {
    // We already reloaded once and still get 401 → either the meta
    // tag substitution is broken or the token format check at boot is
    // failing. Reloading again would just spin; surface a fatal error
    // overlay instead so the operator can act.
    showFatalBootstrapError()
    return
  }
  writeReloadMarker()
  setTimeout(() => {
    try {
      location.reload()
    } catch {
      /* noop — test environment without a real navigation API */
    }
  }, 0)
}

/**
 * `fetch` wrapper that automatically attaches the per-launch token
 * header for same-origin `/api/*` requests. Other than the header,
 * the call is forwarded verbatim: existing callers can switch from
 * `fetch(url, init)` to `kbFetch(url, init)` without restructuring
 * `init`. If the caller supplies a `headers` object that already sets
 * the token (e.g. for a unit test), our value takes precedence —
 * the production token is the one the server expects.
 *
 * A 401 response is treated as a stale-token signal: the supervisor
 * rotates the launch token on every restart, so an already-open
 * renderer keeps using the previous value after a SIGUSR2-driven
 * restart and every API call lands as 401 until the document is
 * reloaded. We schedule a single full-page reload the first time we
 * see 401 — the new HTML carries the new meta tag, and subsequent
 * fetches resume normally. The `RELOAD_MARKER_KEY` in `sessionStorage`
 * stops a broken bootstrap from looping; if a 401 happens after a
 * reload has already taken place the helper renders a fatal error
 * overlay instead of reloading again. We do not reload on 403
 * (Origin-allowlist failures are configuration bugs, not stale-token
 * symptoms).
 *
 * The marker is cleared on the first successful response so a later
 * supervisor restart in the same browser session can still recover
 * via one reload.
 */
export function kbFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined)
  if (shouldAttachToken(input)) {
    headers.set('X-Kovitoboard-Token', getLaunchToken())
  }
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      handleStaleTokenResponse()
    } else if (res.ok) {
      // A normal request succeeded after a reload — clear the marker
      // so a future SIGUSR2 restart can again recover via one reload.
      clearReloadMarker()
    }
    return res
  })
}

/**
 * Append `?token=<token>` (or `&token=<token>` when the URL already
 * has a query string) to a WebSocket URL. The server's
 * `verifyWsClient` reads the same key during the upgrade handshake.
 */
export function appendLaunchTokenQuery(wsUrl: string): string {
  const token = getLaunchToken()
  if (!token) return wsUrl
  const separator = wsUrl.includes('?') ? '&' : '?'
  return `${wsUrl}${separator}token=${encodeURIComponent(token)}`
}

/**
 * Test seam: lets unit tests reset the cached token between cases so
 * they can simulate a fresh page load without recreating the DOM.
 */
export function __resetTokenCacheForTests(): void {
  cachedToken = null
  reloadScheduled = false
}

/**
 * Test seam: exposed only so unit tests can drive the same-origin /
 * `/api` filter without re-deriving the rules.
 */
export const __testing = {
  shouldAttachToken,
  RELOAD_MARKER_KEY,
}
