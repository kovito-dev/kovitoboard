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

  it('uses FIFO order when multiple reservations are queued', () => {
    // Two new-session requests fired in quick succession before the
    // watcher catches up — each must land on the right reservation.
    mgr.reserveOrigin('agent-a', 'sessions')
    mgr.reserveOrigin('agent-b', 'sidebar')

    const first = mgr.ensureSession('sess-a', '/proj', '/proj/.../sess-a.jsonl')
    const second = mgr.ensureSession('sess-b', '/proj', '/proj/.../sess-b.jsonl')

    expect(first.agentId).toBe('agent-a')
    expect(first.origin).toBe('sessions')
    expect(second.agentId).toBe('agent-b')
    expect(second.origin).toBe('sidebar')
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
