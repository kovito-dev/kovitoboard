/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * SessionManager sidecar-correlation stamp tests (external-client-api.md
 * §7.3.2.1 (S-1)/(S-2)/(S-3)/(S-7) / §9.4, BL-2026-285).
 *
 * Pins the layer-separated stamp behaviour: the SessionManager only calls
 * the injected read-only `resolveExtLaunchSession` callback and stamps
 * `origin='extension'` + `agentId` on a non-null result. It NEVER reaches
 * into a sidecar reader / tmux / registry itself (M-2), and it NEVER
 * over-delivers on `null` (fail-closed = under-delivery, R-5'). The
 * resolver contract is mocked here; the real five-point launch-causality
 * check + atomic consume live in the index.ts wiring + ownership-registry
 * tests.
 */
import { describe, it, expect } from 'vitest'
import { SessionManager } from '../../src/server/session-manager'
import type { ParsedEvent } from '../../src/server/types'

/** Minimal `user` event that makes a session non-empty (bumps stats). */
function makeUserEvent(sessionId: string): ParsedEvent {
  return {
    id: `${sessionId}-1`,
    sessionId,
    type: 'user',
    timestamp: new Date().toISOString(),
    content: { text: 'hi' },
    metadata: {},
  } as unknown as ParsedEvent
}

describe('SessionManager — sidecar-correlation stamp (§7.3.2.1)', () => {
  it('stamps origin=extension + agentId when the resolver returns a match (S-1/S-3)', () => {
    const mgr = new SessionManager()
    const calls: Array<{ sessionId: string; projectPath: string }> = []
    mgr.setExtLaunchResolver((args) => {
      calls.push(args)
      return { launchId: 'L1', agentId: 'kb-pdm' }
    })

    const s = mgr.ensureSession('sess-1', '-home-u-proj', '/p/sess-1.jsonl')
    expect(s.origin).toBe('extension')
    expect(s.agentId).toBe('kb-pdm')
    // The resolver was consulted with the materialising session's id +
    // projectPath.
    expect(calls).toEqual([{ sessionId: 'sess-1', projectPath: '-home-u-proj' }])
  })

  it('emits agent_claimed so the mapping is persisted across restart', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => ({ launchId: 'L1', agentId: 'kb-pdm' }))
    const claimed: Array<[string, string]> = []
    mgr.on('agent_claimed', (sid: string, aid: string) => claimed.push([sid, aid]))
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(claimed).toEqual([['sess-1', 'kb-pdm']])
  })

  it('does NOT stamp (under-delivery) when the resolver returns null — never over-delivers (S-2)', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => null)
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s.origin).toBeUndefined()
    expect(s.agentId).toBeUndefined()
  })

  it('does NOT stamp when no resolver is injected (old R-5 under-delivery, never over-deliver)', () => {
    const mgr = new SessionManager()
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s.origin).toBeUndefined()
  })

  it('fail-closed when the resolver throws (no speculative stamp)', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => {
      throw new Error('sidecar read blew up')
    })
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s.origin).toBeUndefined()
    expect(s.agentId).toBeUndefined()
  })

  it('reconcile retry (S-7): a write-race skip is recovered on a later ensureSession once the sidecar catches up', () => {
    const mgr = new SessionManager()
    let ready = false
    let consumed = 0
    mgr.setExtLaunchResolver(() => {
      if (!ready) return null // sidecar.sessionId not yet updated → skip
      consumed++
      return { launchId: 'L1', agentId: 'kb-pdm' }
    })

    // First materialise: sidecar still points at the old sessionId → skip.
    const s1 = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s1.origin).toBeUndefined()

    // Sidecar catches up; a later live `change` / reconcile tick re-enters
    // ensureSession for the now-existing session → stamp succeeds.
    ready = true
    const s2 = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s2).toBe(s1) // same session object
    expect(s2.origin).toBe('extension')
    expect(s2.agentId).toBe('kb-pdm')
    expect(consumed).toBe(1)
  })

  it('emits ext_session_correlated when the stamp lands on an already-non-empty session (S-7 echo recovery)', () => {
    const mgr = new SessionManager()
    let ready = false
    mgr.setExtLaunchResolver(() => (ready ? { launchId: 'L1', agentId: 'kb-pdm' } : null))
    const correlated: unknown[] = []
    mgr.on('ext_session_correlated', (summary: unknown) => correlated.push(summary))

    // Write-race: first materialise skips (sidecar lagging), then the
    // first message fires `new_session` and makes the session non-empty.
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    mgr.addEvents('sess-1', [makeUserEvent('sess-1')])
    expect(correlated).toHaveLength(0) // not stamped yet

    // Sidecar catches up on a later reconcile tick: stamp succeeds on the
    // now-non-empty session → a dedicated correlated event drives the
    // echo (no second `new_session` will ever fire).
    ready = true
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(correlated).toHaveLength(1)
    expect((correlated[0] as { id: string; origin: string }).id).toBe('sess-1')
    expect((correlated[0] as { origin: string }).origin).toBe('extension')
  })

  it('does NOT emit ext_session_correlated when the stamp lands on an empty session (new_session handles it)', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => ({ launchId: 'L1', agentId: 'kb-pdm' }))
    const correlated: unknown[] = []
    mgr.on('ext_session_correlated', (summary: unknown) => correlated.push(summary))
    // Stamp at create time (session still empty) → rely on the upcoming
    // `new_session`; no dedicated correlated event (avoids double echo).
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(correlated).toHaveLength(0)
  })

  it('retryExtCorrelationForSession recovers a stamp WITHOUT any further ensureSession / file growth (S-7)', () => {
    const mgr = new SessionManager()
    let ready = false
    mgr.setExtLaunchResolver(() => (ready ? { launchId: 'L1', agentId: 'kb-pdm' } : null))
    const correlated: unknown[] = []
    mgr.on('ext_session_correlated', (summary: unknown) => correlated.push(summary))

    // Session materialises + gets its first message (fires new_session)
    // while the sidecar is still lagging → unbound.
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    mgr.addEvents('sess-1', [makeUserEvent('sess-1')])
    expect(s.origin).toBeUndefined()

    // The JSONL never grows again, so the watcher never calls
    // ensureSession for it. The reconcile-tick driver targets the session
    // named by the launch sidecar and must still recover the stamp once
    // the sidecar catches up.
    ready = true
    mgr.retryExtCorrelationForSession('sess-1')
    expect(s.origin).toBe('extension')
    expect(s.agentId).toBe('kb-pdm')
    // Non-empty at stamp time → drives the echo via the dedicated event.
    expect(correlated).toHaveLength(1)
  })

  it('retryExtCorrelationForSession is a no-op for unknown / already-bound sessions and when no resolver is set', () => {
    const mgrNoResolver = new SessionManager()
    mgrNoResolver.reserveOrigin('a', 'sidebar')
    const bound = mgrNoResolver.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(bound.origin).toBe('sidebar')
    // No resolver set → method returns immediately, leaves origin intact.
    mgrNoResolver.retryExtCorrelationForSession('sess-1')
    expect(bound.origin).toBe('sidebar')

    const mgr = new SessionManager()
    let calls = 0
    mgr.setExtLaunchResolver(() => {
      calls++
      return { launchId: 'L1', agentId: 'x' }
    })
    // Unknown sessionId → no resolver call.
    mgr.retryExtCorrelationForSession('nope')
    expect(calls).toBe(0)
    // Already-bound session → not re-stamped (resolver not called).
    mgr.reserveOrigin('side', 'sidebar')
    mgr.ensureSession('sess-2', '-p', '/p/sess-2.jsonl') // eager-claimed sidebar
    mgr.retryExtCorrelationForSession('sess-2')
    expect(calls).toBe(0)
  })

  it('does not re-consult the resolver once the session is already stamped (idempotent)', () => {
    const mgr = new SessionManager()
    let calls = 0
    mgr.setExtLaunchResolver(() => {
      calls++
      return { launchId: 'L1', agentId: 'kb-pdm' }
    })
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(calls).toBe(1)
    // Reconcile tick re-enters: origin already set → resolver not called
    // again (the launch is consumed exactly once).
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(calls).toBe(1)
  })

  it('does not run sidecar-correlation when a non-extension single reservation eager-claims (regression)', () => {
    const mgr = new SessionManager()
    let calls = 0
    mgr.setExtLaunchResolver(() => {
      calls++
      return { launchId: 'L1', agentId: 'x' }
    })
    // A lone non-extension reservation is eager-claimed as before; the
    // sidecar resolver must NOT run for it (the `else` branch is skipped).
    mgr.reserveOrigin('side-agent', 'sidebar')
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(s.origin).toBe('sidebar')
    expect(s.agentId).toBe('side-agent')
    expect(calls).toBe(0)
  })

  it('runs sidecar-correlation in the extension-reservation skip branch (primary R-5 path)', () => {
    const mgr = new SessionManager()
    let calls = 0
    mgr.setExtLaunchResolver(() => {
      calls++
      return { launchId: 'L1', agentId: 'kb-pdm' }
    })
    // The ext launch parked an 'extension' reservation; the eager claim
    // is intentionally skipped for it, and sidecar-correlation runs in the
    // skip branch.
    mgr.reserveOrigin('kb-pdm', 'extension')
    const s = mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(calls).toBe(1)
    expect(s.origin).toBe('extension')
    expect(s.agentId).toBe('kb-pdm')
  })

  it('cancels the stale extension reservation on a successful sidecar stamp (no 60s in-flight block)', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => ({ launchId: 'L1', agentId: 'kb-pdm' }))
    // startExtSession parks the reservation; the /clear session has no
    // agent-setting event so consumeOriginReservation never fires.
    mgr.reserveOrigin('kb-pdm', 'extension')
    expect(mgr.hasPendingReservation('kb-pdm')).toBe(true)
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    // After sidecar-correlation resolves the launch, the reservation must
    // be gone — otherwise the next ext launch for this agent is rejected
    // for the full TTL and the stale entry sits in the shared FIFO.
    expect(mgr.hasPendingReservation('kb-pdm')).toBe(false)
  })

  it('does not disturb OTHER agents reservations when cancelling on a sidecar stamp', () => {
    const mgr = new SessionManager()
    mgr.setExtLaunchResolver(() => ({ launchId: 'L1', agentId: 'kb-pdm' }))
    mgr.reserveOrigin('kb-pdm', 'extension')
    mgr.reserveOrigin('other-agent', 'sidebar') // unrelated, must survive
    mgr.ensureSession('sess-1', '-p', '/p/sess-1.jsonl')
    expect(mgr.hasPendingReservation('kb-pdm')).toBe(false)
    expect(mgr.hasPendingReservation('other-agent')).toBe(true)
  })
})
