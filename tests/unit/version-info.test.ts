/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the version-info module (`v0.1.0-version-display.md` §4.3).
 *
 * Targets the pure helpers — tier resolution and the major.minor.x
 * range matcher. Claude Code detection itself shells out via
 * execFileSync and is covered by L3 manual tests.
 */
import { describe, expect, it } from 'vitest'
import {
  matchesMajorMinorX,
  resolveClaudeCodeTier,
} from '../../src/server/version-info'

describe('matchesMajorMinorX', () => {
  it('matches versions sharing the major.minor prefix', () => {
    expect(matchesMajorMinorX('2.1.0', '2.1.x')).toBe(true)
    expect(matchesMajorMinorX('2.1.117', '2.1.x')).toBe(true)
    expect(matchesMajorMinorX('2.2.0', '2.2.x')).toBe(true)
  })

  it('rejects versions outside the major.minor', () => {
    expect(matchesMajorMinorX('2.0.99', '2.1.x')).toBe(false)
    expect(matchesMajorMinorX('2.2.0', '2.1.x')).toBe(false)
    expect(matchesMajorMinorX('3.1.0', '2.1.x')).toBe(false)
  })

  it('rejects ranges that are not in major.minor.x form', () => {
    expect(matchesMajorMinorX('2.1.0', '>=2.0.0')).toBe(false)
    expect(matchesMajorMinorX('2.1.0', '2.x')).toBe(false)
    expect(matchesMajorMinorX('2.1.0', '2.1.0')).toBe(false)
    expect(matchesMajorMinorX('2.1.0', '')).toBe(false)
  })

  it('does not over-match on numeric-prefix collisions', () => {
    // "2.1.0" must NOT match "2.10.x" — without the trailing "." in
    // the prefix this would slip through (regression guard).
    expect(matchesMajorMinorX('2.10.0', '2.1.x')).toBe(false)
    expect(matchesMajorMinorX('21.0.0', '2.1.x')).toBe(false)
  })
})

describe('resolveClaudeCodeTier', () => {
  const primary = '2.1.104'
  const bestEffort = ['2.1.x', '2.2.x']

  it('returns primary when the detected version exactly equals primary', () => {
    expect(resolveClaudeCodeTier('2.1.104', primary, bestEffort)).toBe('primary')
  })

  it('returns best-effort for versions in the declared ranges (but not primary)', () => {
    expect(resolveClaudeCodeTier('2.1.117', primary, bestEffort)).toBe('best-effort')
    expect(resolveClaudeCodeTier('2.2.0', primary, bestEffort)).toBe('best-effort')
    expect(resolveClaudeCodeTier('2.2.99', primary, bestEffort)).toBe('best-effort')
  })

  it('returns out-of-range for versions outside every declared range', () => {
    expect(resolveClaudeCodeTier('2.0.99', primary, bestEffort)).toBe('out-of-range')
    expect(resolveClaudeCodeTier('2.3.0', primary, bestEffort)).toBe('out-of-range')
    expect(resolveClaudeCodeTier('3.0.0', primary, bestEffort)).toBe('out-of-range')
    expect(resolveClaudeCodeTier('1.99.99', primary, bestEffort)).toBe('out-of-range')
  })

  it('treats an empty bestEffortVersions list as primary-or-out', () => {
    expect(resolveClaudeCodeTier('2.1.117', primary, [])).toBe('out-of-range')
    expect(resolveClaudeCodeTier('2.1.104', primary, [])).toBe('primary')
  })
})
