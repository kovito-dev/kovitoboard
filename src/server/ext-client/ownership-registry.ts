/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-extension session ownership + launch correlation for the
 * external-client API (external-client-api.md v1.0 §5.4 / §7.3.1).
 *
 * Why this exists
 * ---------------
 * KB session creation is asynchronous (P-9): `POST .../sessions/new`
 * does not return a sessionId. Claude writes JSONL → the watcher picks
 * it up → `new_session` fires later. To answer "which extension owns
 * this freshly-materialised session?" we mint a server-side `launchId`
 * at request time and correlate it when the session materialises.
 *
 * Correlation key
 * ---------------
 * The spec serialises ext launches per `agentId` (§7.3.1 step 1: an ext
 * launch is rejected while ANY pending origin reservation exists for
 * that agentId, and the agentId is marked in-flight until the matching
 * `new_session` or TTL). Because at most one ext launch is in flight
 * per agentId, **agentId alone is a unique correlation key** for the
 * pending-launch map — we do not have to thread the `launchId` through
 * the SessionManager's reservation queue. This keeps the existing
 * `reserveOrigin` contract (and every non-ext caller) byte-for-byte
 * unchanged (INV-ORIGIN-1 / non-interference).
 *
 * Lifecycle
 * ---------
 * All state is process-wide and per-`allowedExtensionId`. It is dropped
 * on re-pairing overwrite and on KB restart (the store is just GC'd).
 * The owned-session registry and pending-launch map survive WS
 * connection close; only per-connection subscription sets (held in
 * `index.ts`) are torn down on close.
 */
import { randomBytes } from 'crypto'

/** Pending ext-launch TTL: 60 seconds (§5.4 / §7.3.1 step 5). */
export const EXT_LAUNCH_TTL_MS = 60_000

export interface PendingExtLaunch {
  launchId: string
  agentId: string
  /** WS connection id of the originating extension socket, if any. */
  originConnId: number | null
  /** Client-generated correlation id, echoed on `new_session`. */
  clientRequestId: string | null
  expiresAt: number
}

export type RegisterLaunchResult =
  | { ok: true; launchId: string }
  | { ok: false; reason: 'agent-in-flight' | 'duplicate-client-request' }

/**
 * Outcome of correlating a materialised session with a pending launch.
 * `matched` carries enough for `index.ts` to do the auto-subscribe and
 * `new_session` echo wiring (§7.3.1 step 4).
 */
export interface CorrelationMatch {
  launchId: string
  agentId: string
  originConnId: number | null
  clientRequestId: string | null
  sessionId: string
}

export class OwnershipRegistry {
  /** sessionIds owned by the current `allowedExtensionId` (§5.4). */
  private owned = new Set<string>()
  /** launchId → pending launch entry. */
  private pendingByLaunchId = new Map<string, PendingExtLaunch>()
  /** agentId → launchId, the per-agent in-flight serialisation lock. */
  private inFlightAgentToLaunch = new Map<string, string>()
  /** clientRequestId → launchId, dedup of in-flight client correlations (§8.5). */
  private pendingClientRequestIds = new Map<string, string>()
  private readonly now: () => number
  private readonly mintLaunchId: () => string

  constructor(opts?: { now?: () => number; mintLaunchId?: () => string }) {
    this.now = opts?.now ?? Date.now
    this.mintLaunchId = opts?.mintLaunchId ?? defaultMintLaunchId
  }

  /**
   * Whether an ext launch for `agentId` is currently in flight. Used by
   * the ext new-session path to serialise same-agentId launches
   * (§7.3.1 step 1). Expired entries are GC'd first so a stale lock
   * does not block forever.
   */
  isAgentInFlight(agentId: string): boolean {
    this.gcExpired()
    return this.inFlightAgentToLaunch.has(agentId)
  }

  /**
   * Register a new ext launch: mint a `launchId`, mark `agentId`
   * in-flight, and record the pending entry. Rejects (without minting)
   * if the agent is already in flight — the caller must have already
   * checked `isAgentInFlight` for the cross-origin reservation case,
   * but this guards the ext-vs-ext race too.
   */
  registerLaunch(args: {
    agentId: string
    originConnId: number | null
    clientRequestId: string | null
  }): RegisterLaunchResult {
    this.gcExpired()
    if (this.inFlightAgentToLaunch.has(args.agentId)) {
      return { ok: false, reason: 'agent-in-flight' }
    }
    // §8.5: a clientRequestId that is still pending (not yet
    // materialised / expired) must not start a second launch, even for a
    // different agentId — the client is responsible for minting a fresh
    // id per request. Ignore the duplicate.
    if (args.clientRequestId !== null && this.pendingClientRequestIds.has(args.clientRequestId)) {
      return { ok: false, reason: 'duplicate-client-request' }
    }
    const launchId = this.mintLaunchId()
    this.pendingByLaunchId.set(launchId, {
      launchId,
      agentId: args.agentId,
      originConnId: args.originConnId,
      clientRequestId: args.clientRequestId,
      expiresAt: this.now() + EXT_LAUNCH_TTL_MS,
    })
    this.inFlightAgentToLaunch.set(args.agentId, launchId)
    if (args.clientRequestId !== null) {
      this.pendingClientRequestIds.set(args.clientRequestId, launchId)
    }
    return { ok: true, launchId }
  }

  /**
   * Correlate a materialised `new_session` (carrying `sessionId` +
   * `agentId`) with a pending ext launch. On a hit: add the session to
   * the owned registry, consume the pending entry, release the
   * in-flight lock, and return the match for downstream wiring. Returns
   * `null` when no ext launch is pending for that agentId (e.g. a
   * renderer-started session, or an already-consumed / expired launch).
   */
  correlateNewSession(sessionId: string, agentId: string): CorrelationMatch | null {
    this.gcExpired()
    const launchId = this.inFlightAgentToLaunch.get(agentId)
    if (launchId === undefined) return null
    const pending = this.pendingByLaunchId.get(launchId)
    if (pending === undefined) {
      // Defensive: lock without entry — clear the dangling lock.
      this.inFlightAgentToLaunch.delete(agentId)
      return null
    }
    this.owned.add(sessionId)
    this.pendingByLaunchId.delete(launchId)
    this.inFlightAgentToLaunch.delete(agentId)
    this.releaseClientRequestId(pending)
    return {
      launchId: pending.launchId,
      agentId: pending.agentId,
      originConnId: pending.originConnId,
      clientRequestId: pending.clientRequestId,
      sessionId,
    }
  }

  /**
   * Release a pending launch that will never materialise (e.g. the
   * downstream `sessions/new` side effect failed synchronously, or a
   * late cross-origin reservation check rejected it). Drops the pending
   * entry and its in-flight lock so the agentId is not blocked until
   * TTL. No-op if already consumed / expired.
   */
  abortLaunch(launchId: string): void {
    const entry = this.pendingByLaunchId.get(launchId)
    if (entry === undefined) return
    this.pendingByLaunchId.delete(launchId)
    if (this.inFlightAgentToLaunch.get(entry.agentId) === launchId) {
      this.inFlightAgentToLaunch.delete(entry.agentId)
    }
    this.releaseClientRequestId(entry)
  }

  /** Whether `sessionId` is owned by the current extension (§7.3.1). */
  isOwned(sessionId: string): boolean {
    return this.owned.has(sessionId)
  }

  /**
   * Drop ALL state. Called on re-pairing overwrite / KB shutdown so the
   * old extension's owned sessions, pending launches, and in-flight
   * locks are gone (§7.2.1).
   */
  clear(): void {
    this.owned.clear()
    this.pendingByLaunchId.clear()
    this.inFlightAgentToLaunch.clear()
    this.pendingClientRequestIds.clear()
  }

  /** Remove expired pending launches and release their in-flight locks. */
  private gcExpired(): void {
    const t = this.now()
    for (const [launchId, entry] of this.pendingByLaunchId) {
      if (entry.expiresAt <= t) {
        this.pendingByLaunchId.delete(launchId)
        if (this.inFlightAgentToLaunch.get(entry.agentId) === launchId) {
          this.inFlightAgentToLaunch.delete(entry.agentId)
        }
        this.releaseClientRequestId(entry)
      }
    }
  }

  /** Drop the clientRequestId dedup entry for a consumed launch. */
  private releaseClientRequestId(entry: PendingExtLaunch): void {
    if (
      entry.clientRequestId !== null &&
      this.pendingClientRequestIds.get(entry.clientRequestId) === entry.launchId
    ) {
      this.pendingClientRequestIds.delete(entry.clientRequestId)
    }
  }
}

function defaultMintLaunchId(): string {
  return randomBytes(16).toString('hex')
}
