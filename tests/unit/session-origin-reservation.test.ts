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
