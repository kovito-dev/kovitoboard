/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Install-session nonce store.
 *
 * The recipe-install handover (`POST /api/recipes/install`) hands a
 * recipe to an agent for placement; once the agent has written the
 * artifacts it calls back with `POST /api/recipes/:recipeId/mark-
 * installed`, and KovitoBoard persists the dispatcher's authority
 * source — the recipe-side manifest — including the scopes the
 * agent reports it approved.
 *
 * Without a binding between those two steps the mark-installed
 * endpoint trusts the body verbatim, so any caller that can reach
 * the API can mint a manifest with arbitrary `approvedScopes` and
 * recipeHash. This module closes that gap by issuing a one-shot
 * nonce at install time and requiring the agent to echo it (along
 * with the same approvedScopes / recipeHash KB inspected) when it
 * completes the handover.
 *
 * Design choices
 * --------------
 * - **In-memory only.** A map of `nonce -> session` lives in this
 *   module. The supervisor restarts on SIGUSR2 and exit-42, which
 *   wipes the map; that is intentional. A nonce captured before a
 *   reboot is invalidated automatically without having to track
 *   per-nonce revocation, and the renderer's stale-token reload
 *   flow already covers the "user reopens an old tab" case.
 *
 * - **Five-minute TTL.** The agent typically calls back within a
 *   handful of seconds, but Claude Code can pause for credentials
 *   on first launch and an interactive user may pause to read the
 *   install warning before approving. Five minutes is comfortable
 *   without leaving the credential live for so long that an idle
 *   tab becomes interesting to a co-resident attacker.
 *
 * - **One-shot consume.** `consumeInstallSession` deletes the entry
 *   on every lookup, so even a successful mark-installed cannot be
 *   replayed. A second call with the same nonce returns null and
 *   the handler responds 403.
 *
 * - **Eager sweep.** Expired entries linger in the map until either
 *   the supervisor restarts or the next consume call walks past a
 *   high-watermark. We do not run a background timer because that
 *   would keep the event loop alive in tests and there is no safety
 *   benefit (the stale entries cannot be consumed: they fail the
 *   expiry check).
 */

import { randomBytes } from 'crypto'
import type { Scope } from './handlers/types.js'

const SESSION_TTL_MS = 5 * 60 * 1000
const NONCE_PATTERN = /^[0-9a-f]{32}$/
// Sweep stale entries on every consume once the map crosses this
// size. Keeping the threshold low is cheap because the sweep is O(n)
// over a Map iteration and `n` is bounded by the number of installs
// in flight at any moment.
const SWEEP_HIGH_WATER_MARK = 32

interface InstallSession {
  recipeId: string
  recipeHash: string
  approvedScopes: Scope[]
  expiresAt: number
}

export interface InstallSessionInput {
  recipeId: string
  recipeHash: string
  approvedScopes: Scope[]
}

const sessions = new Map<string, InstallSession>()

function sweepExpired(now: number): void {
  if (sessions.size < SWEEP_HIGH_WATER_MARK) return
  for (const [nonce, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(nonce)
    }
  }
}

/**
 * Mint a fresh nonce, bind it to the install session metadata KB
 * just inspected, and return the hex-encoded value to the caller.
 * The same string is later embedded into the install handover prompt
 * so the agent can echo it back on `mark-installed`.
 */
export function issueInstallSession(input: InstallSessionInput): string {
  const now = Date.now()
  sweepExpired(now)
  // 16 bytes = 128 bits of entropy, hex-encoded into 32 lowercase
  // characters. Same shape as the launch token so the renderer-side
  // assumptions about safe-to-interpolate hex stay valid.
  const nonce = randomBytes(16).toString('hex')
  sessions.set(nonce, {
    recipeId: input.recipeId,
    recipeHash: input.recipeHash,
    approvedScopes: [...input.approvedScopes],
    expiresAt: now + SESSION_TTL_MS,
  })
  return nonce
}

/**
 * Look up a previously-issued nonce, deleting the entry whether or
 * not it is still valid (so a single nonce can never be consumed
 * twice). Returns the session metadata when the nonce matches a
 * non-expired entry; null otherwise.
 *
 * A null return covers all of: malformed nonce, never-issued nonce,
 * already-consumed nonce, and TTL-expired nonce. The caller need
 * not distinguish between them — the handler answers 403 in every
 * case so the failure mode does not leak which dimension was wrong.
 */
export function consumeInstallSession(nonce: unknown): InstallSession | null {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    return null
  }
  const session = sessions.get(nonce)
  if (!session) return null
  // One-shot: drop the entry whether or not it is still within TTL.
  sessions.delete(nonce)
  if (session.expiresAt <= Date.now()) {
    return null
  }
  return session
}

/**
 * Set-equality comparison on the approvedScopes array. The handler
 * uses this to verify the body the agent posted to mark-installed
 * matches what KB inspected at install time. Order is not stable
 * (different recipe parsers / serializers produce different orders),
 * so we compare as a set of unique strings.
 */
export function approvedScopesMatch(a: Scope[], b: Scope[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const sa = new Set<Scope>(a)
  for (const scope of b) {
    if (!sa.has(scope)) return false
  }
  return sa.size === a.length
}

/**
 * Test seam. Production code never resets the store — supervisor
 * restart wipes it for free — but unit tests need a clean slate.
 */
export function __resetForTests(): void {
  sessions.clear()
}

/**
 * Test seam: lets unit tests inspect the live map size without
 * exposing the internal nonces (which would defeat the one-shot
 * guarantee under test).
 */
export function __sizeForTests(): number {
  return sessions.size
}
