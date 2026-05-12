/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture bridge — implementation of `window.kb.capture.<kind>`.
 *
 * The v0.2.0 opt-in mechanism (Phase 1 prompt-injection ①) splits
 * its verification across three layers: the recipe parser refuses
 * undeclared kinds, the install-warning dialog records the user's
 * consent on the manifest, and `/api/app/capture/<kind>` enforces
 * both on every runtime call. This module is the client-side glue
 * that turns `window.kb.capture.a11y()` calls inside a recipe page
 * into the right HTTP request.
 *
 * Per `app-directory-extension.md` v1.2 §10.5.2 the server side is
 * authoritative — the in-memory `approvedCaptures` cache below
 * exists only to give recipe authors an early throw on obvious
 * rejections rather than a server round-trip. The bridge always
 * defers the final accept decision to the server.
 *
 * @stable v0.2.0
 */

import type { RendererLogger } from './logger'

/**
 * Capture kinds the v0.2.x bridge knows about. Mirrors the server-
 * side `CaptureKind` enum so both halves of the opt-in check share
 * a single source of truth.
 */
export type CaptureKind = 'a11y' | 'exposed-context'

interface CaptureBridgeOptions {
  appId: string
  /**
   * Optional client-side cache of `manifest.approvedCaptures`.
   *
   * - **Omitted** (`undefined`): the bridge does not short-circuit;
   *   every call defers to the server-side gate. v0.2.x runs in
   *   this mode by default because there is no client-facing
   *   manifest fetch yet — `RecipePageHost` only knows the appId.
   *   This still satisfies `app-directory-extension.md` v1.2 §10.5.2
   *   ("client side check is the auxiliary; server side verification
   *   is authoritative") because the server enforces the gate
   *   unconditionally.
   * - **Provided** (possibly empty): the bridge throws
   *   `CaptureNotApprovedError` on the spot for any kind not in the
   *   array, saving a round-trip. An empty array therefore refuses
   *   every kind locally — appropriate for callers that already
   *   know the user declined every capability.
   */
  approvedCaptures?: readonly CaptureKind[]
  log: RendererLogger
}

/**
 * Build the recipe-scoped `kb.capture` surface. The returned object
 * is consumed by `injectKb` and surfaces on `window.kb.capture`
 * while a recipe page is mounted.
 *
 * Each method:
 *   1. Short-circuits with a typed error when the client cache says
 *      the kind is not in `manifest.approvedCaptures`.
 *   2. Otherwise POSTs to `/api/app/capture/<kind>` with the active
 *      appId in the body. The server runs the canonical 5-step
 *      verification (`http-api-contract.md` v1.3 §10.6.3).
 *   3. Resolves on 204 and throws a structured error on every other
 *      status, including the `CaptureNotApproved` / `CaptureNotDeclared`
 *      / `NoActiveRecipe` 403 paths.
 */
export function createCaptureBridge(opts: CaptureBridgeOptions): {
  a11y: () => Promise<void>
  exposedContext: () => Promise<void>
} {
  const { appId, approvedCaptures, log } = opts
  // `undefined` means "the caller has no cache; defer everything to
  // the server"; an array (even empty) opts the bridge into the
  // fast-path refusal.
  const approvedSet =
    approvedCaptures === undefined ? null : new Set<CaptureKind>(approvedCaptures)

  async function callServer(kind: CaptureKind): Promise<void> {
    // Local fast-path. The bridge cache is opportunistic — it lets
    // recipe code surface "you forgot to ask for this capability"
    // without paying for a server round-trip — but the server is
    // still consulted for the success branch so a stale cache cannot
    // bypass the gate. We mirror the server error shape here so
    // catch-blocks can branch on `error.code` regardless of whether
    // the rejection came from the cache or the network.
    if (approvedSet !== null && !approvedSet.has(kind)) {
      const err = new CaptureNotApprovedError(kind, appId)
      log.warn({ kind, appId }, `capture ${kind}: refused by client-side guard`)
      throw err
    }

    // Server is authoritative. Even if the cache says "approved", we
    // ask the server so a manifest update between page load and the
    // call is not silently honoured.
    let response: Response
    try {
      response = await fetch(`/api/app/capture/${encodeURIComponent(kind)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId }),
      })
    } catch (err) {
      // Network failure (offline, DNS, abort). Wrap so recipe authors
      // can branch on `instanceof CaptureNetworkError`.
      log.warn({ kind, appId, err }, `capture ${kind}: network error`)
      throw new CaptureNetworkError(kind, err)
    }

    if (response.status === 204) {
      // Spec contract: 204 No Content on the success path. The
      // actual snapshot / payload still travels via the in-process
      // accessors (captureAccessibilitySnapshot / getExposedContext);
      // the bridge merely confirms the gate passed.
      return
    }

    // Parse the structured 403 envelope so the caller can dispatch
    // on the error code rather than HTTP status alone. Fall back to
    // a generic error if the body is unexpectedly empty / malformed
    // so we never throw a less informative shape than the server
    // emitted.
    let body: Record<string, unknown> = {}
    try {
      body = (await response.json()) as Record<string, unknown>
    } catch {
      // Empty / invalid JSON. Keep `body` empty.
    }
    const code = typeof body.error === 'string' ? body.error : 'CaptureFailed'
    const message =
      typeof body.message === 'string'
        ? body.message
        : `Capture call failed with HTTP ${response.status}`
    log.warn(
      { kind, appId, status: response.status, code },
      `capture ${kind}: refused by server`,
    )
    throw new CaptureRejectedError(code, message, response.status)
  }

  return {
    a11y: () => callServer('a11y'),
    exposedContext: () => callServer('exposed-context'),
  }
}

/**
 * Thrown when the client-side cache refuses a capture call before it
 * reaches the network. The thrown error mirrors the structured 403
 * the server would have emitted so existing catch-blocks need only
 * handle a single error shape.
 */
export class CaptureNotApprovedError extends Error {
  readonly code = 'CaptureNotApproved'
  readonly kind: CaptureKind
  readonly appId: string

  constructor(kind: CaptureKind, appId: string) {
    super(`Capture '${kind}' is not approved for this recipe (appId: ${appId}).`)
    this.name = 'CaptureNotApprovedError'
    this.kind = kind
    this.appId = appId
  }
}

/**
 * Thrown when the server-side gate refuses the call. Wraps the
 * structured envelope (`error` + `message` + `details`) the server
 * emitted so recipe authors can branch on `error.code` instead of
 * regex'ing the message.
 */
export class CaptureRejectedError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'CaptureRejectedError'
    this.code = code
    this.status = status
  }
}

/**
 * Thrown when the underlying fetch fails before the server could
 * respond. The `cause` field carries the original error so the
 * caller can introspect it (e.g. distinguish AbortError from a DNS
 * failure).
 */
export class CaptureNetworkError extends Error {
  readonly code = 'CaptureNetworkError'
  readonly cause: unknown

  constructor(kind: CaptureKind, cause: unknown) {
    super(`Capture '${kind}' failed to reach the server`)
    this.name = 'CaptureNetworkError'
    this.cause = cause
  }
}
