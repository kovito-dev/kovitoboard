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
  /**
   * claude-bridge processId, if the launch fell back to `--print` mode
   * (rather than tmux). Used to backfill the process's sessionId on
   * materialisation so `process_end` filtering works for fallback
   * launches. `null` for tmux launches (no claude-bridge process).
   */
  processId: string | null
  /**
   * Sidecar-correlation launch-time latch (external-client-api.md
   * §7.3.2.1 (S-4)/(S-6), BL-2026-285). Latched by `latchLaunchProcess`
   * just before the launch fires its `/clear` (`clearAndSendMessage`),
   * so the materialisation-time correlation can prove launch-causality
   * (not merely state-match) against the per-PID sidecar:
   *  - `tmuxPid`        — the ext launch's tmux pane PID (the process
   *                       whose sidecar carries the post-`/clear`
   *                       sessionId). `null` until latched / when PID
   *                       resolution failed (fail-closed at correlate).
   *  - `windowName`     — the actual tmux window name passed to
   *                       startAgent (NOT assumed == agentId), kept for
   *                       diagnostics only. PID + birth identity are
   *                       resolved together at launch time, so there is
   *                       no materialisation-time PID re-resolution.
   *  - `priorSessionId` — the sidecar's sessionId at launch time (the
   *                       pre-`/clear` active session). The materialised
   *                       sessionId must DIFFER from this (transition,
   *                       (S-6a)) — a stale pre-launch re-materialisation
   *                       of `priorSessionId` is rejected.
   *  - `procBirthId`    — the PID's birth identity at launch, read from
   *                       the OS-authoritative `/proc/<pid>/stat`
   *                       starttime (NOT the sidecar's self-reported
   *                       `procStart`, which a stale sidecar could replay
   *                       across a PID reuse). The resolver re-reads the
   *                       LIVE `/proc` starttime at correlate time and
   *                       requires equality, which also proves liveness
   *                       (a gone PID has no `/proc` entry) ((S-6b)).
   */
  tmuxPid: number | null
  windowName: string | null
  priorSessionId: string | null
  procBirthId: string | null
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
  processId: string | null
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
  /**
   * sessionId → already-consumed sidecar-correlation match awaiting its
   * `new_session` echo (§7.3.2.1 (S-3)). The sidecar resolver stamps +
   * consumes the launch at `ensureSession` time, but the `new_session`
   * echo / auto-subscribe needs the session SUMMARY (which only exists
   * once the first message arrives), so the match is parked here and
   * drained by the `new_session` listener. Held INSIDE the registry — not
   * in `index.ts` — so it shares the single ownership lifecycle: `clear()`
   * drops it on re-pair / shutdown, closing the cross-pairing-boundary
   * leak where a stale pre-repair match would otherwise be echoed to the
   * freshly-paired extension. Each entry carries the launch's `expiresAt`
   * so a match whose `new_session` never fires is GC'd rather than leaked.
   */
  private sidecarMatchBySessionId = new Map<string, { match: CorrelationMatch; expiresAt: number }>()
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
      processId: null,
      tmuxPid: null,
      windowName: null,
      priorSessionId: null,
      procBirthId: null,
      expiresAt: this.now() + EXT_LAUNCH_TTL_MS,
    })
    this.inFlightAgentToLaunch.set(args.agentId, launchId)
    if (args.clientRequestId !== null) {
      this.pendingClientRequestIds.set(args.clientRequestId, launchId)
    }
    return { ok: true, launchId }
  }

  /**
   * Attach the claude-bridge `processId` to a still-pending launch (the
   * `--print` fallback path returns one). Recorded so that, on
   * materialisation, the caller can backfill the process's sessionId for
   * `process_end` filtering. No-op if the launch already consumed /
   * expired.
   */
  attachProcessId(launchId: string, processId: string): void {
    const pending = this.pendingByLaunchId.get(launchId)
    if (pending) pending.processId = processId
  }

  /**
   * Latch the sidecar-correlation launch-causality basis onto a
   * still-pending launch (external-client-api.md §7.3.2.1 (S-4)/(S-6)).
   * Called from the ext launch side effect just before it fires the
   * `/clear` (`clearAndSendMessage`), with the launch's tmux pane PID,
   * the actual window name, the pre-`/clear` sidecar sessionId
   * (`priorSessionId`, transition basis (S-6a)), and the PID's birth
   * identity (`procBirthId`, PID-reuse basis (S-6b)). No-op if the launch
   * already consumed / expired. Individual fields may be `null` when the
   * launch path could not resolve them (e.g. no tmux PID) — the
   * materialisation-time correlation then fail-closes on the missing
   * field rather than over-delivering.
   */
  latchLaunchProcess(
    launchId: string,
    fields: {
      tmuxPid: number | null
      windowName: string | null
      priorSessionId: string | null
      procBirthId: string | null
    },
  ): void {
    const pending = this.pendingByLaunchId.get(launchId)
    if (!pending) return
    pending.tmuxPid = fields.tmuxPid
    pending.windowName = fields.windowName
    pending.priorSessionId = fields.priorSessionId
    pending.procBirthId = fields.procBirthId
  }

  /**
   * Read-only snapshot of every currently-pending (non-expired) ext
   * launch, for the sidecar-correlation resolver (§7.3.2.1 (S-1)/(S-6))
   * to iterate. Expired entries are GC'd first. The snapshot is a shallow
   * copy array of the live entries — the caller MUST treat it as
   * read-only (it does not consume / mutate; consume happens via
   * `consumeLaunchByIdAndOwn`). Returned entries reference the live
   * objects' field values at call time.
   */
  listInFlightLaunches(): ReadonlyArray<Readonly<PendingExtLaunch>> {
    this.gcExpired()
    return Array.from(this.pendingByLaunchId.values())
  }

  /**
   * Atomic consume-then-own for sidecar-correlation (§7.3.2.1 (S-3)):
   * consume the EXACT `launchId` (not an agentId-only lookup) and, ONLY
   * if that consume succeeds, add `sessionId` to the owned registry and
   * return the match for the caller's stamp + downstream wiring. Returns
   * `null` when the launch is no longer pending (TTL-expired / already
   * consumed by the materialisation-time path or a prior reconcile tick /
   * unknown launchId) — in which case the caller performs NO stamp
   * (no-bind, under-delivery). Because a successful consume removes the
   * entry, a racing second call (materialise-time vs reconcile-time)
   * fails → no double-stamp (§7.3.2.1 (S-3) (S-7) idempotence).
   *
   * Distinct from `correlateNewSession` (the §7.3.1 step-4 agentId-keyed
   * path for freshly-started agents): this is the launchId-exact path
   * used after the sidecar proved launch-causality, so it cannot bind to
   * the wrong pending entry for the same agentId.
   */
  consumeLaunchByIdAndOwn(launchId: string, sessionId: string): CorrelationMatch | null {
    this.gcExpired()
    const pending = this.pendingByLaunchId.get(launchId)
    if (pending === undefined) return null
    this.owned.add(sessionId)
    this.pendingByLaunchId.delete(launchId)
    if (this.inFlightAgentToLaunch.get(pending.agentId) === launchId) {
      this.inFlightAgentToLaunch.delete(pending.agentId)
    }
    this.releaseClientRequestId(pending)
    const match: CorrelationMatch = {
      launchId: pending.launchId,
      agentId: pending.agentId,
      originConnId: pending.originConnId,
      clientRequestId: pending.clientRequestId,
      processId: pending.processId,
      sessionId,
    }
    // Park the match for the deferred `new_session` echo. Inheriting the
    // launch's `expiresAt` bounds it: a match whose `new_session` never
    // fires is GC'd, and `clear()` drops it on re-pair so it cannot leak
    // across a pairing boundary.
    this.sidecarMatchBySessionId.set(sessionId, { match, expiresAt: pending.expiresAt })
    return match
  }

  /**
   * Drain the deferred sidecar-correlation match for `sessionId` (parked
   * by `consumeLaunchByIdAndOwn`), for the `new_session` listener to do
   * the echo / auto-subscribe / catch-up wiring (§7.3.2.1 (S-3)). Returns
   * `null` (and removes nothing) when there is no parked match — e.g. the
   * session was correlated via the agentId-keyed `correlateNewSession`
   * path, or a re-pair `clear()` already dropped it. Removes the entry on
   * a hit so the echo happens at most once.
   */
  takeSidecarMatch(sessionId: string): CorrelationMatch | null {
    this.gcExpired()
    const entry = this.sidecarMatchBySessionId.get(sessionId)
    if (entry === undefined) return null
    this.sidecarMatchBySessionId.delete(sessionId)
    return entry.match
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
      processId: pending.processId,
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
    // Deferred sidecar-correlation matches are ownership-bearing state:
    // dropping them here is what prevents a pre-repair match from being
    // echoed across the fresh pairing boundary (§7.2.1).
    this.sidecarMatchBySessionId.clear()
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
    // GC deferred matches whose `new_session` never fired within the
    // launch TTL (bounds the map; the match is unrecoverable past TTL).
    for (const [sessionId, entry] of this.sidecarMatchBySessionId) {
      if (entry.expiresAt <= t) this.sidecarMatchBySessionId.delete(sessionId)
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
