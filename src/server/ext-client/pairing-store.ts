/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * In-memory pairing state for the external-client API
 * (external-client-api.md v1.0 §5.4 / §7.2).
 *
 * Phase 0 keeps everything in process memory and NEVER persists it to
 * disk (U-1): a KB restart drops `allowedExtensionId`, so the user must
 * re-pair. There is at most one paired extension at a time (single
 * slot) and at most one pending pairing code.
 *
 * The pairing code is a 128-bit, single-use, short-lived secret. It is
 * the only authentication material the `/pair` route accepts (the
 * launch token has not been handed to the extension yet — chicken /
 * egg). It is compared with `timingSafeEqual` and expires after a TTL.
 *
 * On a successful pairing this store also mints a per-pairing
 * `refreshSecret` (128-bit, §5.4 / §7.2.4 / (c1)): an origin-independent
 * second factor that `POST /token/refresh` requires in ADDITION to the
 * present-Origin exact-match (first factor). It is held in a single slot
 * paired one-to-one with `allowedExtensionId` (same lifecycle: minted on
 * pairing, replaced on re-pairing overwrite, dropped on KB shutdown /
 * `reset()`), is NEVER persisted, and — unlike the launch token — does
 * NOT rotate while the KB process lives (per-pairing stable). It closes
 * the S12 actor class: a different extension can DNR-spoof the `Origin`
 * but cannot read the legitimate extension's `storage.local` to learn
 * the refresh secret, so it is always rejected at the second factor.
 *
 * This store owns ONLY the pairing handshake state. Session ownership
 * (owned-session registry, launch correlation) lives in
 * `ownership-registry.ts`; the two are wired together in `index.ts`
 * (re-pairing overwrite clears both — §7.2.1).
 */
import { randomBytes, timingSafeEqual } from 'crypto'

/** Pairing code TTL: 5 minutes (§7.2.3). */
export const PAIRING_CODE_TTL_MS = 300_000

interface PendingPairingCode {
  code: string
  expiresAt: number
}

export type PairResult =
  | { ok: true; extensionId: string; refreshSecret: string }
  | { ok: false; reason: 'no-active-pairing' | 'expired' | 'mismatch' }

export class PairingStore {
  /** The single paired extension id, or `null` when unpaired. */
  private allowedExtensionId: string | null = null
  /**
   * The per-pairing refresh secret paired one-to-one with
   * `allowedExtensionId`, or `null` when unpaired (§5.4 / §7.2.4 / (c1)).
   */
  private refreshSecret: string | null = null
  /** The single pending pairing code, or `null` when none is active. */
  private pending: PendingPairingCode | null = null
  /** Injectable clock for deterministic tests. */
  private readonly now: () => number
  /** Injectable secret minter for deterministic tests. */
  private readonly mintSecret: () => string

  constructor(opts?: { now?: () => number; mintSecret?: () => string }) {
    this.now = opts?.now ?? Date.now
    this.mintSecret = opts?.mintSecret ?? defaultMintSecret
  }

  /** Currently paired extension id (`null` when unpaired). */
  getAllowedExtensionId(): string | null {
    return this.allowedExtensionId
  }

  /**
   * Constant-time check that `presented` equals the current per-pairing
   * `refreshSecret` (§7.2.4 second factor / (c1)). Returns `false` when
   * unpaired (no secret) or on any length / value mismatch. The presented
   * value comes from an untrusted `POST /token/refresh` body, so the
   * compare is timing-safe even though a mismatch is the common case.
   */
  verifyRefreshSecret(presented: unknown): boolean {
    if (this.refreshSecret === null) return false
    if (typeof presented !== 'string') return false
    return timingSafeStringEqual(presented, this.refreshSecret)
  }

  /**
   * Mint a fresh pending pairing code, overwriting any existing pending
   * code (§7.2.3: at most one). Returns the plaintext code so the
   * renderer can display it. Does NOT change `allowedExtensionId`.
   */
  issuePairingCode(): string {
    const code = randomBytes(16).toString('hex')
    this.pending = { code, expiresAt: this.now() + PAIRING_CODE_TTL_MS }
    return code
  }

  /**
   * Validate a `/pair` attempt. On success the caller is responsible
   * for the side effects that belong to the wider system (clearing the
   * ownership registry, closing stale WS connections) before treating
   * the new `allowedExtensionId` as live — see §7.2.1. This method only
   * mutates the pairing slot.
   *
   * On success a fresh `refreshSecret` is minted and replaces any prior
   * one in the single slot, ATOMICALLY with `allowedExtensionId` (both
   * are set together so a re-pairing overwrite never leaves the old
   * secret valid for the new id — §5.4 / §7.2.4 / (c1)). The plaintext
   * secret is returned so the caller can hand it to the extension in the
   * `/pair` response; it is never persisted.
   *
   * `extensionId` must already have been checked to equal the request
   * Origin's `<id>` by the caller (§7.2.2) so the confirmed
   * `allowedExtensionId` is always the requester's own id.
   */
  tryPair(presentedCode: string, extensionId: string): PairResult {
    const pending = this.pending
    if (!pending) return { ok: false, reason: 'no-active-pairing' }

    if (pending.expiresAt <= this.now()) {
      // Expired codes are dropped so a later attempt sees "no active
      // pairing" rather than leaving a dead entry around.
      this.pending = null
      return { ok: false, reason: 'expired' }
    }

    if (!timingSafeStringEqual(presentedCode, pending.code)) {
      return { ok: false, reason: 'mismatch' }
    }

    // Single-use: consume the code on success. Mint + install the new
    // refresh secret together with the extension id so the slot is
    // self-consistent (re-pairing replaces both at once).
    const refreshSecret = this.mintSecret()
    this.pending = null
    this.allowedExtensionId = extensionId
    this.refreshSecret = refreshSecret
    return { ok: true, extensionId, refreshSecret }
  }

  /**
   * Drop the paired extension, its refresh secret, and any pending code.
   * Used on KB shutdown paths / explicit unpair. Re-pairing overwrite is
   * handled by `tryPair` (which sets a new id + secret); callers that
   * need to detect "the id changed" should compare
   * `getAllowedExtensionId()` before/after.
   */
  reset(): void {
    this.allowedExtensionId = null
    this.refreshSecret = null
    this.pending = null
  }
}

/** Mint a 128-bit refresh secret (32-char hex), matching the token shape. */
function defaultMintSecret(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Constant-time string compare for the pairing code (§7.2.3). Returns
 * false on length mismatch without allocating a same-length buffer to
 * compare against (which would itself be a timing side channel).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
