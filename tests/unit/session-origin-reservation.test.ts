/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * SS-1 fix: SessionManager origin-reservation behavior for the
 * Q13 / AA-7 default agent.
 *
 * Background
 * ----------
 * Claude Code only emits an `agent-setting` event when launched with
 * `--agent <id>`. The system default agent (`__claude_default__`) is
 * spawned via plain `claude`, so the watcher never sees that event and
 * `setAgentId` never fires. Without a fallback the session stays
 * un-tagged, and the agent-activity-monitor cannot resolve which
 * session a given tmux window belongs to → the typing indicator goes
 * silent.
 *
 * Fix
 * ---
 * Callers that own the (windowName, agentId) mapping (sidebar, recipe
 * install, /api/tmux/clear-and-send, etc.) park an `OriginReservation`
 * before kicking off the /clear + send pair. The next `ensureSession`
 * shifts the oldest reservation off the queue and stamps both
 * `session.agentId` and `session.origin`. These tests pin that
 * behavior so a future refactor cannot regress the default agent.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionManager } from '../../src/server/session-manager'

const SYSTEM_DEFAULT_AGENT_ID = '__claude_default__'

describe('SessionManager origin reservation (SS-1)', () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager()
  })

  it('claims agentId on first ensureSession after reserveOrigin', () => {
    // Caller (e.g. AgentDetailPage via /api/tmux/clear-and-send)
    // reserves the upcoming session right before /clear-and-send.
    mgr.reserveOrigin(SYSTEM_DEFAULT_AGENT_ID, 'sessions')

    // Watcher later observes the new JSONL and calls ensureSession.
    const session = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(session.agentId).toBe(SYSTEM_DEFAULT_AGENT_ID)
    expect(session.origin).toBe('sessions')
  })

  it('exposes the claimed agentId via getSessionAgentMap', () => {
    // Replicates the path agent-activity-monitor walks: the monitor
    // reads `getSessionAgentMap()` and looks for an entry where the
    // value matches the tmux windowName (= agentId). This integration
    // proves the SS-1 fix is observable by the monitor.
    mgr.reserveOrigin(SYSTEM_DEFAULT_AGENT_ID, 'sessions')
    mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    const map = mgr.getSessionAgentMap()
    expect(map['sess-1']).toBe(SYSTEM_DEFAULT_AGENT_ID)
  })

  it('skips the eager claim while the queue is ambiguous and resolves via setAgentId (BL-2026-258)', () => {
    // Two reservations from DIFFERENT agents race within the TTL window.
    // The eager claim has no JSONL sessionId to disambiguate against, so
    // taking the queue head could mis-bind a session to the wrong agent.
    // Per spec session-management.md §7.4.2 the eager claim fires ONLY
    // when exactly one reservation remains, so here both ensureSession
    // calls leave the session unbound and defer to the `agent-setting`
    // path. setAgentId then matches by agentId (consumeOriginReservation
    // findIndex), binding each session to its TRUE agent regardless of
    // queue order — proving the mis-claim path is closed.
    mgr.reserveOrigin('agent-a', 'sessions')
    mgr.reserveOrigin('agent-b', 'sidebar')

    const first = mgr.ensureSession('sess-a', '/proj', '/proj/.../sess-a.jsonl')
    const second = mgr.ensureSession('sess-b', '/proj', '/proj/.../sess-b.jsonl')

    // Ambiguous queue (length 2): no eager claim on either session.
    expect(first.agentId).toBeUndefined()
    expect(first.origin).toBeUndefined()
    expect(second.agentId).toBeUndefined()
    expect(second.origin).toBeUndefined()

    // The watcher later parses each session's `agent-setting` line and
    // calls setAgentId. Resolve them OUT of queue order to prove the
    // binding follows agentId, not FIFO position.
    mgr.setAgentId('sess-b', 'agent-b')
    mgr.setAgentId('sess-a', 'agent-a')

    expect(first.agentId).toBe('agent-a')
    expect(first.origin).toBe('sessions')
    expect(second.agentId).toBe('agent-b')
    expect(second.origin).toBe('sidebar')
  })

  it('does not eager-claim and does not emit agent_claimed for an ambiguous queue (BL-2026-258)', () => {
    // Reinforces the §7.4.2 guard: with 2+ reservations pending, the
    // eager claim must neither stamp agentId/origin nor fire the
    // agent_claimed persistence hook (which would otherwise write a
    // wrong, restart-surviving mapping to session-agents.jsonl).
    const emitted: Array<{ sessionId: string; agentId: string }> = []
    mgr.on('agent_claimed', (sessionId: string, agentId: string) => {
      emitted.push({ sessionId, agentId })
    })

    mgr.reserveOrigin('agent-a', 'sessions')
    mgr.reserveOrigin('agent-b', 'sidebar')
    mgr.ensureSession('sess-x', '/proj', '/proj/.../sess-x.jsonl')

    expect(emitted).toEqual([])
  })

  it('leaves agentId untouched when no reservation is pending', () => {
    // Pre-existing sessions discovered at startup must not pick up a
    // stale reservation from a later launch. ensureSession with an
    // empty queue should leave session.agentId undefined so the
    // watcher's `agent-setting` handler can take over.
    const session = mgr.ensureSession('sess-old', '/proj', '/proj/.../sess-old.jsonl')

    expect(session.agentId).toBeUndefined()
    expect(session.origin).toBeUndefined()
  })

  it('does not re-claim a reservation for the SAME sessionId', () => {
    // ensureSession is idempotent: repeated calls (each watcher tick)
    // must not pull a second reservation off the queue and overwrite
    // a different agent's mapping.
    mgr.reserveOrigin('agent-a', 'sessions')
    const first = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    mgr.reserveOrigin('agent-b', 'sidebar')
    const second = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(first).toBe(second)
    expect(second.agentId).toBe('agent-a')
    expect(second.origin).toBe('sessions')
  })

  it('hasPendingReservation reports a live reservation without consuming it', () => {
    // External-client API §7.3.1: the ext path checks this read-only
    // before launching. It must not consume the reservation.
    expect(mgr.hasPendingReservation('agent-a')).toBe(false)
    mgr.reserveOrigin('agent-a', 'extension')
    expect(mgr.hasPendingReservation('agent-a')).toBe(true)
    // The read-only check does not drain the reservation: it is still
    // present afterwards. (Whether ensureSession then eager-claims it is
    // covered by the narrowing tests below — for `'extension'` it does
    // NOT, by spec §7.4.2.1.)
    expect(mgr.hasPendingReservation('agent-a')).toBe(true)
  })

  it('cancelReservation removes a parked reservation (failed ext launch cleanup)', () => {
    mgr.reserveOrigin('agent-a', 'extension')
    expect(mgr.hasPendingReservation('agent-a')).toBe(true)
    expect(mgr.cancelReservation('agent-a', 'extension')).toBe(true)
    expect(mgr.hasPendingReservation('agent-a')).toBe(false)
    // A later session for the same agent is no longer mis-tagged.
    const sess = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')
    expect(sess.origin).toBeUndefined()
  })

  it('cancelReservation only removes a matching agentId + origin pair', () => {
    mgr.reserveOrigin('agent-a', 'extension')
    mgr.reserveOrigin('agent-b', 'sidebar')
    expect(mgr.cancelReservation('agent-a', 'sidebar')).toBe(false)
    expect(mgr.cancelReservation('agent-a', 'extension')).toBe(true)
    expect(mgr.hasPendingReservation('agent-b')).toBe(true)
  })

  it('emits agent_claimed when the reservation lands', () => {
    // index.ts subscribes to `agent_claimed` to persist the mapping
    // to .kovitoboard/session-agents.jsonl. Lose the event and the
    // tag disappears across restarts — the SS-1 fix must keep this
    // hook firing for default-agent sessions too.
    const emitted: Array<{ sessionId: string; agentId: string }> = []
    mgr.on('agent_claimed', (sessionId: string, agentId: string) => {
      emitted.push({ sessionId, agentId })
    })

    mgr.reserveOrigin(SYSTEM_DEFAULT_AGENT_ID, 'sessions')
    mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(emitted).toEqual([{ sessionId: 'sess-1', agentId: SYSTEM_DEFAULT_AGENT_ID }])
  })
})

/**
 * Eager-claim narrowing for the external-client API.
 *
 * Spec: session-management.md §7.4.2.1 + external-client-api.md §7.3.2.
 *
 * The single-reservation eager claim binds the queue head WITHOUT matching
 * on agentId. On the shared origin-reservation FIFO that lets an unrelated
 * `/clear`-spawned session steal an `'extension'` reservation that happens
 * to be the sole pending entry, mis-stamping a non-ext (e.g. renderer)
 * session as `origin='extension'` and persisting that wrong mapping via
 * `agent_claimed` (cross-path, permanent, restart-surviving mis-ownership).
 *
 * The fix excludes `'extension'` reservations from the eager claim and
 * routes them exclusively through the launchId-correlation / setAgentId
 * (agentId-matched) path. The accepted cost is the R-5 correlation loss
 * (§7.3.2.1): a `/clear`-spawned ext session for an already-running agent
 * leaves its reservation to TTL-expire unbound (transient, ext-scoped,
 * under-delivery). These tests pin both the narrowing and its accepted
 * residual so a future refactor cannot regress them.
 */
describe('SessionManager eager-claim narrowing — extension exclusion (§7.4.2.1)', () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager()
  })

  it('does NOT eager-claim a sole `extension` reservation', () => {
    // §7.3.2: with a single `'extension'` reservation pending, an
    // unrelated session that materialises must NOT pick it up. Without
    // the narrowing this stamps the session `origin='extension'` and
    // mis-attributes it to the ext owned-session registry.
    mgr.reserveOrigin('agent-a', 'extension')

    const session = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    // The sole eager-claim site is bypassed for `'extension'`: the
    // session is left unbound (no agentId, no origin stamp).
    expect(session.agentId).toBeUndefined()
    expect(session.origin).toBeUndefined()
  })

  it('does NOT emit agent_claimed for a sole `extension` reservation', () => {
    // The agentId-blind eager claim is what persists the mapping via
    // `agent_claimed` (-> session-agents.jsonl, restart-surviving). The
    // narrowing must suppress that emit so no wrong mapping is persisted.
    const emitted: Array<{ sessionId: string; agentId: string }> = []
    mgr.on('agent_claimed', (sessionId: string, agentId: string) => {
      emitted.push({ sessionId, agentId })
    })

    mgr.reserveOrigin('agent-a', 'extension')
    mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(emitted).toEqual([])
  })

  it('leaves a sole `extension` reservation pending after ensureSession (not drained by the bypassed claim)', () => {
    // The bypassed eager claim must not consume the reservation: it stays
    // on the queue so the agentId-matched correlation path (§7.3.1 step 4
    // / setAgentId) can still resolve it.
    mgr.reserveOrigin('agent-a', 'extension')
    mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(mgr.hasPendingReservation('agent-a')).toBe(true)
  })

  it('still resolves an `extension` reservation via the agentId-matched setAgentId path (§7.3.1 step 4)', () => {
    // Narrowing only removes the agentId-BLIND eager claim. The normal
    // correlation path — watcher parses `agent-setting`, calls setAgentId,
    // which consumeOriginReservation matches by agentId — must still bind
    // the ext session correctly. This is the happy path (justStarted ===
    // true) that is unaffected by R-5.
    mgr.reserveOrigin('agent-a', 'extension')
    const session = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    // Unbound right after creation (eager claim skipped)...
    expect(session.origin).toBeUndefined()

    // ...then resolved by the agentId-matched path.
    mgr.setAgentId('sess-1', 'agent-a')
    expect(session.agentId).toBe('agent-a')
    expect(session.origin).toBe('extension')
  })

  it('accepts R-5: a `/clear`-spawned ext session with no agent-setting stays unbound and TTL-expires (under-delivery, transient)', () => {
    // §7.3.2.1 R-5 acceptance, made explicit. When ext launches against an
    // ALREADY-RUNNING agent, the new session is `/clear`-spawned and emits
    // NO `agent-setting` event, so setAgentId never fires. With the eager
    // claim now bypassed for `'extension'`, the reservation is never
    // consumed: the session stays unbound (default origin), and the ext
    // owned-session registry never gets this session. This is the ACCEPTED
    // residual — under-delivery (the ext cannot correlate its own launch),
    // NOT over-delivery, and crucially NO eager-claim mis-ownership.
    mgr.reserveOrigin('agent-a', 'extension')

    // /clear-spawned session: ensureSession runs but no agent-setting ever
    // arrives, so setAgentId is never called for this session.
    const session = mgr.ensureSession('sess-clear', '/proj', '/proj/.../sess-clear.jsonl')

    // Accepted: the session is NOT bound to `'extension'` and is NOT
    // mis-owned by any other agent. It remains unbound.
    expect(session.origin).toBeUndefined()
    expect(session.agentId).toBeUndefined()

    // The reservation lingers until TTL (it is not eager-claimed). It does
    // not mis-tag this session; the residual is transient (TTL-expiring),
    // leaving no permanent, restart-surviving wrong mapping.
    expect(mgr.hasPendingReservation('agent-a')).toBe(true)
  })

  it('REGRESSION: a sole non-`extension` reservation is still eager-claimed (sessions)', () => {
    // The narrowing must NOT touch other origins. A single `'sessions'`
    // reservation must still be eager-claimed exactly as before
    // (session-management.md §7.4.2 unchanged for non-extension).
    const emitted: Array<{ sessionId: string; agentId: string }> = []
    mgr.on('agent_claimed', (sessionId: string, agentId: string) => {
      emitted.push({ sessionId, agentId })
    })

    mgr.reserveOrigin('agent-a', 'sessions')
    const session = mgr.ensureSession('sess-1', '/proj', '/proj/.../sess-1.jsonl')

    expect(session.agentId).toBe('agent-a')
    expect(session.origin).toBe('sessions')
    expect(emitted).toEqual([{ sessionId: 'sess-1', agentId: 'agent-a' }])
  })

  it('REGRESSION: a sole non-`extension` reservation is still eager-claimed (sidebar)', () => {
    mgr.reserveOrigin('agent-b', 'sidebar')
    const session = mgr.ensureSession('sess-2', '/proj', '/proj/.../sess-2.jsonl')

    expect(session.agentId).toBe('agent-b')
    expect(session.origin).toBe('sidebar')
  })
})
