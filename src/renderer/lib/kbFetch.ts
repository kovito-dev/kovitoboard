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
 *     HTTP request the UI makes, so the server's auth middleware
 *     accepts the call.
 *   - `appendLaunchTokenQuery(...)` rewrites a WebSocket URL to
 *     include `?token=<token>` for the upgrade handshake (browsers
 *     cannot attach custom headers to a WS upgrade).
 *
 * Both helpers fail closed: an empty / missing token still produces
 * a request, and the server simply rejects it with 401, which the
 * caller surfaces as a startup-time error rather than silently
 * masking the misconfiguration.
 */

const META_TAG_NAME = 'kb-launch-token'

let cachedToken: string | null = null

/**
 * One-shot guard for the post-restart full-page reload triggered by a
 * stale-token 401. Multiple in-flight fetches that all fail with 401
 * must not all schedule a reload, otherwise the page bounces several
 * times in quick succession before the new HTML can finish loading.
 * Set to `true` the first time we react to a 401 and never reset for
 * the remainder of this document's lifetime — the reload itself
 * replaces the document, which gives us a fresh module instance with
 * `false` again.
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
 * `fetch` wrapper that automatically attaches the per-launch token
 * header. Other than the header, the call is forwarded verbatim:
 * existing callers can switch from `fetch(url, init)` to
 * `kbFetch(url, init)` without restructuring `init`. If the caller
 * supplies a `headers` object that already sets the token (e.g. for a
 * unit test), our value takes precedence — the production token is
 * the one the server expects.
 *
 * A 401 response is treated as a stale-token signal: the supervisor
 * rotates the launch token on every restart, so an already-open
 * renderer keeps using the previous value after a SIGUSR2-driven
 * restart and every API call lands as 401 until the document is
 * reloaded. We schedule a single full-page reload the first time we
 * see 401 — the new HTML carries the new meta tag, and subsequent
 * fetches resume normally. The guard `reloadScheduled` avoids
 * stacking multiple reloads when many in-flight requests all fail at
 * once. We do not reload on 403 (Origin-allowlist failures are
 * configuration bugs, not stale-token symptoms).
 */
export function kbFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined)
  headers.set('X-Kovitoboard-Token', getLaunchToken())
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401 && !reloadScheduled && typeof location !== 'undefined') {
      reloadScheduled = true
      // Defer the reload so the awaiting `.then` chain can observe the
      // 401 (some callers branch on status code before the reload
      // navigation actually replaces the document).
      setTimeout(() => {
        try {
          location.reload()
        } catch {
          /* noop — running in a test environment without a real document */
        }
      }, 0)
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
}
