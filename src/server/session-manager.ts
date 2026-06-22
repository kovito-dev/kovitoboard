/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { watcherLogger } from './logger'
import { EventEmitter } from 'events'
import type { Session, SessionSummary, SessionStats, ParsedEvent, SessionOrigin } from './types'

/**
 * Pending session-origin reservation (DEC-020 / EU8).
 *
 * The HTTP layer knows the origin (`sidebar` | `sessions`) and the
 * `agentId` at the moment a new Claude process is launched, but does
 * not yet know the JSONL `sessionId` Claude will assign. We park the
 * intent in this queue and consume the oldest matching entry when the
 * watcher later calls `setAgentId` for that session. If no reservation
 * is found within `RESERVATION_TTL_MS`, the entry is dropped silently
 * and the session keeps its default origin (`'sessions'`).
 */
interface OriginReservation {
  agentId: string
  origin: SessionOrigin
  expiresAt: number
}

const RESERVATION_TTL_MS = 60_000

/**
 * Read-only callback that resolves a materialising session to an
 * in-flight external-client launch via the per-PID sidecar
 * (external-client-api.md §7.3.2.1 (S-1)/(S-2)/(S-6), BL-2026-285).
 *
 * The callback (wired in `index.ts`) owns the PID resolution → sidecar
 * read → launch-causality five-point check AND the atomic exact-launchId
 * consume-then-own ((S-3)). It returns `{ launchId, agentId }` ONLY when
 * a unique in-flight ext launch proved launch-causality for `sessionId`
 * AND its launch entry was successfully consumed; it returns `null` in
 * every other case (no match / ambiguous / sidecar absent / schema
 * mismatch / launch already consumed / not injected). This keeps the
 * `SessionManager` free of any sidecar reader / tmux / OwnershipRegistry
 * dependency (layer separation INV-ORIGIN-1 / M-2): the manager only
 * stamps `origin='extension'` + `agentId` on a non-null result, and
 * never over-delivers on a `null` (fail-closed, under-delivery).
 */
export type ResolveExtLaunchSession = (args: {
  sessionId: string
  projectPath: string
}) => { launchId: string; agentId: string } | null

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private statusTimers = new Map<string, NodeJS.Timeout>()
  // Initializing flag: while true, skip status updates (keep existing sessions as idle)
  private initializing = true
  // FIFO queue of origin reservations awaiting setAgentId resolution.
  private originReservations: OriginReservation[] = []
  // Read-only sidecar-correlation callback (§7.3.2.1, BL-2026-285).
  // Optional: when unset (e.g. tests not exercising the ext path), the
  // `'extension'` narrowing simply skips (old R-5 under-delivery) — never
  // over-delivers.
  private resolveExtLaunchSession: ResolveExtLaunchSession | null = null

  /**
   * Inject the read-only sidecar-correlation resolver (§7.3.2.1 (S-2),
   * wired in `index.ts`). Kept as a setter (not a constructor arg) so the
   * existing `new SessionManager()` call sites and tests are unchanged;
   * the resolver is attached during server wiring after the registry /
   * sidecar reader / tmux bridge it closes over are constructed.
   */
  setExtLaunchResolver(resolver: ResolveExtLaunchSession): void {
    this.resolveExtLaunchSession = resolver
  }

  getSessions(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.stats.userMessages > 0 || s.stats.assistantMessages > 0)
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())
      .map((s) => this.toSummary(s))
  }

  getSession(id: string): Session | null {
    return this.sessions.get(id) || null
  }

  ensureSession(sessionId: string, projectPath: string, filePath: string): Session {
    let session = this.sessions.get(sessionId)
    if (session) {
      // Reconcile retry for sidecar-correlation (§7.3.2.1 (S-7)): a
      // write-race (sidecar.sessionId not yet updated when the JSONL
      // materialised) makes the create-time stamp attempt below skip. A
      // later live `change` / reconcile tick re-enters `ensureSession`
      // for the now-existing session; re-attempt the stamp while the
      // session is still unbound, so the launch is recovered once the
      // sidecar catches up (within the launch TTL). Idempotent: the
      // resolver consumes the launch exactly once, so a session that was
      // already stamped (origin set) is not re-attempted.
      if (!session.origin) {
        this.tryStampExtLaunch(session, projectPath)
      }
      return session
    }
    if (!session) {
      // Project name: restore directory name from path hash
      const projectName = this.extractProjectName(projectPath)
      const now = new Date().toISOString()
      session = {
        id: sessionId,
        projectPath,
        projectName,
        filePath,
        status: 'idle',
        events: [],
        lastEventAt: now,
        startedAt: now,
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0
        }
      }
      this.sessions.set(sessionId, session)
      // new_session event fires on first message addition (to exclude empty sessions from the list)

      // Eagerly claim the single pending origin reservation for this newly
      // created session. Claude Code only emits an `agent-setting` event on
      // process launch (when `--agent <id>` is passed), NOT on the new
      // session that follows a `/clear`. Without this fallback, sessions
      // created via `clearAndSendMessage` would never be tied to an agent
      // or origin, so the sidebar fails to recognize them as its own and
      // the Sessions screen displays the default agent name. If a real
      // `agent-setting` event arrives later, `setAgentId()` still overrides
      // these values, so this remains compatible with the original flow.
      //
      // We also emit `agent_claimed` so listeners (index.ts) can persist
      // the mapping to `.kovitoboard/session-agents.jsonl`. Without that
      // persistence the association is lost on the next server restart —
      // the new JSONL file has no `agent-setting` event to replay, and
      // the session reverts to the default display name.
      //
      // The eager claim fires ONLY when exactly one reservation remains
      // after GC (spec session-management.md §7.4.2, BL-2026-258). This
      // queue carries no JSONL `sessionId` at reserve time, so the claim
      // site has no way to tell which reservation a freshly created session
      // belongs to — it can only take the queue head. When two or more
      // reservations from different agents race within the TTL window,
      // taking the head would mis-bind the session to the wrong agent and
      // persist that wrong mapping across restarts. We therefore skip the
      // eager claim while the queue is ambiguous (length !== 1) and defer
      // resolution to the `setAgentId` path, whose `consumeOriginReservation`
      // matches by `agentId` (findIndex). The trade-off: a `/clear`-spawned
      // session with no `agent-setting` event that lands during an ambiguous
      // window stays unbound (TTL-expiring to the default `'sessions'`
      // origin) rather than risking a wrong, persisted binding — mis-binding
      // (permanent) is worse than non-binding (transient), matching the
      // §7.5.3 INV-1 priority.
      //
      // Additional narrowing for the external-client API (spec
      // session-management.md §7.4.2.1 + external-client-api.md §7.3.2):
      // an `'extension'` reservation is ALSO excluded from the eager claim
      // (the `origin !== 'extension'` AND below). The eager claim binds the
      // queue head WITHOUT matching on `agentId`, so on the shared FIFO an
      // unrelated `/clear`-spawned session (e.g. a renderer launch) that
      // materialises while an ext launch's `'extension'` reservation is the
      // sole pending entry would steal that reservation, get stamped
      // `origin='extension'`, and be mis-attributed to the ext owned-session
      // registry — a cross-path, permanent (persisted via `agent_claimed`,
      // surviving restart) mis-ownership that violates the data-minimisation
      // contract. We therefore route `'extension'` reservations EXCLUSIVELY
      // through the launchId-correlation path (external-client-api.md §7.3.1
      // step 4, agentId-matched), never the agentId-blind eager claim. The
      // accepted cost is the R-5 correlation loss (§7.3.2.1): a
      // `/clear`-spawned ext session for an already-running agent leaves its
      // `'extension'` reservation to TTL-expire unbound (transient,
      // ext-scoped, no renderer impact, no eager-claim mis-ownership) —
      // under-delivery, not over-delivery. Non-`'extension'` origins keep
      // the original single-reservation eager-claim behaviour unchanged.
      this.gcExpiredReservations()
      if (
        this.originReservations.length === 1 &&
        this.originReservations[0].origin !== 'extension'
      ) {
        const claimed = this.originReservations.shift()!
        session.agentId = claimed.agentId
        session.origin = claimed.origin
        this.emit('agent_claimed', sessionId, claimed.agentId)
      } else {
        // §7.3.2.1 sidecar-correlation (BL-2026-285): the eager claim
        // above is intentionally skipped for `'extension'` reservations
        // (and ambiguous queues). Immediately after that skip, attempt to
        // recover an ext launch's correlation via the per-PID sidecar
        // (launch-causality, NOT the agentId-blind eager claim). This is
        // the only place the materialising `/clear`-spawned session for
        // an already-running agent can be stamped `origin='extension'` —
        // it carries no `agent-setting` event, so `setAgentId` /
        // `consumeOriginReservation` never fire (old R-5). The resolver
        // fail-closes (no stamp) on any ambiguity / sidecar absence, so
        // this never over-delivers.
        this.tryStampExtLaunch(session, projectPath)
      }
    }
    return session
  }

  /**
   * Attempt the sidecar-correlation `'extension'` stamp on a just- /
   * still-unbound session (external-client-api.md §7.3.2.1 (S-1)/(S-3)).
   * Delegates the PID resolution → sidecar read → launch-causality check
   * → atomic exact-launchId consume-then-own to the injected read-only
   * resolver (M-2 layer separation). On a non-null result the manager
   * stamps `origin='extension'` + `agentId` and emits `agent_claimed`
   * (same persistence path as the eager claim, so the mapping survives
   * restart). A `null` result (no resolver / no match / ambiguous /
   * sidecar absent / already consumed) leaves the session unbound
   * (under-delivery, R-5'); it NEVER stamps speculatively.
   *
   * Stamp-after-consume ordering ((S-3)): the resolver performs the
   * atomic consume and ownership add, then returns; the stamp runs
   * synchronously on the returned value with no intervening await, so a
   * successful consume always commits a stamp and a failed consume
   * (`null`) commits none — no "stamped but launch un-consumed" state.
   */
  private tryStampExtLaunch(session: Session, projectPath: string): void {
    if (session.origin) return
    const resolver = this.resolveExtLaunchSession
    if (!resolver) return
    let match: { launchId: string; agentId: string } | null
    try {
      match = resolver({ sessionId: session.id, projectPath })
    } catch {
      // Resolver threw → fail-closed (under-delivery), never over-deliver.
      return
    }
    if (!match) return
    session.agentId = match.agentId
    session.origin = 'extension'
    // The ext launch parked an `'extension'` reservation in
    // `startExtSession`; the narrowing deliberately leaves it for the
    // `setAgentId` path, but a `/clear`-spawned session never gets an
    // `agent-setting` event, so it would otherwise linger for the full
    // TTL. Now that sidecar-correlation has resolved this launch, cancel
    // that reservation so it does not keep `hasPendingReservation(agentId)`
    // true — which would reject the next ext launch for this agent (and
    // sit stale in the shared FIFO) for up to the reservation TTL.
    this.cancelReservation(match.agentId, 'extension')
    this.emit('agent_claimed', session.id, match.agentId)

    // Drive the `new_session` echo / auto-subscribe / catch-up for the
    // extension. Normally the `new_session` event (fired by `addEvents`
    // on the empty → non-empty transition) triggers that wiring after
    // the stamp. But in the (S-7) reconcile-retry case the sidecar can
    // catch up only AFTER the first message already fired `new_session`
    // (a write-race where the JSONL materialised before the sidecar
    // updated): `addEvents` emits `new_session` ONLY on the first
    // transition, so no later `new_session` will fire and the parked
    // match would never be drained → the recovery still under-delivers.
    // When the session is already non-empty at stamp time, emit a
    // dedicated `ext_session_correlated` event carrying the summary so
    // `index.ts` can run the same echo wiring immediately. The empty
    // case is left to the upcoming `new_session` (no double echo).
    const isNonEmpty =
      session.stats.userMessages > 0 || session.stats.assistantMessages > 0
    if (isNonEmpty) {
      this.emit('ext_session_correlated', this.toSummary(session))
    }
  }

  setAgentId(sessionId: string, agentId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.agentId = agentId
    // Resolve session origin from any pending reservation matching this
    // agentId. Idempotent — once `origin` is set we leave it alone.
    if (!session.origin) {
      const matched = this.consumeOriginReservation(agentId)
      if (matched) {
        session.origin = matched
      }
    }
  }

  /**
   * Reserve a `SessionOrigin` for the next session that will be created
   * with `agentId`. The HTTP layer calls this immediately before
   * launching a new Claude process; the watcher later resolves the
   * match in `setAgentId`. Reservations expire after
   * `RESERVATION_TTL_MS` so a never-matched entry does not leak.
   */
  reserveOrigin(agentId: string, origin: SessionOrigin): void {
    this.gcExpiredReservations()
    this.originReservations.push({
      agentId,
      origin,
      expiresAt: Date.now() + RESERVATION_TTL_MS,
    })
  }

  /**
   * Cancel the most recently parked reservation matching `agentId` +
   * `origin`. Added for the external-client API: when an ext launch
   * fails AFTER `reserveOrigin('extension')` but before any session
   * materialises, the caller cancels the reservation so it does not
   * linger for the full TTL — which would otherwise block the next ext
   * launch for that agent (`hasPendingReservation`) and could mis-tag a
   * later session as `'extension'`. Removes at most one matching entry
   * (LIFO, the one this caller just parked); returns whether one was
   * removed. Other callers' reservations are untouched.
   */
  cancelReservation(agentId: string, origin: SessionOrigin): boolean {
    for (let i = this.originReservations.length - 1; i >= 0; i--) {
      const r = this.originReservations[i]
      if (r.agentId === agentId && r.origin === origin) {
        this.originReservations.splice(i, 1)
        return true
      }
    }
    return false
  }

  /**
   * Read-only check: is there a live (non-expired) origin reservation
   * for `agentId`? Added for the external-client API (§7.3.1 step 1):
   * an ext launch is rejected while ANY pending reservation exists for
   * the same agentId — across renderer / sidebar / ext / internal
   * paths — so the shared FIFO cannot mis-bind an ext reservation to a
   * renderer-started session. This does NOT consume the reservation and
   * does NOT change any existing behaviour (additive, INV-ORIGIN-1).
   */
  hasPendingReservation(agentId: string): boolean {
    this.gcExpiredReservations()
    return this.originReservations.some((r) => r.agentId === agentId)
  }

  /** Pull the oldest non-expired reservation matching `agentId`. */
  private consumeOriginReservation(agentId: string): SessionOrigin | null {
    this.gcExpiredReservations()
    const idx = this.originReservations.findIndex((r) => r.agentId === agentId)
    if (idx < 0) return null
    const [entry] = this.originReservations.splice(idx, 1)
    return entry.origin
  }

  private gcExpiredReservations(): void {
    const now = Date.now()
    this.originReservations = this.originReservations.filter((r) => r.expiresAt > now)
  }

  /**
   * Set all active sessions for the specified agent to idle.
   * Used to terminate existing sessions when a new session starts.
   */
  deactivateAgentSessions(agentId: string): string[] {
    const deactivated: string[] = []
    for (const [id, session] of this.sessions) {
      if (session.agentId === agentId && session.status !== 'idle') {
        session.status = 'idle'
        // Clear idle timer as well (no longer needed since already idle)
        const timerId = this.statusTimers.get(id)
        if (timerId) {
          clearTimeout(timerId)
          this.statusTimers.delete(id)
        }
        this.emit('status_change', id, 'idle')
        deactivated.push(id)
      }
    }
    return deactivated
  }

  /**
   * Notify that initial loading is complete.
   * Called after the Watcher's ready event.
   */
  setInitialized(): void {
    this.initializing = false
    watcherLogger.info(`[SessionManager] Initialization complete: ${this.sessions.size} sessions loaded`)
  }

  /** Returns a map of session ID to agent ID */
  getSessionAgentMap(): Record<string, string> {
    const map: Record<string, string> = {}
    for (const [id, session] of this.sessions) {
      if (session.agentId) {
        map[id] = session.agentId
      }
    }
    return map
  }

  /**
   * Append parsed events to a session.
   *
   * `opts.historical` marks the events as restored-on-startup content
   * rather than genuinely-live activity. When set, the
   * `status` is left untouched (the session stays `idle`), but stats are
   * still aggregated and `new_event` / `new_session` are still emitted so
   * the restored session appears in the list with correct counts. This is
   * the per-file restoration signal computed by the Watcher: the same
   * pre-existing terminal `end_turn` line that previously got "branded"
   * onto `status` after `ready` (causing a spurious non-idle status until
   * the 5-minute idle timer fired) is now ignored for status purposes.
   *
   * The decision is per-file, not a global time flag: a file is historical
   * until its first full drain to EOF completes, after which genuinely-live
   * appends update `status` normally (INV-2). See watcher.ts `handleFile`.
   */
  addEvents(
    sessionId: string,
    events: ParsedEvent[],
    opts?: { historical?: boolean },
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Determine whether to fire new_session on first message addition
    const wasEmpty = session.stats.userMessages === 0 && session.stats.assistantMessages === 0

    for (const event of events) {
      session.events.push(event)
      session.lastEventAt = event.timestamp

      // Update stats (restored sessions must still appear with correct
      // counts, so stats run even for historical events).
      this.updateStats(session.stats, event)

      // Update status (skipped for historical events so a restored
      // terminal line does not brand a non-idle status — INV-1).
      this.updateStatus(session, event, opts?.historical)

      this.emit('new_event', sessionId, event)
    }

    // First message added to a previously empty session → notify new_session
    if (wasEmpty && (session.stats.userMessages > 0 || session.stats.assistantMessages > 0)) {
      const summary = this.toSummary(session)
      this.emit('new_session', summary)
    }
  }

  private updateStats(stats: SessionStats, event: ParsedEvent): void {
    switch (event.type) {
      case 'user':
        stats.userMessages++
        break
      case 'assistant':
        stats.assistantMessages++
        break
      case 'tool_use':
        stats.toolCalls++
        break
    }
    if (event.metadata.inputTokens) stats.totalInputTokens += event.metadata.inputTokens
    if (event.metadata.outputTokens) stats.totalOutputTokens += event.metadata.outputTokens
  }

  private updateStatus(session: Session, event: ParsedEvent, historical?: boolean): void {
    // Skip status updates during initial loading (existing sessions remain
    // idle) or for historical (restored-on-startup) events. `historical` is
    // the per-file restoration signal: even after the global
    // `initializing` flag clears at `ready`, a pre-existing JSONL whose
    // first full read lands after `ready` must not brand its terminal
    // `end_turn` onto `status`. The global flag alone cannot cover this
    // because `ready` and "every existing file's initial read completed"
    // are not the same instant (drop/reorder/partial-hold paths).
    if (this.initializing || historical) return

    const oldStatus = session.status

    if (event.type === 'user') {
      // Tool rejections / Esc interrupts end the agent turn — Claude
      // Code does NOT emit a follow-up assistant message. Treat them
      // as `ready` so the typing indicator dismisses and the user can
      // type the next instruction. See parser.ts for the sentinel
      // patterns and shared/types.ts for the EventMetadata.interrupted
      // field documentation.
      if (event.metadata.interrupted === 'user-interrupt') {
        session.status = 'ready'
      } else {
        session.status = 'waiting'
      }
    } else if (event.type === 'tool_result' && event.metadata.interrupted === 'tool-rejected') {
      // The rejected `tool_result` itself does not necessarily end the
      // turn (Claude Code follows up with the `user-interrupt`
      // sentinel right after), but we still flip to `ready` here so a
      // misbehaving session that omits the follow-up is not stuck.
      session.status = 'ready'
    } else if (event.type === 'assistant' || event.type === 'tool_use') {
      // stop_reason is end_turn → response complete, awaiting next input (ready)
      // Otherwise → still processing (thinking)
      if (event.metadata.stopReason === 'end_turn') {
        session.status = 'ready'
      } else {
        session.status = 'thinking'
      }
    }

    // Idle timer: transition to idle after 5 minutes of no events
    const timerId = this.statusTimers.get(session.id)
    if (timerId) clearTimeout(timerId)

    this.statusTimers.set(
      session.id,
      setTimeout(() => {
        if (session.status !== 'idle') {
          session.status = 'idle'
          this.emit('status_change', session.id, 'idle')
        }
      }, 5 * 60 * 1000)
    )

    if (session.status !== oldStatus) {
      this.emit('status_change', session.id, session.status)
    }
  }

  private extractProjectName(projectPath: string): string {
    // "-home-user-some-workspace" → "some-workspace"
    const parts = projectPath.replace(/^-/, '').split('-')
    // Extract the last meaningful parts
    if (parts.length >= 2) {
      return parts.slice(-2).join('-')
    }
    return parts[parts.length - 1] || projectPath
  }

  private toSummary(s: Session): SessionSummary {
    const lastUserEvent = [...s.events].reverse().find((e) => e.type === 'user')
    return {
      id: s.id,
      projectName: s.projectName,
      projectPath: s.projectPath,
      status: s.status,
      agentId: s.agentId,
      origin: s.origin,
      lastEventAt: s.lastEventAt,
      startedAt: s.startedAt,
      stats: { ...s.stats },
      lastMessage: lastUserEvent?.content.text?.slice(0, 80)
    }
  }
}
