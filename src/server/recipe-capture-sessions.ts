/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture-token store (v0.2.0 Phase 1 ①, spec v1.6 §6.10.6).
 *
 * The capture endpoint runtime gate
 * (`/api/app/capture/<kind>`) historically derived the active
 * `appId` from `req.body.appId`, which let a recipe page bypass
 * its own `window.kb.capture.*` closure and authorise capture
 * calls under another app's identity (cross-app capability theft —
 * PR #30 attempt 3 CodeX HIGH `authorization bypass`).
 *
 * This module closes that gap by minting a short-lived, per-recipe
 * launch-scoped token at mount time. `captureBridge.ts` caches the
 * token in a closure (NEVER `localStorage` / `sessionStorage`,
 * I-CR4 SSOT) and attaches it to every `/api/app/capture/<kind>`
 * call as `X-KB-Capture-Token`. The server resolves the token to
 * an authoritative `appId`, ignoring `req.body.appId` entirely.
 * On unmount the bridge revokes the token; KB process termination
 * discards the entire store (I-CR5).
 *
 * Design choices
 * --------------
 * - **In-memory only.** A `Map<token, { appId, issuedAt, expiresAt }>`
 *   lives in this module. The supervisor restart wipes the map; a
 *   token captured before reboot is invalidated automatically
 *   without per-token revocation tracking. Spec v1.6 §6.10.6.2
 *   forbids persistence (I-CR5).
 *
 * - **Ten-minute TTL.** Recipe page mount lifetime is typically
 *   minutes; ten minutes gives ample slack for UI switches without
 *   leaving a credential live forever in an idle tab. Spec v1.6
 *   §6.10.6.3.
 *
 * - **Window-scoped reuse.** The same token is reused across
 *   `window.kb.capture.*` calls in one mount (single-use would
 *   force a network round-trip per call). Spec v1.6 §6.10.6.3
 *   table row.
 *
 * - **Bounded memory.** Issuance always prunes expired entries
 *   first, then refuses with `{ error: 'StoreFull' }` if the live
 *   count would exceed `MAX_ACTIVE_TOKENS`. Mirrors
 *   `recipe-install-sessions.ts` shape.
 *
 * - **No background timer.** Pruning is on-demand at issue /
 *   consume time. A periodic timer would keep the Node event loop
 *   alive in tests and offers no security upside (stale entries
 *   are filtered at consume time anyway).
 *
 * @see recipe-system.md v1.6 §6.10.6
 * @see http-api-contract.md v1.4 §10.6.7
 * @see app-directory-extension.md v1.3 §10.5.2 (client-side cache)
 * @stable v0.2.0
 */

import { randomBytes } from 'crypto'

/**
 * Maximum number of live capture tokens at any given time. Sized to
 * the simultaneous-mount upper bound and matches the existing
 * install-session ceiling so both stores share a DoS posture.
 */
export const MAX_ACTIVE_TOKENS = 256

/**
 * Token TTL (10 minutes). Mount lifetime is typically much shorter;
 * the value just keeps capture authorisation usable across long
 * UI sessions without expiring mid-action.
 */
export const TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * Token entropy in bytes. 16 → 128 bits, hex-encoded into 32
 * lowercase characters (mirrors `KB_LAUNCH_TOKEN` / `installNonce`).
 */
const TOKEN_BYTES = 16

/** Wire-level token format check (spec §6.10.6.2). */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

interface CaptureTokenRecord {
  appId: string
  issuedAt: number
  expiresAt: number
}

const store: Map<string, CaptureTokenRecord> = new Map()

export type IssueCaptureTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'StoreFull' }

/**
 * Mint a fresh capture token for the given `appId` and register it
 * in the store. Callers verify `appId` syntax + manifest existence
 * before invoking — this function trusts the value verbatim.
 *
 * Returns `{ ok: false, reason: 'StoreFull' }` when the live count
 * reaches {@link MAX_ACTIVE_TOKENS} even after sweeping expired
 * entries; the EP layer maps that to a 503 response (spec v1.4
 * §10.6.7.1).
 */
export function issueCaptureToken(appId: string): IssueCaptureTokenResult {
  const now = Date.now()
  sweepExpiredTokens(now)
  if (store.size >= MAX_ACTIVE_TOKENS) {
    return { ok: false, reason: 'StoreFull' }
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  store.set(token, {
    appId,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  })
  return { ok: true, token, expiresAt: now + TOKEN_TTL_MS }
}

export type ConsumeCaptureTokenResult =
  | { ok: true; appId: string; record: CaptureTokenRecord }
  | { ok: false; reason: 'invalid' | 'expired' }

/**
 * Look up a token. Differs from {@link consumeInstallSession}:
 * capture tokens are window-scoped and reused across calls in one
 * mount, so the entry is **not** removed on lookup. Expired entries
 * are deleted lazily so subsequent lookups can branch on the
 * difference between "never minted" and "minted but expired".
 *
 * Returns:
 *   - `{ ok: true, appId, record }` on a live hit.
 *   - `{ ok: false, reason: 'invalid' }` when the input is malformed
 *     or has never been issued. Same envelope as a store miss so
 *     attackers cannot distinguish "wrong format" from "wrong
 *     value" via timing.
 *   - `{ ok: false, reason: 'expired' }` when the entry exists but
 *     `expiresAt < now`; the entry is removed before returning.
 *
 * The caller maps the `reason` field to the corresponding
 * `capture-token-*` audit-log reason and 403 envelope (spec v1.4
 * §10.6.4).
 */
export function consumeCaptureToken(
  token: unknown,
): ConsumeCaptureTokenResult {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'invalid' }
  }
  const now = Date.now()
  const record = store.get(token)
  if (!record) {
    return { ok: false, reason: 'invalid' }
  }
  if (record.expiresAt <= now) {
    store.delete(token)
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, appId: record.appId, record }
}

/**
 * Remove a token from the store. Idempotent — the caller can
 * revoke the same token twice (typical of React useEffect cleanup
 * races) and the second call simply returns `false`.
 *
 * Returns `true` when the entry was present, `false` otherwise.
 */
export function revokeCaptureToken(token: unknown): boolean {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return false
  }
  return store.delete(token)
}

/**
 * Drop every entry whose `expiresAt` has passed. Returns the number
 * of entries removed so callers (the `_test/*` test seam, observers)
 * can confirm the sweep ran. Invoked implicitly by
 * {@link issueCaptureToken}; explicit invocation is mainly for the
 * unit tests.
 */
export function sweepExpiredTokens(now: number = Date.now()): number {
  let removed = 0
  for (const [token, record] of store) {
    if (record.expiresAt <= now) {
      store.delete(token)
      removed += 1
    }
  }
  return removed
}

/**
 * Test seam. Production code never resets the store — supervisor
 * restart wipes it for free — but unit tests need a clean slate
 * between cases. Mirrors `recipe-install-sessions.ts`.
 */
export function __resetForTests(): void {
  store.clear()
}

/** Test seam — exposes the current live count. */
export function __sizeForTests(): number {
  return store.size
}

/** Test seam — exposes the configured cap so tests can drive
 *  the boundary explicitly. */
export const __MAX_ACTIVE_TOKENS_FOR_TESTS = MAX_ACTIVE_TOKENS
