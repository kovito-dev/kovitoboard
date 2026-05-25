/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-recipe-page mount-identity store
 * (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6).
 *
 * PR #30 attempt 4 surfaced a CodeX HIGH `authorization bypass`
 * finding: the previous design issued capture tokens against
 * `req.body.appId`, so a recipe page A could mint a token under
 * `recipe-b`'s identity and bypass the cross-app gate the token
 * mechanism was meant to install.
 *
 * The trusted-host-mediated identity design (spec v1.7) closes that
 * gap by making the **server** the source of truth for the active
 * recipe identity. The host renderer asks for a fresh `mountId` at
 * `RecipePageHost` mount time through
 * `POST /api/app/capture-mount/open` (guarded by `verifyInternalAuth`
 * so recipe code cannot mint identities). The server records the
 * mount in this in-memory map, keyed by mountId, and the capture
 * token endpoint reads the appId from the record rather than from
 * caller-supplied input (I-CR4 / I-CR6).
 *
 * Design choices
 * --------------
 * - **In-memory only.** A `Map<mountId, MountRecord>` lives in this
 *   module. KB process termination wipes the map (I-CR5).
 *
 * - **Per-app quota + global cap.** Spec v1.7 §6.10.6.3 fixes
 *   `MAX_ACTIVE_MOUNTS_PER_APP = 8` (~60% headroom over heaviest
 *   observed multi-panel recipe = 5) and `MAX_ACTIVE_MOUNTS_GLOBAL
 *   = 64` (8 apps × 8 panels each). A hostile recipe can saturate
 *   its own slot but cannot starve other apps (residual C in
 *   §6.10.6.11, bounded DoS).
 *
 * - **Ten-minute TTL.** Matches the capture-token TTL so the two
 *   stores have synchronised lifetimes; mount close drops both
 *   simultaneously (H-CR4 atomicity).
 *
 * - **Lazy cleanup.** Expired entries are dropped on every lookup
 *   and on insert via {@link sweepExpiredMounts}. No background
 *   timer keeps the Node event loop alive in tests.
 *
 * - **Synchronous mutations.** All store mutations sit inside the
 *   handler's synchronous JS execution slice (H-CR4); the build-time
 *   lint gate enforces the absence of `await` / Promise chaining in
 *   the four handlers (`/capture-mount/{open,close}` and
 *   `/capture-token/{issue,revoke}`).
 *
 * @see recipe-system.md v1.7 §6.10.6 (I-CR4〜I-CR8 + H-CR1〜H-CR5)
 * @see http-api-contract.md v1.5 §10.6.7.1〜§10.6.7.2
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */

import { randomBytes } from 'crypto'

/**
 * Per-app cap. Observed usage: typical recipe = 1 panel /
 * RecipePageHost; multi-panel sample (research-reports) = 2-4
 * panels; heaviest observed = 5 panels. `8` is ~60% headroom and
 * matches spec v1.7 §6.10.6.3.
 */
export const MAX_ACTIVE_MOUNTS_PER_APP = 8

/**
 * Global cap. 8 apps × 8 panels each = 64 max concurrent mounts.
 * The renderer's React tree becomes the bottleneck well before this
 * point.
 */
export const MAX_ACTIVE_MOUNTS_GLOBAL = 64

/**
 * Mount TTL (10 minutes). Matches the capture-token TTL so the two
 * lifetimes are synchronised — close drops both atomically (H-CR4).
 */
export const MOUNT_TTL_MS = 10 * 60 * 1000

/** Mount-id entropy in bytes. 16 → 128 bits, hex-encoded into 32 chars. */
const MOUNT_ID_BYTES = 16

/** Wire-level mount-id format check (spec §6.10.6.2 — same as launch token). */
export const MOUNT_ID_PATTERN = /^[0-9a-f]{32}$/

/** Retry-After window communicated on 503 responses, in seconds. */
export const MOUNT_QUOTA_RETRY_AFTER_S = 30

export interface MountRecord {
  appId: string
  openedAt: number
  expiresAt: number
}

const store: Map<string, MountRecord> = new Map()

export type OpenMountResult =
  | { ok: true; mountId: string; expiresAt: number }
  | { ok: false; reason: 'PerAppQuotaExceeded' | 'StoreFull' }

/**
 * Mint a fresh `mountId` for the given `appId` and register it in
 * the store. The caller is responsible for verifying that:
 *   - the request passed `verifyTokenAndOrigin` (launch token +
 *     Origin allowlist),
 *   - the request passed `verifyInternalAuth` (host-only gate),
 *   - the appId resolves to an installed manifest, and
 *   - the manifest has at least one declared `captureRequires` entry
 *     (grandfather skip is handled at the route layer before this
 *     function is called).
 *
 * Spec v1.7 §6.10.6.3: the per-app cap is checked **after** an
 * opportunistic sweep so a recipe that closed an old panel can
 * always reopen one. The global cap is checked the same way.
 *
 * Returns `{ ok: false, reason: 'PerAppQuotaExceeded' }` when the
 * appId already has {@link MAX_ACTIVE_MOUNTS_PER_APP} live mounts,
 * `{ ok: false, reason: 'StoreFull' }` when the global cap is hit,
 * `{ ok: true, mountId, expiresAt }` otherwise.
 */
export function openMount(appId: string): OpenMountResult {
  const now = Date.now()
  sweepExpiredMounts(now)

  // Per-app quota: enforce before the global cap so the error
  // surfaced to the client says exactly which limit was hit.
  let perAppCount = 0
  for (const record of store.values()) {
    if (record.appId === appId) {
      perAppCount += 1
    }
  }
  if (perAppCount >= MAX_ACTIVE_MOUNTS_PER_APP) {
    return { ok: false, reason: 'PerAppQuotaExceeded' }
  }

  if (store.size >= MAX_ACTIVE_MOUNTS_GLOBAL) {
    return { ok: false, reason: 'StoreFull' }
  }

  const mountId = randomBytes(MOUNT_ID_BYTES).toString('hex')
  const expiresAt = now + MOUNT_TTL_MS
  store.set(mountId, {
    appId,
    openedAt: now,
    expiresAt,
  })
  return { ok: true, mountId, expiresAt }
}

/**
 * Drop a mount entry. Idempotent — a double-close during React
 * cleanup races is harmless. The companion capture token is dropped
 * by the route handler in the same synchronous slice (H-CR4).
 *
 * Returns `true` when the entry was present, `false` when it was
 * already gone (expired sweep, double-close, never minted).
 */
export function closeMount(mountId: unknown): boolean {
  if (typeof mountId !== 'string' || !MOUNT_ID_PATTERN.test(mountId)) {
    return false
  }
  return store.delete(mountId)
}

export type GetMountResult =
  | { ok: true; appId: string; record: MountRecord }
  | { ok: false; reason: 'invalid' | 'expired' }

/**
 * Look up a mount record. Lazy cleanup: an expired entry is removed
 * before returning so the caller can distinguish between "never
 * opened" and "opened then expired" the same way
 * `consumeCaptureToken` does.
 *
 * Spec v1.7 §6.10.6.4: this is the chain `tokenStore.get → mountId
 * → mountStore.get → appId` used by `capture-routes.ts` step 2.
 * `req.body.appId` is never read on that path (I-CR4).
 */
export function getMount(mountId: unknown): GetMountResult {
  if (typeof mountId !== 'string' || !MOUNT_ID_PATTERN.test(mountId)) {
    return { ok: false, reason: 'invalid' }
  }
  const now = Date.now()
  const record = store.get(mountId)
  if (!record) {
    return { ok: false, reason: 'invalid' }
  }
  if (record.expiresAt <= now) {
    store.delete(mountId)
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, appId: record.appId, record }
}

/**
 * Drop every entry whose `expiresAt` has passed. Returns the number
 * of entries removed so callers (the `_test/*` test seam, the
 * periodic sweep observer) can confirm the sweep ran.
 *
 * Spec v1.7 §6.10.6.3: invoked implicitly by {@link openMount} and
 * {@link getMount}; the route layer also calls it from a periodic
 * 60-second sweep.
 */
export function sweepExpiredMounts(now: number = Date.now()): number {
  let removed = 0
  for (const [mountId, record] of store) {
    if (record.expiresAt <= now) {
      store.delete(mountId)
      removed += 1
    }
  }
  return removed
}

/**
 * Count the number of live mounts for a given appId. Used by tests
 * + by the route layer to surface `currentLimit` in 503 details.
 */
export function countMountsForApp(appId: string): number {
  let count = 0
  for (const record of store.values()) {
    if (record.appId === appId) {
      count += 1
    }
  }
  return count
}

/**
 * Test seam. Production code never resets the store — supervisor
 * restart wipes it for free — but unit tests need a clean slate.
 */
export function __resetForTests(): void {
  store.clear()
}

/** Test seam — current live count. */
export function __sizeForTests(): number {
  return store.size
}

/** Test seam — caps so unit tests do not have to re-derive them. */
export const __MAX_ACTIVE_MOUNTS_PER_APP_FOR_TESTS = MAX_ACTIVE_MOUNTS_PER_APP
export const __MAX_ACTIVE_MOUNTS_GLOBAL_FOR_TESTS = MAX_ACTIVE_MOUNTS_GLOBAL
