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
  apiSectionMatches,
  canonicalizeJson,
  __resetForTests,
  __sizeForTests,
  __MAX_SESSIONS_FOR_TESTS,
} from '../../src/server/recipe-install-sessions'
import type { Scope } from '../../src/server/handlers/types'

const SAMPLE_INPUT = {
  recipeId: 'document-viewer',
  recipeHash: 'sha256:abc',
  approvedScopes: ['project-read', 'own-data'] as Scope[],
  api: {
    scopes: ['project-read', 'own-data'],
    calls: [{ id: 'list-todos', handler: 'list-files', args: { path: 'todo/' } }],
  },
}

afterEach(() => {
  __resetForTests()
  vi.useRealTimers()
})

describe('issueInstallSession', () => {
  it('returns a 32-character lowercase hex nonce', () => {
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns a different nonce on every call', () => {
    const a = issueInstallSession(SAMPLE_INPUT)
    const b = issueInstallSession(SAMPLE_INPUT)
    if (!a.ok || !b.ok) throw new Error('unexpected non-ok issue result')
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('does not mutate the caller-supplied scopes array', () => {
    const scopes = ['project-read', 'own-data'] as Scope[]
    // Capture the very session whose scopes ride on the mutated
    // outer array; consuming a different session would let a
    // shared-reference bug slip through silently.
    const issueResult = issueInstallSession({ ...SAMPLE_INPUT, approvedScopes: scopes })
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    scopes.push('write-fs' as Scope)
    const session = consumeInstallSession(nonce)
    // The session must still report exactly what KB inspected at
    // install time, not the caller's mutated copy.
    expect(session?.approvedScopes).toEqual(['project-read', 'own-data'])
  })

  it('stores the api section in canonical form on the session', () => {
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    const session = consumeInstallSession(nonce)
    // Same shape, different key order should produce the same canonical
    // string the handler will compute on the body side.
    expect(session?.apiCanonical).toBe(
      canonicalizeJson({
        scopes: ['project-read', 'own-data'],
        calls: [{ args: { path: 'todo/' }, handler: 'list-files', id: 'list-todos' }],
      })!,
    )
  })

  it('returns at_capacity when the store is full', () => {
    // Fill the store right up to the cap.
    for (let i = 0; i < __MAX_SESSIONS_FOR_TESTS; i++) {
      const out = issueInstallSession(SAMPLE_INPUT)
      expect(out.ok).toBe(true)
    }
    // The next call should refuse instead of growing past the cap.
    const refused = issueInstallSession(SAMPLE_INPUT)
    expect(refused).toEqual({ ok: false, reason: 'at_capacity' })
  })

  it('returns invalid_api when the api section exceeds the depth limit', () => {
    // Build a 50-deep nested object — well past MAX_CANONICAL_DEPTH (32).
    let nested: Record<string, unknown> = {}
    let cursor: Record<string, unknown> = nested
    for (let i = 0; i < 50; i++) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    const result = issueInstallSession({ ...SAMPLE_INPUT, api: nested })
    expect(result).toEqual({ ok: false, reason: 'invalid_api' })
  })

  it('returns invalid_api when the api section contains a cycle', () => {
    const root: Record<string, unknown> = { scopes: [] }
    root.self = root
    const result = issueInstallSession({ ...SAMPLE_INPUT, api: root })
    expect(result).toEqual({ ok: false, reason: 'invalid_api' })
  })
})

describe('consumeInstallSession', () => {
  it('returns the saved session for a valid, fresh nonce', () => {
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    const session = consumeInstallSession(nonce)
    expect(session).not.toBeNull()
    expect(session?.recipeId).toBe(SAMPLE_INPUT.recipeId)
    expect(session?.recipeHash).toBe(SAMPLE_INPUT.recipeHash)
    expect(session?.approvedScopes).toEqual(SAMPLE_INPUT.approvedScopes)
  })

  it('is one-shot — a second consume of the same nonce returns null', () => {
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
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
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    // Advance 6 minutes — well past the 5-minute window.
    vi.setSystemTime(new Date('2026-05-09T00:06:00Z'))
    expect(consumeInstallSession(nonce)).toBeNull()
  })

  it('still returns the session at the boundary of the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
    // Advance 4 minutes 59 seconds — inside the window.
    vi.setSystemTime(new Date('2026-05-09T00:04:59Z'))
    expect(consumeInstallSession(nonce)).not.toBeNull()
  })

  it('removes the entry from the store on every lookup, even when expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'))
    const issueResult = issueInstallSession(SAMPLE_INPUT)
    if (!issueResult.ok) throw new Error(`unexpected non-ok: ${issueResult.reason}`)
    const nonce = issueResult.nonce
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
    // the contract: a duplicate on one side and a unique on the other
    // must NOT match, even when length and member intersection
    // coincidentally line up.
    expect(
      approvedScopesMatch(['project-read', 'project-read'] as Scope[], ['project-read'] as Scope[]),
    ).toBe(false)
  })

  it('rejects when duplicates collide with different unique members on the other side', () => {
    // Pre-fix bug: a=['x','y'] and b=['x','x'] both have length 2 and
    // every element of b is in a, but the multisets are different.
    // The fix compares set sizes too, so this case must be false.
    expect(
      approvedScopesMatch(['project-read', 'own-data'] as Scope[], ['project-read', 'project-read'] as Scope[]),
    ).toBe(false)
  })
})

describe('canonicalizeJson', () => {
  it('produces identical strings for objects whose keys differ only in order', () => {
    expect(canonicalizeJson({ a: 1, b: 2 })).toBe(canonicalizeJson({ b: 2, a: 1 }))
  })

  it('preserves array order (the dispatcher relies on calls order)', () => {
    expect(canonicalizeJson([1, 2, 3])).not.toBe(canonicalizeJson([3, 2, 1]))
  })

  it('collapses null and undefined to the same fingerprint', () => {
    expect(canonicalizeJson(null)).toBe('null')
    expect(canonicalizeJson(undefined)).toBe('null')
  })

  it('walks nested objects deeply', () => {
    expect(
      canonicalizeJson({ outer: { b: 1, a: 2 } }),
    ).toBe(canonicalizeJson({ outer: { a: 2, b: 1 } }))
  })

  it('disagrees when nested values differ', () => {
    expect(
      canonicalizeJson({ outer: { a: 1 } }),
    ).not.toBe(canonicalizeJson({ outer: { a: 2 } }))
  })
})

describe('apiSectionMatches', () => {
  const sample = {
    scopes: ['project-read', 'own-data'],
    calls: [{ id: 'list-todos', handler: 'list-files', args: { path: 'todo/' } }],
  }
  const canonical = canonicalizeJson(sample)!

  it('accepts a body whose api section matches the stored canonical form', () => {
    expect(apiSectionMatches(canonical, sample)).toBe(true)
  })

  it('accepts a body whose api section keys are reordered', () => {
    expect(
      apiSectionMatches(canonical, {
        calls: [{ args: { path: 'todo/' }, handler: 'list-files', id: 'list-todos' }],
        scopes: ['project-read', 'own-data'],
      }),
    ).toBe(true)
  })

  it('rejects a body whose api section adds an unauthorised call', () => {
    expect(
      apiSectionMatches(canonical, {
        scopes: ['project-read', 'own-data'],
        calls: [
          { id: 'list-todos', handler: 'list-files', args: { path: 'todo/' } },
          // Attacker-injected call: same scopes, different handler
          // binding. The fingerprint must catch this.
          { id: 'exfiltrate', handler: 'read-file', args: { path: '${input.path}' } },
        ],
      }),
    ).toBe(false)
  })

  it('rejects a body that swaps the scopes member', () => {
    expect(
      apiSectionMatches(canonical, {
        scopes: ['project-read', 'project-write'],
        calls: sample.calls,
      }),
    ).toBe(false)
  })

  it('treats null body and a session canonicalised from null as a match', () => {
    expect(apiSectionMatches(canonicalizeJson(null)!, null)).toBe(true)
    expect(apiSectionMatches(canonicalizeJson(null)!, undefined)).toBe(true)
  })
})
