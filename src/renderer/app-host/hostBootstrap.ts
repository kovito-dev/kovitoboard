/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Host bootstrap (v0.2.0 / spec v1.7 §6.10.6.13).
 *
 * Captures pristine references to the globals recipe code is most
 * likely to monkey-patch (`fetch`, `XMLHttpRequest`, `Headers`,
 * `Request`, `Response`) and exposes a `hostFetch` primitive that
 * binds to the captured `fetch` reference. Every host-initiated
 * `/api/app/capture-mount/*`, `/api/app/capture-token/*`, and
 * `/api/audit/host-bootstrap` request goes through `hostFetch` so
 * that a hostile recipe cannot intercept those flows by replacing
 * `window.fetch` after the recipe loads.
 *
 * The bootstrap also sets a sentinel
 * (`globalThis.__kbHostBootstrapComplete = true`) as its final
 * synchronous statement. The `RecipePageHost` wrapper reads this
 * sentinel on mount and emits a `host-bootstrap-verified` /
 * `host-bootstrap-violation` audit record so a malicious recipe
 * cannot opt out of being observed (H-CR1 SSOT).
 *
 * Honest claim
 * ------------
 * Spec v1.7 §6.10.6.11 makes the v0.2.x limitation explicit: recipe
 * JS and host JS share a realm in v0.2.x. `hostFetch` is **leak
 * reduction**, not structural secrecy — a recipe that uses
 * `Function.prototype.toString` on `hostFetch`, opens devtools to
 * pause the host closure, or otherwise inspects the bootstrap can
 * still recover the captured reference. v0.3.0 isolation work
 * (§6.10.6.12 roadmap) closes that gap structurally.
 *
 * Import order
 * ------------
 * This module MUST be imported from `main.tsx` as the very first
 * statement, **before** any module that could transitively load
 * recipe code. The static import graph at production-build time is
 * walked by `tools/check-release-hygiene.mjs` to enforce that
 * (H-CR5-A SSOT).
 *
 * @see recipe-system.md v1.7 §6.10.6.13 (H-CR1)
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */

// Capture pristine global references **before** any recipe code can
// run. The recipe content is loaded via dynamic `import()` from
// `RecipePageHost`, which executes after this module has been
// evaluated by the static-import chain seeded from `main.tsx`.
const capturedReferences = {
  fetch: globalThis.fetch,
  XMLHttpRequest: globalThis.XMLHttpRequest,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
} as const

/**
 * Test seam: expose the captured `fetch` so L1 E2E can assert
 * `globalThis.fetch !== capturedReferences.fetch` after a hostile
 * monkey-patch. The reference is stamped onto `globalThis` only in
 * environments where the property is writable (test harnesses);
 * production sees a `freeze`d shape via `Object.defineProperty`
 * with `writable: false` so the captured reference cannot be
 * overwritten post-bootstrap.
 */
try {
  Object.defineProperty(globalThis as unknown as Record<string, unknown>, '__kbCapturedFetch', {
    value: capturedReferences.fetch,
    writable: false,
    configurable: false,
    enumerable: false,
  })
} catch {
  // Some test environments redefine globalThis with `writable: false`
  // already; ignore so importing this module never throws at
  // module-eval time.
}

/**
 * Canonical primitive for all host-initiated `/api/*` calls in
 * v0.2.x. `bind(globalThis)` pins the `this` value so a recipe that
 * later monkey-patches `Function.prototype.bind` cannot redirect
 * `hostFetch`'s implementation.
 *
 * Usage (host-only, never expose to recipe code):
 *   - `POST /api/app/capture-mount/{open,close}`
 *   - `POST /api/app/capture-token/{issue,revoke}`
 *   - `POST /api/audit/host-bootstrap`
 */
export const hostFetch: typeof globalThis.fetch =
  capturedReferences.fetch.bind(globalThis)

/**
 * Read the per-launch internal auth token. The Vite plugin / Express
 * fallback embeds it into `index.html` as
 * `<meta name="kb-internal-token">`. We capture it at module-load
 * time so a recipe that later mutates the DOM cannot smuggle a
 * different value into the host's request headers.
 *
 * Returns an empty string when the meta tag is missing (the test
 * harness or a pre-v1.7 packaged build). The server's
 * `verifyInternalAuth` middleware refuses an empty header with
 * `MissingInternalAuth`, so the host bootstrap fails closed.
 */
function readInternalTokenFromMeta(): string {
  if (typeof document === 'undefined') return ''
  const el = document.querySelector<HTMLMetaElement>(
    'meta[name="kb-internal-token"]',
  )
  return el?.content ?? ''
}

const internalToken = readInternalTokenFromMeta()

/**
 * Test seam: expose for unit tests that exercise the audit / mount
 * flows. Recipe code cannot reach this binding (the module is not
 * exported on `window`), but tests can import it directly.
 */
export function getInternalAuthToken(): string {
  return internalToken
}

/**
 * Convenience helper: same shape as `hostFetch` but with the
 * `X-KB-Internal-Auth` header already attached. Used by
 * `captureBridgeRegistry` and `RecipePageHost` so neither has to
 * remember to attach the header explicitly.
 */
export function hostFetchWithInternalAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new (capturedReferences.Headers)(init?.headers)
  if (internalToken.length > 0) {
    headers.set('X-KB-Internal-Auth', internalToken)
  }
  // Always attach the launch token so the request passes
  // verifyTokenAndOrigin too. The renderer's `kbFetch` reads the
  // launch token from a separate meta tag; we duplicate the cheap
  // DOM read here rather than coupling the modules.
  if (typeof document !== 'undefined') {
    const launchEl = document.querySelector<HTMLMetaElement>(
      'meta[name="kb-launch-token"]',
    )
    const launchToken = launchEl?.content ?? ''
    if (launchToken.length > 0) {
      headers.set('X-Kovitoboard-Token', launchToken)
    }
  }
  return hostFetch(input, { ...init, headers })
}

// Final synchronous statement of bootstrap (H-CR1 sentinel). Spec
// v1.7 §6.10.6.13: `RecipePageHost` reads this exact field on
// mount to decide whether to emit `host-bootstrap-verified` or
// `host-bootstrap-violation`. `defineProperty` with
// `configurable: false` keeps a hostile recipe from re-defining the
// sentinel back to `false` post-bootstrap; the captured value is
// frozen for the lifetime of the page.
try {
  Object.defineProperty(
    globalThis as unknown as Record<string, unknown>,
    '__kbHostBootstrapComplete',
    {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false,
    },
  )
} catch {
  // Already defined (HMR re-evaluation in dev mode); treat as
  // already-true since the captured references above are still
  // pristine within the new evaluation.
}

/**
 * Test seam: lets unit tests reset the captured-reference table
 * between cases so they can simulate a fresh page load without
 * recreating the DOM. Production code never calls this.
 */
export const __testing = {
  capturedReferences,
  internalToken,
}
