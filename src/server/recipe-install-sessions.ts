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
 * source — the recipe-side manifest — including the scopes and the
 * api section the agent reports it approved.
 *
 * Without a binding between those two steps the mark-installed
 * endpoint trusts the body verbatim, so any caller that can reach
 * the API can mint a manifest with arbitrary `approvedScopes`,
 * `recipeHash`, or `api` (which carries the dispatcher handler
 * configuration). This module closes that gap by issuing a one-shot
 * nonce at install time and requiring the agent to echo it (along
 * with the same approvedScopes / recipeHash / api KB inspected) when
 * it completes the handover.
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
 * - **Bounded memory.** Issuing a nonce always prunes expired entries
 *   first, then refuses (returns null) if the live count would
 *   exceed `MAX_SESSIONS`. A misbehaving caller that spams `install`
 *   cannot grow the map past that ceiling, and the supervisor never
 *   has to fall over for a slow OOM.
 *
 * - **No background timer.** Pruning is on-demand from the issue and
 *   consume paths. A periodic timer would keep the Node event loop
 *   alive in tests and offers no security upside (stale entries are
 *   already filtered out at consume time).
 */

import { randomBytes } from 'crypto'
import type { Scope } from './handlers/types.js'
import type { CaptureKind } from './recipe/apiTypes.js'

const SESSION_TTL_MS = 5 * 60 * 1000
const NONCE_PATTERN = /^[0-9a-f]{32}$/
/**
 * Cap on the number of in-flight nonces. The agent typically returns
 * within seconds and the TTL is five minutes, so any legitimate
 * deployment should sit well below this number even under a steady
 * stream of installs. The cap exists to refuse a malicious caller
 * that spams `/api/recipes/install` to grow the map.
 */
const MAX_SESSIONS = 256
/**
 * Recursion depth ceiling for `canonicalizeJson`. The recipe parser
 * already validates the api section's shape, but `parsed.api` is
 * still attacker-controlled JSON until that check runs end-to-end,
 * and a deeply-nested or cyclic structure would otherwise be able
 * to overflow the stack on `/api/recipes/install`. 32 is well above
 * the depth a real recipe schema produces (`api -> calls[] -> args
 * -> ...`) while staying far below Node's default stack-size
 * threshold.
 */
const MAX_CANONICAL_DEPTH = 32

interface InstallSession {
  recipeId: string
  recipeHash: string
  /**
   * Free-form metadata KB inspected at install time. The
   * mark-installed handler compares each of these against the body
   * to keep an attacker who is holding a valid nonce from
   * persisting falsified provenance (e.g. claiming the recipe
   * came from `sample` when it actually arrived through `import`,
   * or recording an arbitrary `recipeVersion` for the upgrade
   * UI / audit log).
   */
  recipeVersion: string
  recipeSource: string
  approvedScopes: Scope[]
  /**
   * Capture kinds the recipe declared in `recipe.yaml`'s
   * `capture.requires` (v0.2.0 / spec v1.5). The mark-installed
   * handler compares the body's `captureRequires` against this set
   * so a caller who reuses a captured nonce cannot widen the
   * declared surface beyond what the parser actually inspected.
   *
   * @see recipe-system.md v1.5 §6.10.3 (I-CR2)
   */
  captureRequires: CaptureKind[]
  /**
   * Capture kinds the user agreed to at install time (v0.2.0). The
   * mark-installed handler compares the body's `approvedCaptures`
   * against this set so a caller who reuses a captured nonce cannot
   * widen the approved capture surface beyond what the install
   * warning dialog actually showed the user.
   *
   * @see recipe-system.md v1.5 §6.10.2〜§6.10.3
   */
  approvedCaptures: CaptureKind[]
  /**
   * Canonicalised form of the recipe's `api` section as it was at
   * install-inspection time (or `null` if the recipe declared no
   * api). The mark-installed handler reproduces the same canonical
   * form from the body and rejects on mismatch, so a caller cannot
   * substitute a different api section while still passing nonce /
   * hash / scope checks.
   */
  apiCanonical: string
  expiresAt: number
}

export interface InstallSessionInput {
  recipeId: string
  recipeHash: string
  recipeVersion: string
  recipeSource: string
  approvedScopes: Scope[]
  /**
   * Capture kinds the recipe declared in `recipe.yaml`'s
   * `capture.requires` (v0.2.0 / spec v1.5). Optional only for
   * backward compatibility with pre-v0.2.0 callers; the opt-in
   * surface always sends the array explicitly.
   *
   * @see recipe-system.md v1.5 §6.10.3 (I-CR2)
   */
  captureRequires?: CaptureKind[]
  /**
   * Capture kinds the user approved while inspecting the install
   * warning dialog (v0.2.0). Subset of the recipe's
   * `captureRequires` (I-CR1). May be an empty array — that just
   * means the recipe declared no capture or the user declined
   * every capability.
   *
   * Optional only for backward compatibility with pre-v0.2.0
   * callers (notably the existing install-sessions test suite). Code
   * paths that participate in the opt-in mechanism MUST send the
   * array explicitly so the consume-time multiset check stays
   * meaningful.
   *
   * @see recipe-system.md v1.5 §6.10.2
   */
  approvedCaptures?: CaptureKind[]
  api: unknown
}

const sessions = new Map<string, InstallSession>()

/**
 * Stable, deterministic stringification for arbitrary JSON-shaped
 * input. Used to fingerprint the recipe's `api` section so the
 * install-time view and the mark-installed body can be compared
 * regardless of whether the YAML / JSON parser emitted keys in a
 * different order. Arrays preserve order (the dispatcher cares about
 * `calls` order), object keys are sorted, primitives stringify via
 * `JSON.stringify`. `undefined` and `null` collapse to `"null"` so
 * "missing api section" produces the same fingerprint on both ends.
 *
 * Returns `null` when the value exceeds `MAX_CANONICAL_DEPTH` or
 * contains a cycle. The caller surfaces that as a 4xx so a
 * malformed recipe never trips the install path with arbitrary CPU
 * / stack consumption.
 */
export function canonicalizeJson(value: unknown): string | null {
  try {
    return canonicalizeInner(value, 0, new WeakSet())
  } catch (err) {
    if (err instanceof CanonicalizeOverflow) return null
    throw err
  }
}

class CanonicalizeOverflow extends Error {
  constructor(reason: 'depth' | 'cycle') {
    super(`canonicalizeJson refused: ${reason}`)
    this.name = 'CanonicalizeOverflow'
  }
}

function canonicalizeInner(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new CanonicalizeOverflow('depth')
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  const objValue = value as object
  if (seen.has(objValue)) throw new CanonicalizeOverflow('cycle')
  seen.add(objValue)
  try {
    if (Array.isArray(value)) {
      return '[' + value.map((v) => canonicalizeInner(v, depth + 1, seen)).join(',') + ']'
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalizeInner(obj[k], depth + 1, seen))
        .join(',') +
      '}'
    )
  } finally {
    seen.delete(objValue)
  }
}

function pruneExpired(now: number): void {
  for (const [nonce, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(nonce)
    }
  }
}

export type IssueInstallSessionResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'at_capacity' | 'invalid_api' }

/**
 * Mint a fresh nonce, bind it to the install session metadata KB
 * just inspected, and return the hex-encoded value to the caller.
 * The same string is later embedded into the install handover prompt
 * so the agent can echo it back on `mark-installed`.
 *
 * Returns `{ ok: false, reason: 'at_capacity' }` when the store is
 * full (a 503 from the handler), or `{ ok: false, reason:
 * 'invalid_api' }` when canonicalising the api section overflowed
 * the depth limit / hit a cycle (a 400 — the recipe itself is
 * malformed and no nonce is issued).
 */
export function issueInstallSession(input: InstallSessionInput): IssueInstallSessionResult {
  const apiCanonical = canonicalizeJson(input.api ?? null)
  if (apiCanonical === null) {
    return { ok: false, reason: 'invalid_api' }
  }
  const now = Date.now()
  pruneExpired(now)
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, reason: 'at_capacity' }
  }
  // 16 bytes = 128 bits of entropy, hex-encoded into 32 lowercase
  // characters. Same shape as the launch token so the renderer-side
  // assumptions about safe-to-interpolate hex stay valid.
  const nonce = randomBytes(16).toString('hex')
  // `captureRequires` and `approvedCaptures` are optional on the
  // call signature for backward-compatibility with pre-v0.2.0
  // callers (the legacy unit suite, in particular). A missing
  // field is treated as "no captures declared / approved" — the
  // same semantics the validator applies on the mark-installed
  // side, so the multiset check at consume time still lines up.
  sessions.set(nonce, {
    recipeId: input.recipeId,
    recipeHash: input.recipeHash,
    recipeVersion: input.recipeVersion,
    recipeSource: input.recipeSource,
    approvedScopes: [...input.approvedScopes],
    captureRequires: input.captureRequires ? [...input.captureRequires] : [],
    approvedCaptures: input.approvedCaptures ? [...input.approvedCaptures] : [],
    apiCanonical,
    expiresAt: now + SESSION_TTL_MS,
  })
  return { ok: true, nonce }
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
 *
 * The lookup also runs an expiry sweep so the steady-state map size
 * stays close to "live in-flight installs" between issues.
 */
export function consumeInstallSession(nonce: unknown): InstallSession | null {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    return null
  }
  const now = Date.now()
  pruneExpired(now)
  const session = sessions.get(nonce)
  if (!session) return null
  // One-shot: drop the entry whether or not it is still within TTL.
  sessions.delete(nonce)
  if (session.expiresAt <= now) {
    return null
  }
  return session
}

/**
 * Multiset-equality comparison on the approvedScopes array. The
 * handler uses this to verify the body the agent posted to mark-
 * installed matches what KB inspected at install time. Order is not
 * stable (different recipe parsers / serializers produce different
 * orders), but per-scope occurrence count is — counting per scope
 * defeats both the "different unique members at the same length"
 * case (`['x','y']` vs `['x','x']`) and the "same unique members
 * with different counts" case (`['x','x','y','y']` vs
 * `['x','x','x','y']`) that a length+set check would let through.
 */
export function approvedScopesMatch(a: Scope[], b: Scope[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const counts = new Map<Scope, number>()
  for (const scope of a) {
    counts.set(scope, (counts.get(scope) ?? 0) + 1)
  }
  for (const scope of b) {
    const remaining = counts.get(scope)
    if (remaining === undefined || remaining === 0) return false
    counts.set(scope, remaining - 1)
  }
  // Every entry in `a` was matched off; the map of remainders must
  // therefore be all zeros. We do not need to check explicitly
  // because the equal-length precondition guarantees it.
  return true
}

/**
 * Multiset-equality comparison on a capture-kinds array (v0.2.0).
 *
 * Mirrors {@link approvedScopesMatch}: the install-warning dialog
 * sends `approvedCaptures` (and v1.5: the recipe-declared
 * `captureRequires`) to `mark-installed`, and the handler must
 * confirm both match what the install-session store remembers
 * from the agent handover. We treat each array as a multiset so a
 * caller cannot widen the approved / declared surface by
 * reordering or duplicating entries.
 *
 * Exported under the legacy name `approvedCapturesMatch` for
 * backward compatibility — the function is shape-agnostic and the
 * v1.5 mark-installed handler calls it twice (once per axis).
 */
export function approvedCapturesMatch(a: CaptureKind[], b: CaptureKind[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const counts = new Map<CaptureKind, number>()
  for (const kind of a) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  for (const kind of b) {
    const remaining = counts.get(kind)
    if (remaining === undefined || remaining === 0) return false
    counts.set(kind, remaining - 1)
  }
  return true
}

/**
 * Run the canonical-JSON comparison the mark-installed handler uses
 * to verify the body's `api` section matches what KB inspected at
 * install time. Exposed as a function so unit tests can drive the
 * canonicalisation directly.
 */
export function apiSectionMatches(sessionCanonical: string, body: unknown): boolean {
  const bodyCanonical = canonicalizeJson(body ?? null)
  // A null bodyCanonical means the body ran into the same depth /
  // cycle guard as the install path. Treat that as a non-match
  // rather than potentially comparing two `null` markers and
  // accidentally accepting two malformed payloads as equal.
  if (bodyCanonical === null) return false
  return sessionCanonical === bodyCanonical
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

/**
 * Test seam: the cap that callers asking for a 503 path should
 * compare against.
 */
export const __MAX_SESSIONS_FOR_TESTS = MAX_SESSIONS
