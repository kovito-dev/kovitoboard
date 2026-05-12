/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-token store (v0.2.0 / spec v1.6 §6.10.6).
 * Covers issuance, consume, revoke, expiry sweep, and the
 * MAX_ACTIVE_TOKENS cap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueCaptureToken,
  consumeCaptureToken,
  revokeCaptureToken,
  sweepExpiredTokens,
  __resetForTests,
  __sizeForTests,
  __MAX_ACTIVE_TOKENS_FOR_TESTS,
  TOKEN_TTL_MS,
} from '../../src/server/recipe-capture-sessions'

describe('recipe-capture-sessions', () => {
  afterEach(() => {
    __resetForTests()
    vi.useRealTimers()
  })

  it('issues a 32-char lowercase-hex token and stores it', () => {
    const result = issueCaptureToken('app-a')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{32}$/)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
    expect(__sizeForTests()).toBe(1)
  })

  it('consumes a live token and returns the bound appId', () => {
    const issued = issueCaptureToken('app-a')
    if (!issued.ok) throw new Error('issue failed')
    const result = consumeCaptureToken(issued.token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.appId).toBe('app-a')
    }
    // Consume MUST NOT delete the entry — capture tokens are
    // window-scoped (spec v1.6 §6.10.6.3).
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
    const issued = issueCaptureToken('app-a')
    if (!issued.ok) throw new Error('issue failed')
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    const result = consumeCaptureToken(issued.token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('expired')
    }
    // Expired entry is dropped from the store.
    expect(__sizeForTests()).toBe(0)
  })

  it('revokes a known token and reports true; second revoke returns false', () => {
    const issued = issueCaptureToken('app-a')
    if (!issued.ok) throw new Error('issue failed')
    expect(revokeCaptureToken(issued.token)).toBe(true)
    expect(revokeCaptureToken(issued.token)).toBe(false)
    expect(__sizeForTests()).toBe(0)
  })

  it('refuses issuance with reason=StoreFull when the cap is hit and sweep finds nothing', () => {
    // Fill the store with non-expired tokens.
    for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
      const r = issueCaptureToken(`app-${i}`)
      expect(r.ok).toBe(true)
    }
    expect(__sizeForTests()).toBe(__MAX_ACTIVE_TOKENS_FOR_TESTS)
    const overflow = issueCaptureToken('app-overflow')
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) {
      expect(overflow.reason).toBe('StoreFull')
    }
  })

  it('sweeps expired entries and admits new issuance under the cap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
      const r = issueCaptureToken(`app-${i}`)
      expect(r.ok).toBe(true)
    }
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    // Trigger sweep via the issue path: issueCaptureToken calls
    // sweepExpiredTokens before checking the cap.
    const fresh = issueCaptureToken('app-fresh')
    expect(fresh.ok).toBe(true)
    expect(__sizeForTests()).toBe(1)
  })

  it('sweepExpiredTokens returns the count of removed entries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    issueCaptureToken('app-a')
    issueCaptureToken('app-b')
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 1000))
    expect(sweepExpiredTokens()).toBe(2)
    expect(__sizeForTests()).toBe(0)
  })
})
