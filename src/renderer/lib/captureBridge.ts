/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe-visible capture bridge — implementation of
 * `window.kb.capture.<kind>` (v0.2.0 / spec v1.7 §6.10.6 / v1.4
 * §10.5.2).
 *
 * The v0.2.0 opt-in mechanism (Phase 1 prompt-injection ①) splits
 * its verification across four layers:
 *
 *   - declaration (`manifest.captureRequires`)
 *   - consent (`manifest.approvedCaptures`)
 *   - source authentication (per-recipe-page capture token, v1.7
 *     §6.10.6 / I-CR4)
 *   - enforcement (server router at `/api/app/capture/<kind>`)
 *
 * This module is the **recipe-visible** surface. It receives an
 * initial `mountId` + `token` as closure parameters at mount time
 * (set up by `injectKb`); it never reaches the host-only EPs
 * (`/api/app/capture-mount/*`, `/api/app/capture-token/*`)
 * directly. When the cached token expires the bridge asks the
 * host-only `captureBridgeRegistry` for a refresh; the registry
 * holds `KB_INTERNAL_TOKEN` in a closure recipe code cannot reach
 * (I-CR4 / I-CR6 / I-CR7).
 *
 * Per spec v1.4.1 §10.5.2 "server-side 403 reception", token-related
 * 403s (`capture-token-missing` / `-invalid` / `-expired` /
 * `mount-not-found` / `no-matching-manifest`) collapse into
 * `CaptureNotApprovedError` on the client so attackers cannot use
 * the error code as a token oracle. The technical reason is
 * preserved via the log line but not surfaced to recipe code.
 *
 * @stable v0.2.0
 */

import { kbFetch } from './kbFetch'
import type { RendererLogger } from './logger'
import type { CaptureKindValue } from '../../shared/recipe-types'
import {
  registerBridge,
  unregisterBridge,
  requestRefresh,
  RestartReloadError,
  type BridgeHandle,
} from '../app-host/captureBridgeRegistry'

/**
 * Capture kinds the v0.2.x bridge knows about.
 *
 * Aliases the canonical {@link CaptureKindValue} declared in
 * `src/shared/recipe-types.ts` so the parser, the install
 * validator, the server-side capture router, and this client-side
 * runtime guard all reference the same closed enum.
 */
export type CaptureKind = CaptureKindValue

/**
 * Public surface of the recipe-scoped capture bridge.
 *
 * Recipe code reaches `a11y` / `exposedContext` on
 * `window.kb.capture`. `dispose()` is host-only — called from
 * `injectKb`'s cleanup function.
 */
export interface CaptureBridge {
  a11y: () => Promise<void>
  exposedContext: () => Promise<void>
  /**
   * Unregister from the registry. Idempotent. Called from the
   * `injectKb` cleanup function.
   */
  dispose: () => void
}

/**
 * Bridge state at construction time.
 *   - `pending` — `injectKb` has fired `openMount()` but the result
 *     has not arrived yet. Capture calls short-circuit to the opaque
 *     `CaptureNotApprovedError` so a recipe author cannot fingerprint
 *     the bootstrap timing.
 *   - `live` — `openMount()` returned `{ kind: 'live' }` and a token
 *     was issued. Capture calls use the cached token + can refresh
 *     via the registry.
 *   - `grandfather` — `openMount()` returned `{ kind: 'grandfather' }`
 *     because the recipe declared no `captureRequires`. Calls
 *     short-circuit to `CaptureNotDeclaredError` (the true grandfather
 *     diagnostic).
 *   - `open-failed` — `openMount()` returned `{ kind: 'failed', ... }`
 *     because of a network / quota / auth failure. Calls short-circuit
 *     to `CaptureNotApprovedError`, same as `pending`, so the opaque
 *     envelope still hides the failure mode from the recipe.
 */
export type CaptureBridgeState =
  | 'pending'
  | 'live'
  | 'grandfather'
  | 'open-failed'

export interface CaptureBridgeOptions {
  appId: string
  /**
   * Bridge state at construction time. Defaults to `pending` for
   * backward compatibility — bridges that supply `mountId` but no
   * explicit state are treated as `live`.
   */
  state?: CaptureBridgeState
  /**
   * Server-issued mount identity from
   * `POST /api/app/capture-mount/open`. Required when `state` is
   * `'live'`; ignored otherwise.
   */
  mountId: string | null
  /**
   * Initial capture token from `POST /api/app/capture-token/issue`.
   * Required when `state` is `'live'`; ignored otherwise.
   */
  initialToken: string | null
  /**
   * Optional client-side cache of `manifest.captureRequires`. Used
   * to short-circuit the declaration step before any network
   * round-trip.
   */
  captureRequires?: readonly CaptureKind[]
  /**
   * Optional client-side cache of `manifest.approvedCaptures`. Used
   * to short-circuit the consent step.
   */
  approvedCaptures?: readonly CaptureKind[]
  log: RendererLogger
}

interface PendingCall {
  reject: (err: unknown) => void
}

/**
 * Build the recipe-scoped `kb.capture` surface.
 *
 * The returned object is consumed by `injectKb` and surfaces on
 * `window.kb.capture` while a recipe page is mounted.
 */
export function createCaptureBridge(opts: CaptureBridgeOptions): CaptureBridge {
  const { appId, mountId, initialToken, captureRequires, approvedCaptures, log } = opts
  // Resolve the bridge state. The legacy two-argument form
  // (`mountId, initialToken`) is preserved so existing call sites
  // do not break: a non-null `mountId` implies `live`; explicit
  // `null` defaults to `pending` (the recipe-friendly opaque envelope)
  // but callers can override with `grandfather` / `open-failed`.
  const state: CaptureBridgeState =
    opts.state !== undefined
      ? opts.state
      : mountId !== null
        ? 'live'
        : 'pending'
  const declaredSet =
    captureRequires === undefined ? null : new Set<CaptureKind>(captureRequires)
  const approvedSet =
    approvedCaptures === undefined ? null : new Set<CaptureKind>(approvedCaptures)

  /**
   * Mount-lifetime closure for the capture token. `null` means
   * "no token available — fail-fast every capture call" (grandfather
   * recipe or open-mount failure). The token is intentionally NOT
   * placed on `window`, `localStorage`, or any other DOM-readable
   * surface (I-CR4).
   */
  let cachedToken: string | null = initialToken

  /**
   * Pending capture call rejections so the restart-recovery path
   * can bounce in-flight Promises with `RestartReloadError` rather
   * than letting them resolve against a stale internal token.
   */
  const pendingCalls: Set<PendingCall> = new Set()

  let registered = false
  let disposed = false

  // Only register live bridges with the host registry. Pending /
  // grandfather / open-failed bridges have no `mountId` to anchor
  // refresh callbacks against; the registry would either reject the
  // registration (no mountId) or silently accept a null key, neither
  // of which buys anything for those states.
  if (state === 'live' && mountId !== null) {
    const handle: BridgeHandle = {
      mountId,
      appId,
      setToken: (token) => {
        cachedToken = token
      },
      rejectPending: (err) => {
        for (const pending of pendingCalls) {
          try {
            pending.reject(err)
          } catch {
            /* noop */
          }
        }
        pendingCalls.clear()
      },
    }
    registerBridge(handle)
    registered = true
  }

  async function callServer(kind: CaptureKind): Promise<void> {
    // Local fast-path on the declaration / consent caches. Step
    // order matches the server (declaration first, consent second)
    // so recipe authors see the same diagnostic regardless of
    // which side refused.
    if (declaredSet !== null && !declaredSet.has(kind)) {
      log.warn({ kind, appId }, `capture ${kind}: refused by client-side guard (not declared)`)
      throw new CaptureNotDeclaredError(kind, appId)
    }
    if (approvedSet !== null && !approvedSet.has(kind)) {
      log.warn({ kind, appId }, `capture ${kind}: refused by client-side guard (not approved)`)
      throw new CaptureNotApprovedError(kind, appId)
    }

    // State-aware short-circuits. Spec v1.7 §6.10.6.11 honest-claim
    // SSOT + PR #30 attempt 5 CodeX MEDIUM finding: only the true
    // grandfather state maps to `CaptureNotDeclaredError`. The
    // `pending` state (capture call landed before the host bootstrap
    // resolved `openMount()`) and the `open-failed` state (network
    // / quota / restart) BOTH refuse with the opaque
    // `CaptureNotApprovedError` so recipe code cannot time-fingerprint
    // the bootstrap phase. The mount-result mutator in `injectKb` is
    // responsible for swapping `pending` to `live` / `grandfather` /
    // `open-failed` once the network call returns.
    if (state === 'grandfather') {
      log.warn(
        { kind, appId },
        `capture ${kind}: refused by client-side guard (grandfather-no-capture)`,
      )
      throw new CaptureNotDeclaredError(kind, appId)
    }
    if (state !== 'live' || mountId === null) {
      log.warn(
        { kind, appId, state },
        `capture ${kind}: refused by client-side guard (${state})`,
      )
      throw new CaptureNotApprovedError(kind, appId)
    }

    if (cachedToken === null) {
      log.warn(
        { kind, appId, mountId },
        `capture ${kind}: refused by client-side guard (no token)`,
      )
      throw new CaptureNotApprovedError(kind, appId)
    }

    return invokeOnceWithRefresh(kind, cachedToken)
  }

  async function invokeOnceWithRefresh(
    kind: CaptureKind,
    tokenAtCallTime: string,
  ): Promise<void> {
    const initialResult = await postCaptureCall(kind, tokenAtCallTime)
    if (initialResult.kind === 'ok') return
    if (initialResult.kind === 'fatal') throw initialResult.error

    // 403 capture-token-* → ask the host registry for a refresh.
    // The registry deduplicates concurrent refreshes for the same
    // mountId, so even a recipe page that fires many parallel
    // captures only triggers one server-side `/issue`. We retry the
    // call exactly once; if the refresh fails or the retry refuses
    // again, the caller sees `CaptureNotApprovedError`.
    if (mountId === null || state !== 'live') {
      throw new CaptureNotApprovedError(kind, appId)
    }
    const newToken = await requestRefresh(mountId, log)
    if (newToken === null) {
      throw new CaptureNotApprovedError(kind, appId)
    }
    cachedToken = newToken
    const retryResult = await postCaptureCall(kind, newToken)
    if (retryResult.kind === 'ok') return
    if (retryResult.kind === 'fatal') throw retryResult.error
    // Still token-shape after one refresh → give up.
    throw new CaptureNotApprovedError(kind, appId)
  }

  type CaptureCallResult =
    | { kind: 'ok' }
    | { kind: 'token-stale' }
    | { kind: 'fatal'; error: Error }

  async function postCaptureCall(
    kind: CaptureKind,
    token: string,
  ): Promise<CaptureCallResult> {
    let response: Response
    try {
      response = await kbFetch(
        `/api/app/capture/${encodeURIComponent(kind)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // I-CR4: the token is the only field that establishes
            // app identity on the wire. Do NOT pass `appId` in the
            // body — `req.body.appId` is ignored on the server side
            // precisely to prevent cross-app capability theft.
            'x-kb-capture-token': token,
          },
          body: '{}',
        },
      )
    } catch (err) {
      log.warn({ kind, appId, err }, `capture ${kind}: network error`)
      return { kind: 'fatal', error: new CaptureNetworkError(kind, err) }
    }

    if (response.status === 204) {
      return { kind: 'ok' }
    }

    let body: Record<string, unknown> = {}
    try {
      body = (await response.json()) as Record<string, unknown>
    } catch {
      /* empty / invalid JSON */
    }
    const code = typeof body.error === 'string' ? body.error : 'CaptureFailed'
    const message =
      typeof body.message === 'string'
        ? body.message
        : `Capture call failed with HTTP ${response.status}`
    const details =
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : {}
    const serverReason =
      typeof details.reason === 'string' ? details.reason : null

    log.warn(
      { kind, appId, status: response.status, code, serverReason },
      `capture ${kind}: refused by server`,
    )

    // Spec `app-directory-extension.md` v1.4.1 §10.5.2 "server-side
    // 403 reception": token-shape failures are token-stale signals,
    // not authoritative refusals. Surface them as `token-stale` so
    // the caller can request a refresh + retry once. Other failures
    // are fatal.
    if (
      serverReason === 'capture-token-missing' ||
      serverReason === 'capture-token-invalid' ||
      serverReason === 'capture-token-expired' ||
      serverReason === 'mount-not-found'
    ) {
      return { kind: 'token-stale' }
    }
    if (serverReason === 'no-matching-manifest') {
      // The recipe was uninstalled mid-session. There is nothing the
      // bridge can recover; collapse to the opaque error.
      return {
        kind: 'fatal',
        error: new CaptureNotApprovedError(kind, appId),
      }
    }

    if (code === 'CaptureNotDeclared') {
      return {
        kind: 'fatal',
        error: new CaptureNotDeclaredError(kind, appId),
      }
    }
    if (code === 'CaptureNotApproved') {
      return {
        kind: 'fatal',
        error: new CaptureNotApprovedError(kind, appId),
      }
    }
    return {
      kind: 'fatal',
      error: new CaptureRejectedError(code, message, response.status),
    }
  }

  function trackPending<T>(
    promise: Promise<T>,
    rejectRef: (err: unknown) => void,
  ): Promise<T> {
    const entry: PendingCall = { reject: rejectRef }
    pendingCalls.add(entry)
    return promise.finally(() => {
      pendingCalls.delete(entry)
    })
  }

  function wrapCall(kind: CaptureKind): () => Promise<void> {
    return () => {
      let captureReject: (err: unknown) => void = () => {}
      const promise = new Promise<void>((resolve, reject) => {
        captureReject = reject
        callServer(kind).then(resolve, (err) => {
          if (err instanceof RestartReloadError) {
            reject(err)
          } else {
            reject(err)
          }
        })
      })
      return trackPending(promise, captureReject)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (registered && mountId !== null) {
      unregisterBridge(mountId)
    }
    // Clear any pending refs so a late restart-recovery does not
    // try to reject again into a dead bridge.
    pendingCalls.clear()
  }

  return {
    a11y: wrapCall('a11y'),
    exposedContext: wrapCall('exposed-context'),
    dispose,
  }
}

/**
 * Thrown when the client-side cache refuses a capture call at the
 * declaration step (step 3, `manifest.captureRequires`) or when
 * the grandfather skip blocks the call before the token round-trip.
 */
export class CaptureNotDeclaredError extends Error {
  readonly code = 'CaptureNotDeclared'
  readonly kind: CaptureKind
  readonly appId: string

  constructor(kind: CaptureKind, appId: string) {
    super(`Capture '${kind}' is not declared by this recipe (appId: ${appId}).`)
    this.name = 'CaptureNotDeclaredError'
    this.kind = kind
    this.appId = appId
  }
}

/**
 * Thrown when the client-side cache or the server-side gate
 * refuses a capture call at the consent step (step 4,
 * `manifest.approvedCaptures`), or when the token round-trip
 * failed for any reason. The shared error code keeps the token
 * mechanism from leaking structural information to recipe authors.
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
 * Thrown when the server-side gate refuses the call with a reason
 * other than the token-shape / declaration / consent family.
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
 * respond.
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

// Re-export RestartReloadError so recipe authors can branch on the
// error name without importing from `captureBridgeRegistry` (a
// host-only module they should not depend on directly).
export { RestartReloadError }
