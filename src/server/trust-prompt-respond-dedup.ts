/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Trust prompt respond dedup ledger — server-side defense against
 * `(windowName, promptId)` duplicate respond races.
 *
 * Background: each connected WebSocket client receives `trust_prompt_detected`
 * replays via `getPendingPrompts()` on (re)connect, so the same prompt can be
 * rendered across multiple browser tabs simultaneously. If an operator clicks
 * "Yes" in tab A and — before the resulting `trust_prompt_resolved` broadcast
 * reaches tab B — clicks "No" in tab B, both responds arrive at
 * `handleTrustPromptRespond` and both pass the §8.1 / §10.6.2
 * `hasPendingKnownPrompt` check (the detector's `state.lastDetectedKind` is
 * still `'pattern'` at the moment of the second click). The second response
 * then trails a stray keystroke into the live tmux pane.
 *
 * This module gates that race at the WS handler level: between mode-specific
 * validation (§7.5.1 / §7.5.2 prelude) and detector dispatch (§7.5.1 / §7.5.2
 * postlude), the handler calls `tryClaimTrustResponded(windowName, promptId)`.
 * A claim that returns `false` means another respond already won the slot;
 * the caller MUST discard the request with a `warn` log.
 *
 * Ledger characteristics (normative, see `trust-prompt-relay.md` v1.5 §8.1.1):
 *   - Key   : `(windowName, promptId)` pair
 *   - TTL   : 5 minutes (>> the sub-second broadcast latency window)
 *   - Cap   : 1024 entries (hostile / buggy clients cannot inflate this ledger)
 *   - Claim order:
 *       1. Duplicate detection (key present AND not expired → reject)
 *       2. Eviction            (drop expired entries; drop oldest if at cap)
 *       3. Set                 (insert new entry, return true)
 *     The duplicate-first ordering ensures a duplicate flood on a single key
 *     cannot evict legitimate older entries belonging to other prompts.
 *   - Eviction order on cap   : Map insertion order (JavaScript Map iteration
 *     is documented to be insertion order; `.keys().next()` yields the oldest).
 *
 * @see docs/specs/trust-prompt-relay.md §8.1.1 (supplementary §S20, v0.2.0)
 * @stable v0.2.x
 */

/**
 * Time-to-live for a single (windowName, promptId) claim. After this much
 * wall-clock time has elapsed since the claim was set, the slot is treated as
 * vacant and a new respond carrying the same identifiers is accepted again
 * (spec: "a re-claim 5+ minutes apart is treated as a new claim").
 */
export const TRUST_DEDUP_TTL_MS = 5 * 60 * 1000

/**
 * Hard upper bound on the number of live entries. A hostile or buggy client
 * cannot inflate this ledger past the cap; once full, the oldest claim is
 * evicted on every new claim. Set well above the steady-state working set
 * (one entry per `(windowName, promptId)` pair, both of which are short-lived
 * relative to the TTL).
 */
export const TRUST_DEDUP_MAX_ENTRIES = 1024

/**
 * Internal key encoding. The Unit Separator (`\x1f`) is used because neither
 * tmux window names nor `promptId` strings legitimately contain it — that
 * keeps `(windowName='a', promptId='b\x1fc')` from colliding with
 * `(windowName='a\x1fb', promptId='c')` in any realistic input space.
 */
const KEY_SEP = '\x1f'

function makeKey(windowName: string, promptId: string): string {
  return `${windowName}${KEY_SEP}${promptId}`
}

/**
 * The ledger itself. `value` is the wall-clock timestamp of the claim, in ms
 * since epoch (Date.now()). Map insertion order is used for cap-eviction.
 *
 * Module-scoped so the same ledger is shared across the lifetime of the
 * server process — this is the correct scope because KovitoBoard runs one
 * server per projectRoot (process-lifecycle.md v1.1 §4).
 */
const ledger: Map<string, number> = new Map()

/**
 * Optional `Date.now()` injection for unit tests. Production code never
 * touches this; tests use `_setNowProviderForTests` to advance a virtual clock.
 */
let nowProvider: () => number = Date.now

/**
 * Attempt to claim the dedup slot for `(windowName, promptId)`. Returns
 * `true` if the caller is the first responder within the TTL window and may
 * proceed with detector dispatch; returns `false` if another responder has
 * already claimed the slot.
 *
 * Spec invariant (claim order, §8.1.1 normative):
 *   1. Duplicate detection runs *before* any eviction. If `(windowName,
 *      promptId)` is already in the ledger and the entry is still within TTL,
 *      this function returns `false` immediately and DOES NOT mutate the
 *      ledger. That property is what prevents a duplicate flood (1024 respond
 *      attempts against the same `(windowName, promptId)`) from evicting
 *      legitimate older entries belonging to other prompts.
 *   2. TTL eviction (drop every entry whose age exceeds the TTL) is followed
 *      by size-cap eviction (drop oldest insertion-order entries until we
 *      have room for one more).
 *   3. Set installs the new entry at the tail (newest insertion order).
 *
 * TTL boundary: strictly less than `TRUST_DEDUP_TTL_MS` is "still live".
 * At-or-past the TTL is treated as expired, matching the spec phrase
 * "5 分以上開けた同一 promptId 再 claim は新規扱い" — `5 分以上` is inclusive,
 * so a re-claim arriving exactly at `now - existing === TTL` already
 * succeeds as a fresh claim rather than being absorbed as a duplicate.
 *
 * Performance note: the TTL eviction in step (2) walks the full ledger. With
 * `TRUST_DEDUP_MAX_ENTRIES = 1024` and respond rates measured in single
 * digits per second, this is a non-issue in practice. If respond rates ever
 * grow by orders of magnitude, switch to a wheel / min-heap of expirations.
 */
export function tryClaimTrustResponded(windowName: string, promptId: string): boolean {
  const key = makeKey(windowName, promptId)
  const now = nowProvider()

  // Phase 1. Duplicate detection.
  //
  // We deliberately check both "key present" AND "not expired" here. An
  // entry that exists but is past its TTL is treated as if it were not in
  // the ledger — it will be physically removed in the eviction phase below
  // and a fresh claim will succeed. This matches the spec's
  // "5+ minutes apart is treated as a new claim" clause.
  const existing = ledger.get(key)
  if (existing !== undefined && now - existing < TRUST_DEDUP_TTL_MS) {
    return false
  }

  // Phase 2. Eviction.
  //
  // (2a) TTL eviction: drop every expired entry (including the stale one
  // we just observed above, if any). This is a single linear scan because
  // Map.entries() iteration is insertion-order; in steady state most
  // entries are still live, so the average case visits only a few dead
  // tails before stopping early — but to keep the contract simple we
  // unconditionally scan the whole ledger here. With cap = 1024 the cost
  // is bounded at O(1024) wall-clock per claim, well within budget for a
  // human-driven respond loop.
  for (const [k, ts] of ledger) {
    if (now - ts > TRUST_DEDUP_TTL_MS) {
      ledger.delete(k)
    }
  }

  // (2b) Size-cap eviction: while we are at or above the cap (we are about
  // to add one), drop the oldest entry. Map.keys().next().value is the
  // earliest-inserted key in JavaScript Maps. The loop guards against the
  // hypothetical case where the ledger is still over capacity after a
  // single drop (cannot happen in normal operation, but defensive).
  while (ledger.size >= TRUST_DEDUP_MAX_ENTRIES) {
    const oldest = ledger.keys().next().value
    if (oldest === undefined) break
    ledger.delete(oldest)
  }

  // Phase 3. Set the new claim. `Map.set` on an absent key appends at the
  // tail of the insertion order; for an already-deleted-then-readded key,
  // the new position is also the tail.
  ledger.set(key, now)
  return true
}

/**
 * Release a previously successful claim for `(windowName, promptId)`. Intended
 * to be called from the handler's rollback path: when `tryClaimTrustResponded`
 * returned `true` but the subsequent detector dispatch returned `false` (for
 * example because `choiceId` did not match any entry in `state.lastChoices`,
 * or because of a TOCTOU `promptId` mismatch in the detector), no key sequence
 * was actually delivered to the tmux pane — so the slot must be vacated so
 * the legitimate next respond can claim it.
 *
 * Without this rollback, a shape-valid but semantically invalid response
 * (unknown `choiceId`, e.g. from a buggy or hostile client) would occupy the
 * slot for the full TTL window and block the legitimate operator response
 * for 5 minutes — that turns the dedup ledger into an availability DoS.
 *
 * Safety notes:
 *   - This is a single-thread operation: Node's event loop guarantees that
 *     `handleTrustPromptRespond`'s Phase 3 (claim) and Phase 4 (dispatch)
 *     run atomically with respect to each other. No other claim can sneak
 *     into the slot between the claim and the rollback, so unconditional
 *     `Map.delete` is safe — there is nobody else's entry to clobber.
 *   - Callers MUST only invoke this when their own preceding claim returned
 *     `true`. Calling it without a matching successful claim is harmless
 *     (the key is simply absent and `delete` is a no-op) but indicates a
 *     handler bug.
 */
export function releaseTrustClaim(windowName: string, promptId: string): void {
  ledger.delete(makeKey(windowName, promptId))
}

// -----------------------------------------------------------------------
// Test hooks (export-only, never called from production paths)
// -----------------------------------------------------------------------

/**
 * Reset the ledger to an empty state. Call from `beforeEach` in unit tests
 * to isolate test cases. The production code never calls this.
 */
export function _resetTrustDedupLedgerForTests(): void {
  ledger.clear()
  nowProvider = Date.now
}

/**
 * Inject a virtual clock. Tests use this to simulate TTL elapse without
 * sleeping. Pass `null` to revert to `Date.now`. The production code never
 * calls this.
 */
export function _setNowProviderForTests(provider: (() => number) | null): void {
  nowProvider = provider ?? Date.now
}

/**
 * Reveal the ledger size for assertions. Tests use this to verify cap-
 * eviction behavior. The production code never calls this.
 */
export function _getTrustDedupLedgerSizeForTests(): number {
  return ledger.size
}
