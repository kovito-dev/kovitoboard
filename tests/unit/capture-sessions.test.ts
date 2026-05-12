/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-token store (v0.2.0 / spec v1.7 §6.10.6).
 * Covers issuance, consume, revoke (by token + by mountId), expiry
 * sweep, the MAX_ACTIVE_TOKENS cap, per-mount idempotent replace
 * (H-CR4), and `withCriticalSection` synchronous semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueCaptureToken,
  consumeCaptureToken,
  revokeCaptureToken,
  revokeCaptureTokenByMountId,
  sweepExpiredTokens,
  withCriticalSection,
  __resetForTests,
  __sizeForTests,
  __MAX_ACTIVE_TOKENS_FOR_TESTS,
  TOKEN_TTL_MS,
} from '../../src/server/recipe-capture-sessions'

function makeMountId(seed: number): string {
  return seed.toString(16).padStart(32, '0').slice(0, 32)
}

describe('recipe-capture-sessions', () => {
  afterEach(() => {
    __resetForTests()
    vi.useRealTimers()
  })

  it('issues a 32-char lowercase-hex token bound to a mountId', () => {
    const mountId = makeMountId(1)
    const result = issueCaptureToken({ mountId, appId: 'app-a' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{32}$/)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
    expect(__sizeForTests()).toBe(1)
  })

  it('consumes a live token and returns the bound mountId + appId', () => {
    const mountId = makeMountId(2)
    const issued = issueCaptureToken({ mountId, appId: 'app-a' })
    if (!issued.ok) throw new Error('issue failed')
    const result = consumeCaptureToken(issued.token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mountId).toBe(mountId)
      expect(result.appId).toBe('app-a')
    }
    // Consume MUST NOT delete the entry — capture tokens are
    // window-scoped (spec v1.7 §6.10.6.3).
    expect(__sizeForTests()).toBe(1)
  })

  it('returns reason=invalid for malformed tokens', () => {
    expect(consumeCaptureToken(undefined)).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeCaptureToken('')).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeCaptureToken('not-hex')).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeCaptureToken('a'.repeat(31))).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeCaptureToken('A'.repeat(32))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('returns reason=invalid for unknown tokens', () => {
    const fakeToken = 'a'.repeat(32)
    expect(consumeCaptureToken(fakeToken)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('returns reason=expired and removes the entry past expiresAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const issued = issueCaptureToken({ mountId: makeMountId(3), appId: 'app-a' })
    if (!issued.ok) throw new Error('issue failed')
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    const result = consumeCaptureToken(issued.token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('expired')
    }
    expect(__sizeForTests()).toBe(0)
  })

  it('revokes a known token and reports true; second revoke returns false', () => {
    const issued = issueCaptureToken({ mountId: makeMountId(4), appId: 'app-a' })
    if (!issued.ok) throw new Error('issue failed')
    expect(revokeCaptureToken(issued.token)).toBe(true)
    expect(revokeCaptureToken(issued.token)).toBe(false)
    expect(__sizeForTests()).toBe(0)
  })

  it('revokeCaptureTokenByMountId drops the entry; double-revoke is harmless', () => {
    const mountId = makeMountId(5)
    issueCaptureToken({ mountId, appId: 'app-a' })
    expect(revokeCaptureTokenByMountId(mountId)).toBe(true)
    expect(revokeCaptureTokenByMountId(mountId)).toBe(false)
    expect(__sizeForTests()).toBe(0)
  })

  it('refuses issuance with reason=StoreFull when the cap is hit', () => {
    for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
      const r = issueCaptureToken({ mountId: makeMountId(100 + i), appId: `app-${i}` })
      expect(r.ok).toBe(true)
    }
    expect(__sizeForTests()).toBe(__MAX_ACTIVE_TOKENS_FOR_TESTS)
    const overflow = issueCaptureToken({
      mountId: makeMountId(999),
      appId: 'app-overflow',
    })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) {
      expect(overflow.reason).toBe('StoreFull')
    }
  })

  it('sweeps expired entries and admits new issuance under the cap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
      const r = issueCaptureToken({ mountId: makeMountId(i), appId: `app-${i}` })
      expect(r.ok).toBe(true)
    }
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    const fresh = issueCaptureToken({
      mountId: makeMountId(9000),
      appId: 'app-fresh',
    })
    expect(fresh.ok).toBe(true)
    expect(__sizeForTests()).toBe(1)
  })

  it('sweepExpiredTokens returns the count of removed entries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    issueCaptureToken({ mountId: makeMountId(1), appId: 'app-a' })
    issueCaptureToken({ mountId: makeMountId(2), appId: 'app-b' })
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    expect(sweepExpiredTokens()).toBe(2)
    expect(__sizeForTests()).toBe(0)
  })

  it('per-mount idempotent replace: a second issue against the same mountId returns a fresh token and atomically drops the old one (H-CR4)', () => {
    const mountId = makeMountId(7)
    const first = issueCaptureToken({ mountId, appId: 'app-a' })
    if (!first.ok) throw new Error('first issue failed')
    const second = issueCaptureToken({ mountId, appId: 'app-a' })
    if (!second.ok) throw new Error('second issue failed')
    expect(second.token).not.toBe(first.token)
    // The old token is no longer valid.
    expect(consumeCaptureToken(first.token).ok).toBe(false)
    // The new token consumes cleanly.
    const consumed = consumeCaptureToken(second.token)
    expect(consumed.ok).toBe(true)
    // Store size stays at 1 — the replacement did not grow the store.
    expect(__sizeForTests()).toBe(1)
  })

  it('withCriticalSection invokes fn synchronously without wrapping in a Promise', () => {
    let observed = 'before'
    const result = withCriticalSection('test-scope', () => {
      observed = 'inside'
      return 42
    })
    expect(observed).toBe('inside')
    expect(result).toBe(42)
  })
})
