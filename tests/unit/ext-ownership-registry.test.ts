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
