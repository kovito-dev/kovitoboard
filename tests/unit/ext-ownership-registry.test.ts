/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Ownership registry tests (external-client-api.md v1.0 §5.4 / §7.3.1 /
 * §9.4 / §9.5).
 *
 * Pins: launchId minting, same-agentId serialisation (in-flight lock),
 * `new_session` correlation → ownership, TTL expiry, abort, clear, and
 * the ownership-enforcement boundary. The clock + launchId minter are
 * injected for determinism.
 */
import { describe, it, expect } from 'vitest'
import {
  OwnershipRegistry,
  EXT_LAUNCH_TTL_MS,
} from '../../src/server/ext-client/ownership-registry'

function makeRegistry(startTime = 1_000_000) {
  let t = startTime
  let n = 0
  const registry = new OwnershipRegistry({
    now: () => t,
    mintLaunchId: () => `launch-${++n}`,
  })
  return { registry, advance: (ms: number) => (t += ms) }
}

describe('OwnershipRegistry — launch + correlation', () => {
  it('mints a launchId and marks the agent in-flight', () => {
    const { registry } = makeRegistry()
    const r = registry.registerLaunch({ agentId: 'a1', originConnId: 7, clientRequestId: 'c1' })
    expect(r).toEqual({ ok: true, launchId: 'launch-1' })
    expect(registry.isAgentInFlight('a1')).toBe(true)
  })

  it('correlates a new_session to the pending launch and takes ownership', () => {
    const { registry } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 7, clientRequestId: 'c1' })
    const match = registry.correlateNewSession('sess-1', 'a1')
    expect(match).toMatchObject({
      launchId: 'launch-1',
      agentId: 'a1',
      originConnId: 7,
      clientRequestId: 'c1',
      sessionId: 'sess-1',
    })
    expect(registry.isOwned('sess-1')).toBe(true)
    // In-flight lock released after correlation.
    expect(registry.isAgentInFlight('a1')).toBe(false)
  })

  it('returns the attached processId on correlation (process_end backfill)', () => {
    const { registry } = makeRegistry()
    const r = registry.registerLaunch({ agentId: 'a1', originConnId: 7, clientRequestId: 'c1' })
    if (!r.ok) throw new Error('expected ok')
    // No processId yet (tmux path) → null.
    expect(registry.correlateNewSession('sess-tmux', 'a1')?.processId).toBeNull()

    // Fallback path: a processId is attached before materialisation.
    const r2 = registry.registerLaunch({ agentId: 'a2', originConnId: 8, clientRequestId: 'c2' })
    if (!r2.ok) throw new Error('expected ok')
    registry.attachProcessId(r2.launchId, 'proc-42')
    expect(registry.correlateNewSession('sess-bridge', 'a2')?.processId).toBe('proc-42')
  })

  it('rejects a second concurrent launch for the same agentId (serialisation §7.3.1)', () => {
    const { registry } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    const second = registry.registerLaunch({ agentId: 'a1', originConnId: 2, clientRequestId: 'c2' })
    expect(second).toEqual({ ok: false, reason: 'agent-in-flight' })
  })

  it('allows concurrent launches for different agentIds', () => {
    const { registry } = makeRegistry()
    expect(registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' }).ok).toBe(true)
    expect(registry.registerLaunch({ agentId: 'a2', originConnId: 2, clientRequestId: 'c2' }).ok).toBe(true)
  })

  it('rejects a duplicate in-flight clientRequestId even for a different agentId (§8.5)', () => {
    const { registry } = makeRegistry()
    expect(registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'dup' }).ok).toBe(true)
    const second = registry.registerLaunch({ agentId: 'a2', originConnId: 2, clientRequestId: 'dup' })
    expect(second).toEqual({ ok: false, reason: 'duplicate-client-request' })
  })

  it('frees a clientRequestId after the launch materialises (reusable thereafter)', () => {
    const { registry } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'dup' })
    registry.correlateNewSession('sess-1', 'a1')
    expect(registry.registerLaunch({ agentId: 'a2', originConnId: 2, clientRequestId: 'dup' }).ok).toBe(true)
  })

  it('frees a clientRequestId on abort', () => {
    const { registry } = makeRegistry()
    const r = registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'dup' })
    if (!r.ok) throw new Error('expected ok')
    registry.abortLaunch(r.launchId)
    expect(registry.registerLaunch({ agentId: 'a1', originConnId: 2, clientRequestId: 'dup' }).ok).toBe(true)
  })

  it('allows a fresh launch for the same agentId after the previous one materialised', () => {
    const { registry } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    registry.correlateNewSession('sess-1', 'a1')
    expect(registry.registerLaunch({ agentId: 'a1', originConnId: 2, clientRequestId: 'c2' }).ok).toBe(true)
  })
})

describe('OwnershipRegistry — TTL + abort', () => {
  it('expires a pending launch after the TTL and releases the lock', () => {
    const { registry, advance } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    advance(EXT_LAUNCH_TTL_MS + 1)
    expect(registry.isAgentInFlight('a1')).toBe(false)
    // A new_session arriving after expiry no longer correlates.
    expect(registry.correlateNewSession('sess-late', 'a1')).toBeNull()
    expect(registry.isOwned('sess-late')).toBe(false)
  })

  it('abortLaunch releases the in-flight lock without taking ownership', () => {
    const { registry } = makeRegistry()
    const r = registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    if (!r.ok) throw new Error('expected ok')
    registry.abortLaunch(r.launchId)
    expect(registry.isAgentInFlight('a1')).toBe(false)
    expect(registry.registerLaunch({ agentId: 'a1', originConnId: 2, clientRequestId: 'c2' }).ok).toBe(true)
  })
})

describe('OwnershipRegistry — ownership boundary', () => {
  it('does not own a session that was never correlated (e.g. renderer-started)', () => {
    const { registry } = makeRegistry()
    // No launch registered for 'a9' → a materialised session for it is
    // not owned. (The R-4 reverse-order race is an accepted bounded
    // residual handled at the call site, not here.)
    expect(registry.correlateNewSession('renderer-sess', 'a9')).toBeNull()
    expect(registry.isOwned('renderer-sess')).toBe(false)
  })

  it('clear drops all owned sessions, pending launches, and in-flight locks', () => {
    const { registry } = makeRegistry()
    registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    registry.correlateNewSession('sess-1', 'a1')
    expect(registry.isOwned('sess-1')).toBe(true)
    registry.clear()
    expect(registry.isOwned('sess-1')).toBe(false)
    expect(registry.isAgentInFlight('a1')).toBe(false)
  })
})

describe('OwnershipRegistry — sidecar-correlation latch + atomic consume (§7.3.2.1)', () => {
  function regWithLaunch(agentId = 'a1') {
    const { registry, advance } = makeRegistry()
    const r = registry.registerLaunch({ agentId, originConnId: 7, clientRequestId: 'c1' })
    if (!r.ok) throw new Error('expected ok')
    return { registry, advance, launchId: r.launchId }
  }

  it('latches the launch-causality basis onto a pending launch (S-4/S-6)', () => {
    const { registry, launchId } = regWithLaunch()
    registry.latchLaunchProcess(launchId, {
      tmuxPid: 12345,
      windowName: 'a1',
      priorSessionId: 'sess-prior',
      procBirthId: '4347449',
    })
    const launches = registry.listInFlightLaunches()
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      launchId,
      agentId: 'a1',
      tmuxPid: 12345,
      windowName: 'a1',
      priorSessionId: 'sess-prior',
      procBirthId: '4347449',
    })
  })

  it('latchLaunchProcess is a no-op for an unknown / consumed launchId', () => {
    const { registry, launchId } = regWithLaunch()
    registry.consumeLaunchByIdAndOwn(launchId, 'sess-1')
    // Now consumed — latch must not resurrect it.
    registry.latchLaunchProcess(launchId, {
      tmuxPid: 1,
      windowName: 'a1',
      priorSessionId: null,
      procBirthId: null,
    })
    expect(registry.listInFlightLaunches()).toHaveLength(0)
  })

  it('listInFlightLaunches GCs expired entries', () => {
    const { registry, advance } = regWithLaunch()
    expect(registry.listInFlightLaunches()).toHaveLength(1)
    advance(EXT_LAUNCH_TTL_MS + 1)
    expect(registry.listInFlightLaunches()).toHaveLength(0)
  })

  it('consumeLaunchByIdAndOwn owns the session + releases the in-flight lock on the exact launchId (S-3)', () => {
    const { registry, launchId } = regWithLaunch()
    const match = registry.consumeLaunchByIdAndOwn(launchId, 'sess-1')
    expect(match).toMatchObject({ launchId, agentId: 'a1', originConnId: 7, sessionId: 'sess-1' })
    expect(registry.isOwned('sess-1')).toBe(true)
    expect(registry.isAgentInFlight('a1')).toBe(false)
    expect(registry.listInFlightLaunches()).toHaveLength(0)
  })

  it('consumeLaunchByIdAndOwn is idempotent: a second consume of the same launchId returns null (S-3/S-7 no double-stamp)', () => {
    const { registry, launchId } = regWithLaunch()
    expect(registry.consumeLaunchByIdAndOwn(launchId, 'sess-1')).not.toBeNull()
    // Materialise-time vs reconcile-time double-resolve: the second
    // consume fails → caller performs no stamp.
    expect(registry.consumeLaunchByIdAndOwn(launchId, 'sess-1')).toBeNull()
  })

  it('consumeLaunchByIdAndOwn returns null for an unknown / TTL-expired launchId (no-bind)', () => {
    const { registry, advance, launchId } = regWithLaunch()
    expect(registry.consumeLaunchByIdAndOwn('nope', 'sess-x')).toBeNull()
    advance(EXT_LAUNCH_TTL_MS + 1)
    expect(registry.consumeLaunchByIdAndOwn(launchId, 'sess-late')).toBeNull()
    expect(registry.isOwned('sess-late')).toBe(false)
  })

  it('consumeLaunchByIdAndOwn binds to the EXACT launchId, not an agentId-only lookup', () => {
    // Two launches for DIFFERENT agents in flight (serialisation is
    // per-agentId, so distinct agents can co-exist). Consuming launch-2
    // by id must not touch launch-1.
    const { registry } = makeRegistry()
    const r1 = registry.registerLaunch({ agentId: 'a1', originConnId: 1, clientRequestId: 'c1' })
    const r2 = registry.registerLaunch({ agentId: 'a2', originConnId: 2, clientRequestId: 'c2' })
    if (!r1.ok || !r2.ok) throw new Error('expected ok')
    const match = registry.consumeLaunchByIdAndOwn(r2.launchId, 'sess-2')
    expect(match?.agentId).toBe('a2')
    expect(registry.isAgentInFlight('a1')).toBe(true) // untouched
    expect(registry.isAgentInFlight('a2')).toBe(false)
  })
})
