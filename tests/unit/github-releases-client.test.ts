/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the GitHub Releases client (`v0.1.0-version-display.md` §4.4).
 *
 * Verifies the contract pieces that matter for ops:
 *   - User-Agent format (spec §3.5)
 *   - Cache TTL freshness check
 *   - SemVer comparison + isOutdated
 *
 * The full fetch-and-cache flow against fakes is exercised in
 * higher-level integration tests; here we keep the unit fast and
 * dependency-free.
 */
import { describe, expect, it } from 'vitest'
import {
  buildUserAgent,
  compareSemver,
  isCacheFresh,
  isOutdated,
  type ReleaseCacheEntry,
} from '../../src/server/github-releases-client'

describe('buildUserAgent', () => {
  it('matches the spec §3.5 format', () => {
    const ua = buildUserAgent('0.1.0', { platform: 'linux', nodeVersion: '22.5.0' })
    expect(ua).toBe('KovitoBoard/0.1.0 (linux; node-22.5)')
  })

  it('includes the dev tag when version contains it', () => {
    const ua = buildUserAgent('0.1.0-dev', { platform: 'darwin', nodeVersion: '20.10.4' })
    expect(ua).toBe('KovitoBoard/0.1.0-dev (darwin; node-20.10)')
  })

  it('handles win32 + odd node versions', () => {
    const ua = buildUserAgent('0.2.0', { platform: 'win32', nodeVersion: '18.0.1' })
    expect(ua).toBe('KovitoBoard/0.2.0 (win32; node-18.0)')
  })
})

describe('compareSemver', () => {
  it('orders by major, minor, patch', () => {
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1)
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1)
  })

  it('treats equal cores as 0', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0)
    expect(compareSemver('v0.1.0', '0.1.0')).toBe(0)
  })

  it('treats pre-release as older than the bare release', () => {
    expect(compareSemver('0.1.0-rc.0', '0.1.0')).toBe(-1)
    expect(compareSemver('0.1.0', '0.1.0-rc.0')).toBe(1)
  })
})

describe('isOutdated', () => {
  it('returns true when latest is greater', () => {
    expect(isOutdated('0.1.0', 'v0.1.1')).toBe(true)
    expect(isOutdated('0.1.0-dev', 'v0.1.0')).toBe(true)
  })

  it('returns false when latest is equal or older', () => {
    expect(isOutdated('0.1.0', 'v0.1.0')).toBe(false)
    expect(isOutdated('0.2.0', 'v0.1.0')).toBe(false)
  })

  it('returns false when latestTag is null (fetch failed)', () => {
    expect(isOutdated('0.1.0', null)).toBe(false)
  })
})

describe('isCacheFresh', () => {
  function makeEntry(checkedAtMsAgo: number): ReleaseCacheEntry {
    return {
      checkedAt: new Date(Date.now() - checkedAtMsAgo).toISOString(),
      latestTag: 'v0.1.1',
      fetchSucceeded: true,
      source: 'github-releases',
    }
  }

  it('returns true within the TTL window', () => {
    expect(isCacheFresh(makeEntry(60_000), 24)).toBe(true)         // 1 min ago
    expect(isCacheFresh(makeEntry(23 * 3_600_000), 24)).toBe(true) // 23 h ago
  })

  it('returns false past the TTL window', () => {
    expect(isCacheFresh(makeEntry(25 * 3_600_000), 24)).toBe(false) // 25 h ago
    expect(isCacheFresh(makeEntry(48 * 3_600_000), 24)).toBe(false) // 48 h ago
  })

  it('honors a custom TTL', () => {
    expect(isCacheFresh(makeEntry(2 * 3_600_000), 1)).toBe(false)   // 2 h ago, TTL 1 h
    expect(isCacheFresh(makeEntry(30 * 60_000), 1)).toBe(true)      // 30 min ago, TTL 1 h
  })

  it('returns false when checkedAt is malformed', () => {
    const broken: ReleaseCacheEntry = {
      checkedAt: 'not-a-date',
      latestTag: 'v0.1.1',
      fetchSucceeded: true,
      source: 'github-releases',
    }
    expect(isCacheFresh(broken, 24)).toBe(false)
  })
})
