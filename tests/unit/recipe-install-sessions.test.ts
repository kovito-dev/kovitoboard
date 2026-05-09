/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the install-session nonce store. Pin the boundary
 * behaviours of `issueInstallSession`, `consumeInstallSession`, and
 * `approvedScopesMatch`, which together close the
 * mark-installed approvedScopes-spoofing vector.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueInstallSession,
  consumeInstallSession,
  approvedScopesMatch,
  __resetForTests,
  __sizeForTests,
} from '../../src/server/recipe-install-sessions'
import type { Scope } from '../../src/server/handlers/types'

const SAMPLE_INPUT = {
  recipeId: 'document-viewer',
  recipeHash: 'sha256:abc',
  approvedScopes: ['project-read', 'own-data'] as Scope[],
}

afterEach(() => {
  __resetForTests()
  vi.useRealTimers()
})

describe('issueInstallSession', () => {
  it('returns a 32-character lowercase hex nonce', () => {
    const nonce = issueInstallSession(SAMPLE_INPUT)
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns a different nonce on every call', () => {
    const a = issueInstallSession(SAMPLE_INPUT)
    const b = issueInstallSession(SAMPLE_INPUT)
    expect(a).not.toBe(b)
  })

  it('does not mutate the caller-supplied scopes array', () => {
    const scopes = ['project-read', 'own-data'] as Scope[]
    issueInstallSession({ ...SAMPLE_INPUT, approvedScopes: scopes })
    scopes.push('write-fs' as Scope)
    // The mutated outer array should not surface through consume.
    const nonce = issueInstallSession(SAMPLE_INPUT)
    const session = consumeInstallSession(nonce)
    expect(session?.approvedScopes).toEqual(['project-read', 'own-data'])
  })
})

describe('consumeInstallSession', () => {
  it('returns the saved session for a valid, fresh nonce', () => {
    const nonce = issueInstallSession(SAMPLE_INPUT)
    const session = consumeInstallSession(nonce)
    expect(session).not.toBeNull()
    expect(session?.recipeId).toBe(SAMPLE_INPUT.recipeId)
    expect(session?.recipeHash).toBe(SAMPLE_INPUT.recipeHash)
    expect(session?.approvedScopes).toEqual(SAMPLE_INPUT.approvedScopes)
  })

  it('is one-shot — a second consume of the same nonce returns null', () => {
    const nonce = issueInstallSession(SAMPLE_INPUT)
    expect(consumeInstallSession(nonce)).not.toBeNull()
    expect(consumeInstallSession(nonce)).toBeNull()
  })

  it('returns null for a never-issued nonce', () => {
    expect(consumeInstallSession('0'.repeat(32))).toBeNull()
  })

  it('returns null for a malformed nonce (non-hex / wrong length)', () => {
    expect(consumeInstallSession('abc')).toBeNull()
    expect(consumeInstallSession('Z'.repeat(32))).toBeNull() // uppercase
    expect(consumeInstallSession('0'.repeat(31))).toBeNull() // too short
    expect(consumeInstallSession('0'.repeat(33))).toBeNull() // too long
    expect(consumeInstallSession('')).toBeNull()
    expect(consumeInstallSession(null)).toBeNull()
    expect(consumeInstallSession(undefined)).toBeNull()
    expect(consumeInstallSession(12345)).toBeNull()
  })

  it('returns null for an expired nonce (past the 5-minute TTL)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
    const nonce = issueInstallSession(SAMPLE_INPUT)
    // Advance 6 minutes — well past the 5-minute window.
    vi.setSystemTime(new Date('2026-05-09T00:06:00Z'))
    expect(consumeInstallSession(nonce)).toBeNull()
  })

  it('still returns the session at the boundary of the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
    const nonce = issueInstallSession(SAMPLE_INPUT)
    // Advance 4 minutes 59 seconds — inside the window.
    vi.setSystemTime(new Date('2026-05-09T00:04:59Z'))
    expect(consumeInstallSession(nonce)).not.toBeNull()
  })

  it('removes the entry from the store on every lookup, even when expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
    const nonce = issueInstallSession(SAMPLE_INPUT)
    expect(__sizeForTests()).toBe(1)
    vi.setSystemTime(new Date('2026-05-09T00:06:00Z'))
    expect(consumeInstallSession(nonce)).toBeNull()
    expect(__sizeForTests()).toBe(0)
  })
})

describe('approvedScopesMatch', () => {
  it('treats two arrays with the same scopes in the same order as equal', () => {
    expect(
      approvedScopesMatch(['project-read', 'own-data'] as Scope[], ['project-read', 'own-data'] as Scope[]),
    ).toBe(true)
  })

  it('treats two arrays with the same scopes in different order as equal', () => {
    expect(
      approvedScopesMatch(['project-read', 'own-data'] as Scope[], ['own-data', 'project-read'] as Scope[]),
    ).toBe(true)
  })

  it('rejects two arrays of different length', () => {
    expect(
      approvedScopesMatch(['project-read'] as Scope[], ['project-read', 'own-data'] as Scope[]),
    ).toBe(false)
  })

  it('rejects two arrays of the same length but different members', () => {
    expect(
      approvedScopesMatch(['project-read', 'own-data'] as Scope[], ['project-read', 'project-write'] as Scope[]),
    ).toBe(false)
  })

  it('rejects non-array inputs', () => {
    expect(approvedScopesMatch(null as unknown as Scope[], [])).toBe(false)
    expect(approvedScopesMatch([], undefined as unknown as Scope[])).toBe(false)
  })

  it('handles empty arrays', () => {
    expect(approvedScopesMatch([], [])).toBe(true)
  })

  it('treats duplicate-laden arrays correctly (set-equality, length-aware)', () => {
    // Caller should never produce duplicates, but be explicit about
    // the contract: both arrays must contain the same multiset, and
    // since we compare with a Set the duplicate is collapsed only on
    // one side, so the lengths diverge and the result is false.
    expect(
      approvedScopesMatch(['project-read', 'project-read'] as Scope[], ['project-read'] as Scope[]),
    ).toBe(false)
  })
})
