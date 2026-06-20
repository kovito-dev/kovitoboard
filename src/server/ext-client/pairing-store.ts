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
  | { ok: true; extensionId: string }
  | { ok: false; reason: 'no-active-pairing' | 'expired' | 'mismatch' }

export class PairingStore {
  /** The single paired extension id, or `null` when unpaired. */
  private allowedExtensionId: string | null = null
  /** The single pending pairing code, or `null` when none is active. */
  private pending: PendingPairingCode | null = null
  /** Injectable clock for deterministic tests. */
  private readonly now: () => number

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now
  }

  /** Currently paired extension id (`null` when unpaired). */
  getAllowedExtensionId(): string | null {
    return this.allowedExtensionId
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

    // Single-use: consume the code on success.
    this.pending = null
    this.allowedExtensionId = extensionId
    return { ok: true, extensionId }
  }

  /**
   * Drop the paired extension and any pending code. Used on KB shutdown
   * paths / explicit unpair. Re-pairing overwrite is handled by
   * `tryPair` (which sets a new id); callers that need to detect "the
   * id changed" should compare `getAllowedExtensionId()` before/after.
   */
  reset(): void {
    this.allowedExtensionId = null
    this.pending = null
  }
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
