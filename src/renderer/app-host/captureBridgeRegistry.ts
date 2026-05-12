/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Host-only capture bridge registry (v0.2.0 / spec v1.7 §6.10.6).
 *
 * The trusted-host-mediated identity design (PR #30 attempt 4)
 * requires that **only the host renderer** can talk to the
 * `/api/app/capture-mount/*` and `/api/app/capture-token/*`
 * endpoints; the recipe-visible `captureBridge` is forbidden from
 * issuing tokens directly (I-CR4 / I-CR6 / I-CR7).
 *
 * This module is the host-only counterpart of `captureBridge`. It
 * owns:
 *   - `openMount(appId)` — POST /capture-mount/open + /capture-token/issue
 *   - `closeMount(mountId)` — POST /capture-mount/close
 *   - `registerBridge` / `unregisterBridge` — tracks live recipe-page
 *     bridges so token refresh can inject new tokens directly into
 *     the bridge's closure cache and reject pending Promises on KB
 *     restart.
 *   - `requestRefresh(mountId)` — stale-token recovery for a live
 *     bridge. Deduplicates concurrent refresh attempts for the same
 *     mountId so a recipe page that fires many capture calls in
 *     parallel does not stampede the issuance endpoint.
 *   - `__triggerRestartRecovery` — invoked when the host receives an
 *     `InvalidInternalAuth` 401 from any host-only EP, reflecting
 *     that the KB process has restarted with a fresh internal token.
 *
 * The recipe-visible `captureBridge` calls `requestRefresh` through
 * a narrow callback handle (`BridgeHandle`); it never sees the
 * `KB_INTERNAL_TOKEN` and cannot bypass the host-only auth.
 *
 * @see recipe-system.md v1.7 §6.10.6 (I-CR4〜I-CR8 + H-CR1〜H-CR5)
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */

import { hostFetchWithInternalAuth } from './hostBootstrap'
import type { RendererLogger } from '../lib/logger'

/**
 * Result of {@link openMount}. The `kind: 'live'` shape carries the
 * fresh mountId + initial token a recipe-page bridge needs;
 * `'grandfather'` and `'failed'` are both fail-fast paths that the
 * caller propagates into the bridge so capture calls reject without
 * a network round-trip.
 */
export type OpenMountResult =
  | { kind: 'live'; mountId: string; token: string; expiresAt: number }
  | { kind: 'grandfather' }
  | { kind: 'failed'; reason: OpenMountFailureReason }

export type OpenMountFailureReason =
  | 'manifest-not-found'
  | 'mount-quota-per-app'
  | 'mount-store-full'
  | 'token-store-full'
  | 'mount-not-found'
  | 'auth-restart'
  | 'network-error'
  | 'unexpected-response'

/**
 * Per-mount callbacks the registry uses to push a refreshed token
 * back into the recipe-page bridge or to reject pending Promises
 * during restart recovery. Recipe code cannot see these — only the
 * bridge factory holds the closure.
 */
export interface BridgeHandle {
  mountId: string
  appId: string
  /** Replace the cached token in the bridge closure. */
  setToken: (token: string | null) => void
  /** Reject every pending capture Promise with `RestartReloadError`. */
  rejectPending: (err: RestartReloadError) => void
}

/**
 * Thrown into pending capture Promises when the host detects that
 * the KB process has restarted (`InvalidInternalAuth` from a
 * host-only EP). Recipe authors observe this as a typed `Error`
 * with `.code === 'RestartReloadError'` and `.reason === 'kb-restarted'`.
 *
 * Spec v1.7 §6.10.6.14 "Restart-triggered reload contract" Phase 1.
 */
export class RestartReloadError extends Error {
  readonly code = 'RestartReloadError'
  readonly reason: 'kb-restarted'

  constructor(reason: 'kb-restarted' = 'kb-restarted') {
    super('KovitoBoard restarted; reloading recipes.')
    this.name = 'RestartReloadError'
    this.reason = reason
  }
}

const activeBridges: Map<string, BridgeHandle> = new Map()
const pendingRefreshes: Map<string, Promise<string | null>> = new Map()
let restartRecoveryFired = false

/** Test seam — replaces the default `window.location.reload()` call. */
let reloadImpl: () => void = () => {
  if (typeof globalThis === 'undefined') return
  const loc = (globalThis as { location?: { reload: () => void } }).location
  if (loc !== undefined) {
    try {
      loc.reload()
    } catch {
      /* noop — test environment without a real navigation API */
    }
  }
}

/** Test seam — replaces the host-fetch primitive (for unit tests). */
let hostFetchImpl: typeof hostFetchWithInternalAuth = hostFetchWithInternalAuth

/**
 * Set the host-fetch implementation. Used by unit tests to inject a
 * stub without depending on the DOM-resident internal token.
 */
export function __setHostFetchForTests(
  impl: typeof hostFetchWithInternalAuth,
): void {
  hostFetchImpl = impl
}

/** Test seam — replace the reload callback. */
export function __setReloadImplForTests(impl: () => void): void {
  reloadImpl = impl
}

/** Test seam — reset all registry state between tests. */
export function __resetForTests(): void {
  activeBridges.clear()
  pendingRefreshes.clear()
  restartRecoveryFired = false
  reloadImpl = () => {
    if (typeof globalThis === 'undefined') return
    const loc = (globalThis as { location?: { reload: () => void } }).location
    if (loc !== undefined) {
      try {
        loc.reload()
      } catch {
        /* noop */
      }
    }
  }
  hostFetchImpl = hostFetchWithInternalAuth
}

/** Read-only view for tests / observability. */
export function __activeBridgesForTests(): ReadonlyMap<string, BridgeHandle> {
  return activeBridges
}

/**
 * Register a live bridge. The same `mountId` should never be
 * registered twice in a session — server-issued mountIds are
 * fresh-per-mount (spec v1.7.3 §6.10.6.4). Tests rely on this to
 * detect double-mount bugs.
 */
export function registerBridge(handle: BridgeHandle): void {
  if (activeBridges.has(handle.mountId)) {
    // Hostile / accidental double-register. Drop the old handle so
    // refresh callbacks land on the newest closure.
    activeBridges.delete(handle.mountId)
  }
  activeBridges.set(handle.mountId, handle)
}

export function unregisterBridge(mountId: string): void {
  activeBridges.delete(mountId)
}

interface OpenMountServerResponseOk {
  mountId: string | null
  expiresAt: number | null
  reason: 'grandfather-no-capture' | null
}

interface ErrorResponseBody {
  error?: string
  details?: Record<string, unknown>
}

async function postOpenMount(
  appId: string,
  log: RendererLogger,
): Promise<
  | { kind: 'ok'; mountId: string; expiresAt: number }
  | { kind: 'grandfather' }
  | { kind: 'failed'; reason: OpenMountFailureReason }
> {
  let response: Response
  try {
    response = await hostFetchImpl('/api/app/capture-mount/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId }),
    })
  } catch (err) {
    log.warn({ appId, err }, 'capture-mount open: network error')
    return { kind: 'failed', reason: 'network-error' }
  }

  if (response.status === 401) {
    // Either MissingInternalAuth / InvalidInternalAuth (KB restarted)
    // or the server is wedged. Either way, the host bootstrap is
    // ineffective — trigger restart recovery.
    triggerRestartRecovery(log)
    return { kind: 'failed', reason: 'auth-restart' }
  }
  if (response.status === 404) {
    log.warn({ appId, status: response.status }, 'capture-mount open: manifest not found')
    return { kind: 'failed', reason: 'manifest-not-found' }
  }
  if (response.status === 503) {
    let body: ErrorResponseBody = {}
    try {
      body = (await response.json()) as ErrorResponseBody
    } catch {
      /* ignore */
    }
    const reason: OpenMountFailureReason =
      body.error === 'MountQuotaPerAppExceeded'
        ? 'mount-quota-per-app'
        : 'mount-store-full'
    log.warn({ appId, error: body.error }, 'capture-mount open: capacity')
    return { kind: 'failed', reason }
  }
  if (response.status !== 200) {
    log.warn({ appId, status: response.status }, 'capture-mount open: unexpected status')
    return { kind: 'failed', reason: 'unexpected-response' }
  }

  let body: OpenMountServerResponseOk = { mountId: null, expiresAt: null, reason: null }
  try {
    body = (await response.json()) as OpenMountServerResponseOk
  } catch {
    log.warn({ appId }, 'capture-mount open: invalid JSON')
    return { kind: 'failed', reason: 'unexpected-response' }
  }
  if (body.reason === 'grandfather-no-capture' || body.mountId === null) {
    return { kind: 'grandfather' }
  }
  if (typeof body.mountId !== 'string' || typeof body.expiresAt !== 'number') {
    return { kind: 'failed', reason: 'unexpected-response' }
  }
  return { kind: 'ok', mountId: body.mountId, expiresAt: body.expiresAt }
}

async function postIssueToken(
  mountId: string,
  log: RendererLogger,
): Promise<
  | { kind: 'ok'; token: string; expiresAt: number }
  | { kind: 'failed'; reason: OpenMountFailureReason }
> {
  let response: Response
  try {
    response = await hostFetchImpl('/api/app/capture-token/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountId }),
    })
  } catch (err) {
    log.warn({ mountId, err }, 'capture-token issue: network error')
    return { kind: 'failed', reason: 'network-error' }
  }
  if (response.status === 401) {
    let body: ErrorResponseBody = {}
    try {
      body = (await response.json()) as ErrorResponseBody
    } catch {
      /* ignore */
    }
    if (
      body.error === 'MissingInternalAuth' ||
      body.error === 'InvalidInternalAuth'
    ) {
      triggerRestartRecovery(log)
      return { kind: 'failed', reason: 'auth-restart' }
    }
    // MountNotFound (mount was closed between open and issue, race)
    log.warn({ mountId, error: body.error }, 'capture-token issue: mount not found')
    return { kind: 'failed', reason: 'mount-not-found' }
  }
  if (response.status === 503) {
    log.warn({ mountId }, 'capture-token issue: store full')
    return { kind: 'failed', reason: 'token-store-full' }
  }
  if (response.status !== 200) {
    log.warn({ mountId, status: response.status }, 'capture-token issue: unexpected status')
    return { kind: 'failed', reason: 'unexpected-response' }
  }
  let body: { token?: string; expiresAt?: number } = {}
  try {
    body = (await response.json()) as { token?: string; expiresAt?: number }
  } catch {
    log.warn({ mountId }, 'capture-token issue: invalid JSON')
    return { kind: 'failed', reason: 'unexpected-response' }
  }
  if (typeof body.token !== 'string' || typeof body.expiresAt !== 'number') {
    return { kind: 'failed', reason: 'unexpected-response' }
  }
  return { kind: 'ok', token: body.token, expiresAt: body.expiresAt }
}

/**
 * Open a fresh mount identity + initial capture token for the given
 * `appId`. Called from `injectKb` (mount-time orchestration). The
 * returned shape is passed to `createCaptureBridge` as a closure
 * parameter — the bridge never sees the host-only auth.
 */
export async function openMount(
  appId: string,
  log: RendererLogger,
): Promise<OpenMountResult> {
  const mountResult = await postOpenMount(appId, log)
  if (mountResult.kind === 'grandfather') {
    return { kind: 'grandfather' }
  }
  if (mountResult.kind === 'failed') {
    return { kind: 'failed', reason: mountResult.reason }
  }
  const issueResult = await postIssueToken(mountResult.mountId, log)
  if (issueResult.kind === 'failed') {
    // Best-effort close so the mount slot is not leaked.
    void closeMount(mountResult.mountId, log)
    return { kind: 'failed', reason: issueResult.reason }
  }
  return {
    kind: 'live',
    mountId: mountResult.mountId,
    token: issueResult.token,
    expiresAt: issueResult.expiresAt,
  }
}

/**
 * Close the mount identity. Idempotent — calling on an unknown
 * mountId returns silently. The server-side handler atomically
 * drops both the mount entry and the bound capture token (H-CR4).
 */
export async function closeMount(
  mountId: string,
  log: RendererLogger,
): Promise<void> {
  // Drop the registry handle first so a late refresh that has
  // already started can drop its result rather than injecting into
  // a stale bridge.
  activeBridges.delete(mountId)
  try {
    await hostFetchImpl('/api/app/capture-mount/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountId }),
    })
  } catch (err) {
    log.warn({ mountId, err }, 'capture-mount close: network error')
  }
}

/**
 * Best-effort close for the `pagehide` / `beforeunload` path
 * (spec v1.7.2 §6.10.6.3 / v1.5.2 §10.6.7.5).
 *
 * Browsers may cancel a normal `fetch` that is still in flight when
 * the document is unloaded; `keepalive: true` lets the request
 * survive up to ~64 KB of body, which is plenty for our 32-char
 * `mountId`. Without this path, repeated reloads of a mounted
 * recipe will leak `mountStore` and `tokenStore` slots until the
 * 10-minute TTL elapses, consuming the per-app (8) and global (64)
 * caps faster than H-CR3 plans for.
 *
 * The call is fire-and-forget — we drop the registry entry, then
 * issue the request without awaiting it so the unload handler does
 * not block the navigation.
 */
export function closeMountSync(mountId: string, log: RendererLogger): void {
  activeBridges.delete(mountId)
  try {
    // `void` to ignore the returned Promise; the response is not
    // observable from a pagehide handler anyway.
    void hostFetchImpl('/api/app/capture-mount/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountId }),
      // The keepalive flag is what makes this path different from
      // `closeMount` — the browser is allowed to finish the request
      // after the document unloads.
      keepalive: true,
    })
  } catch (err) {
    log.warn({ mountId, err }, 'capture-mount close (keepalive): synchronous error')
  }
}

/**
 * Refresh the cached token for an active bridge. Called by the
 * recipe-visible bridge when it receives a 403 `capture-token-*`
 * from `/api/app/capture/<kind>`. Returns the new token (which the
 * registry has already injected into the bridge closure) or `null`
 * on permanent failure.
 *
 * Concurrent requests for the same `mountId` are deduplicated so a
 * recipe page that fires many capture calls in parallel does not
 * stampede the server.
 */
export async function requestRefresh(
  mountId: string,
  log: RendererLogger,
): Promise<string | null> {
  const existing = pendingRefreshes.get(mountId)
  if (existing !== undefined) return existing
  const promise = (async () => {
    const issueResult = await postIssueToken(mountId, log)
    if (issueResult.kind !== 'ok') return null
    const bridge = activeBridges.get(mountId)
    if (bridge === undefined) {
      // The bridge was unmounted while we were waiting on the
      // network. Drop the freshly-minted token + best-effort revoke
      // so we do not leak a live entry in the server-side store.
      try {
        await hostFetchImpl('/api/app/capture-token/revoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kb-capture-token': issueResult.token,
          },
          body: '{}',
        })
      } catch {
        /* best-effort */
      }
      return null
    }
    bridge.setToken(issueResult.token)
    return issueResult.token
  })()
  pendingRefreshes.set(mountId, promise)
  try {
    return await promise
  } finally {
    pendingRefreshes.delete(mountId)
  }
}

/**
 * Reject every pending capture Promise across all active bridges
 * with `RestartReloadError`, then schedule a single `location.reload()`.
 * Spec v1.7 §6.10.6.14 Phase 1.
 */
function triggerRestartRecovery(log: RendererLogger): void {
  if (restartRecoveryFired) return
  restartRecoveryFired = true
  const error = new RestartReloadError('kb-restarted')
  for (const bridge of activeBridges.values()) {
    try {
      bridge.rejectPending(error)
    } catch (err) {
      log.warn({ mountId: bridge.mountId, err }, 'restart recovery: rejectPending threw')
    }
  }
  log.warn({}, 'KovitoBoard restarted; reloading recipes')
  // Defer the reload one tick so the bridge cleanup has a chance to
  // run and we don't navigate while inside a fetch's response
  // handler (which can dead-lock the call stack on some browsers).
  setTimeout(() => {
    try {
      reloadImpl()
    } catch {
      /* noop */
    }
  }, 0)
}

/** Test seam — drive the restart recovery path explicitly. */
export function __triggerRestartRecoveryForTests(log: RendererLogger): void {
  triggerRestartRecovery(log)
}
