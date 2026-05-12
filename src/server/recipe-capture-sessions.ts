/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture-token store (v0.2.0 Phase 1 ①, spec v1.7 §6.10.6).
 *
 * The capture endpoint runtime gate
 * (`/api/app/capture/<kind>`) historically derived the active
 * `appId` from `req.body.appId`. PR #30 attempts 3 and 4 surfaced
 * two layered CodeX HIGH `authorization bypass` findings:
 *   - attempt 3: capture-side `req.body.appId` forgery → fix was
 *     "carry a server-issued capture token in
 *     `X-KB-Capture-Token`" (v1.6).
 *   - attempt 4: issuance-side `req.body.appId` forgery on
 *     `/api/app/capture-token/issue` → fix is "mint identity at
 *     `/capture-mount/open` first, then issue tokens against the
 *     resulting `mountId`" (v1.7, this module).
 *
 * The token record now stores both `mountId` and `appId` so the
 * capture endpoint can resolve the appId in one lookup without
 * going through `mountStore` again. The `mountId` is the authority;
 * an out-of-band uninstall race that drops the mount also flushes
 * the matching token via the `/capture-mount/close` atomic delete
 * (H-CR4).
 *
 * Per-mount idempotency
 * ---------------------
 * Spec v1.7 §6.10.6.4 step 4 requires that a second `/issue` against
 * the same `mountId` atomically replaces the existing token. A
 * `mountIdToToken` reverse index keeps that replacement in a single
 * synchronous slice — `withCriticalSection` wraps the four
 * critical-section handlers so the build-time atomicity lint can
 * verify the absence of `await` / Promise chaining.
 *
 * Design choices
 * --------------
 * - **In-memory only.** `Map<token, record>` + `Map<mountId, token>`.
 *   Both wipe on KB process termination (I-CR5).
 *
 * - **Ten-minute TTL.** Matches the mount TTL so the two stores have
 *   synchronised lifetimes; close drops both atomically (H-CR4).
 *
 * - **Window-scoped reuse.** A live token is reused across
 *   `window.kb.capture.*` calls in one mount — single-use would
 *   force a network round-trip per call.
 *
 * - **Bounded memory.** Issuance always prunes expired entries
 *   first, then refuses with `StoreFull` if the live count would
 *   exceed `MAX_ACTIVE_TOKENS`.
 *
 * @see recipe-system.md v1.7 §6.10.6 (I-CR4〜I-CR8 + H-CR1〜H-CR5)
 * @see http-api-contract.md v1.5 §10.6.7.3
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.2.0
 */

import { randomBytes } from 'crypto'

/**
 * Cap on simultaneously-live capture tokens. Matches the global
 * mount cap (`MAX_ACTIVE_MOUNTS_GLOBAL = 64`) because of the 1:1
 * mount→token relationship enforced by per-mount idempotency.
 */
export const MAX_ACTIVE_TOKENS = 64

/**
 * Token TTL (10 minutes). Matches the mount TTL so the two
 * lifetimes are synchronised; mount close drops both atomically.
 */
export const TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * Token entropy in bytes. 16 → 128 bits, hex-encoded into 32
 * lowercase characters (mirrors `KB_LAUNCH_TOKEN` /
 * `KB_INTERNAL_TOKEN` / `installNonce`).
 */
const TOKEN_BYTES = 16

/** Wire-level token format check (spec §6.10.6.2). */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

export interface CaptureTokenRecord {
  /** Server-issued mount identity that bound this token. Authority source. */
  mountId: string
  /** Cached for fast capture-endpoint lookup; sourced from the mount record at issue time. */
  appId: string
  issuedAt: number
  expiresAt: number
}

/**
 * Primary store: token → record.
 */
const tokenStore: Map<string, CaptureTokenRecord> = new Map()

/**
 * Reverse index for per-mount idempotency (H-CR4). When `/issue` is
 * called twice against the same mountId, the second call must
 * atomically replace the first token; the reverse index makes the
 * old token reachable from the mount without iterating the whole
 * store.
 */
const mountIdToToken: Map<string, string> = new Map()

/**
 * Spec v1.7 §6.10.6.15 (H-CR4): the four critical-section handlers
 * (`/capture-mount/{open,close}` and `/capture-token/{issue,revoke}`)
 * mutate the store within a **single synchronous JS execution
 * slice** — no `await`, no `.then`, no `setImmediate`,
 * no `process.nextTick`. The build-time atomicity lint
 * (`tools/check-release-hygiene.mjs`) enforces the absence of those
 * constructs inside the handler bodies; `withCriticalSection` is the
 * documentation marker the lint scopes against.
 *
 * Production callers go through `withCriticalSection` so future
 * maintainers see the intent at the call site even if the lint is
 * temporarily disabled.
 */
export function withCriticalSection<R>(scope: string, fn: () => R): R {
  // No await, no Promise wrapping, no microtask scheduling. The
  // function body invokes fn() immediately within the same
  // synchronous tick. `scope` is unused at runtime but kept in the
  // signature so call sites name the critical section for the lint
  // to verify.
  void scope
  return fn()
}

export interface IssueCaptureTokenInput {
  /** Server-issued mount identity (from `/capture-mount/open`). */
  mountId: string
  /** Cached for fast capture-endpoint lookup; from the mount record. */
  appId: string
}

export type IssueCaptureTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'StoreFull' }

/**
 * Mint a fresh capture token bound to the given `mountId` + `appId`
 * (the caller is responsible for verifying both fields came out of
 * `mountStore.get()` rather than `req.body.appId`, I-CR4).
 *
 * Per-mount idempotency: a second call against the same `mountId`
 * atomically replaces the existing token (H-CR4 SSOT).
 *
 * Returns `{ ok: false, reason: 'StoreFull' }` only when the live
 * count would exceed {@link MAX_ACTIVE_TOKENS} even after replacing
 * an existing entry for the same mountId (the replacement itself
 * does not grow the store).
 */
export function issueCaptureToken(
  input: IssueCaptureTokenInput,
): IssueCaptureTokenResult {
  return withCriticalSection('issueCaptureToken', () => {
    const now = Date.now()
    sweepExpiredTokens(now)

    // Per-mount idempotency: atomically drop the existing token (if
    // any) before checking the cap. The replacement does not count
    // against the cap.
    const existingToken = mountIdToToken.get(input.mountId)
    if (existingToken !== undefined) {
      tokenStore.delete(existingToken)
      mountIdToToken.delete(input.mountId)
    }

    if (tokenStore.size >= MAX_ACTIVE_TOKENS) {
      return { ok: false, reason: 'StoreFull' }
    }

    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const expiresAt = now + TOKEN_TTL_MS
    tokenStore.set(token, {
      mountId: input.mountId,
      appId: input.appId,
      issuedAt: now,
      expiresAt,
    })
    mountIdToToken.set(input.mountId, token)
    return { ok: true, token, expiresAt }
  })
}

export type ConsumeCaptureTokenResult =
  | { ok: true; mountId: string; appId: string; record: CaptureTokenRecord }
  | { ok: false; reason: 'invalid' | 'expired' }

/**
 * Look up a token. The entry is **not** removed on a live hit —
 * capture tokens are window-scoped and reused across calls in one
 * mount. Expired entries are deleted lazily so subsequent lookups
 * can branch on "never minted" vs "minted but expired".
 *
 * Returns:
 *   - `{ ok: true, mountId, appId, record }` on a live hit.
 *   - `{ ok: false, reason: 'invalid' }` on malformed input or store
 *     miss (same envelope so attackers cannot distinguish "wrong
 *     format" from "wrong value" via timing).
 *   - `{ ok: false, reason: 'expired' }` when `expiresAt < now`; the
 *     entry is removed before returning.
 *
 * The caller maps the `reason` field to the corresponding
 * `capture-token-*` audit-log reason and 403 envelope.
 */
export function consumeCaptureToken(
  token: unknown,
): ConsumeCaptureTokenResult {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'invalid' }
  }
  const now = Date.now()
  const record = tokenStore.get(token)
  if (!record) {
    return { ok: false, reason: 'invalid' }
  }
  if (record.expiresAt <= now) {
    tokenStore.delete(token)
    if (mountIdToToken.get(record.mountId) === token) {
      mountIdToToken.delete(record.mountId)
    }
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, mountId: record.mountId, appId: record.appId, record }
}

/**
 * Remove a token from the store. Idempotent — a double-revoke
 * during React cleanup races is harmless.
 *
 * Returns `true` when the entry was present, `false` otherwise.
 */
export function revokeCaptureToken(token: unknown): boolean {
  return withCriticalSection('revokeCaptureToken', () => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return false
    }
    const record = tokenStore.get(token)
    if (!record) return false
    tokenStore.delete(token)
    if (mountIdToToken.get(record.mountId) === token) {
      mountIdToToken.delete(record.mountId)
    }
    return true
  })
}

/**
 * Atomically drop the token bound to the given mountId.
 *
 * Called by `/capture-mount/close` after closing the mount entry,
 * so the mountStore + tokenStore mutations land in the same
 * synchronous slice (H-CR4 SSOT). The mount-close handler invokes
 * this inside its own `withCriticalSection`; the helper here also
 * wraps so direct callers (tests, the periodic sweep) get the same
 * documentation guarantee.
 *
 * Returns `true` when a matching token existed, `false` otherwise.
 */
export function revokeCaptureTokenByMountId(mountId: unknown): boolean {
  return withCriticalSection('revokeCaptureTokenByMountId', () => {
    if (typeof mountId !== 'string') return false
    const token = mountIdToToken.get(mountId)
    if (token === undefined) return false
    tokenStore.delete(token)
    mountIdToToken.delete(mountId)
    return true
  })
}

/**
 * Drop every entry whose `expiresAt` has passed. Returns the number
 * of entries removed.
 */
export function sweepExpiredTokens(now: number = Date.now()): number {
  let removed = 0
  for (const [token, record] of tokenStore) {
    if (record.expiresAt <= now) {
      tokenStore.delete(token)
      if (mountIdToToken.get(record.mountId) === token) {
        mountIdToToken.delete(record.mountId)
      }
      removed += 1
    }
  }
  return removed
}

/**
 * Test seam. Production code never resets the stores — supervisor
 * restart wipes them for free — but unit tests need a clean slate.
 */
export function __resetForTests(): void {
  tokenStore.clear()
  mountIdToToken.clear()
}

/** Test seam — current live token count. */
export function __sizeForTests(): number {
  return tokenStore.size
}

/** Test seam — exposes the configured cap so tests can drive the boundary. */
export const __MAX_ACTIVE_TOKENS_FOR_TESTS = MAX_ACTIVE_TOKENS
