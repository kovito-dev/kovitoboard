/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Nested-detection env scrub — shared key-classification predicate and
 * object-filter helper (session-management.md §8.9.1 / §8.9.2 / §9).
 *
 * Pins:
 *   - `isNestedDetectionKey` matches `CLAUDECODE` / `AI_AGENT` /
 *     `CLAUDE_CODE_*`, and does NOT match `ANTHROPIC_API_KEY` or
 *     unrelated `CLAUDE*` vars such as `CLAUDE_EFFORT`.
 *   - `scrubNestedDetectionEnv` removes the matched set from a spawn env
 *     while preserving `ANTHROPIC_API_KEY` and friends.
 */
import { describe, it, expect } from 'vitest'
import {
  isNestedDetectionKey,
  scrubNestedDetectionEnv,
} from '../../src/server/nested-detection-env'

describe('isNestedDetectionKey', () => {
  it('matches the exact-name signal vars', () => {
    expect(isNestedDetectionKey('CLAUDECODE')).toBe(true)
    expect(isNestedDetectionKey('AI_AGENT')).toBe(true)
  })

  it('matches the CLAUDE_CODE_ prefix (current and future vars)', () => {
    expect(isNestedDetectionKey('CLAUDE_CODE_SESSION_ID')).toBe(true)
    expect(isNestedDetectionKey('CLAUDE_CODE_ENTRYPOINT')).toBe(true)
    expect(isNestedDetectionKey('CLAUDE_CODE_AGENT')).toBe(true)
    expect(isNestedDetectionKey('CLAUDE_CODE_CHILD_SESSION')).toBe(true)
    expect(isNestedDetectionKey('CLAUDE_CODE_EXECPATH')).toBe(true)
    expect(isNestedDetectionKey('CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING')).toBe(true)
    // A var Claude Code has not shipped yet still matches by prefix.
    expect(isNestedDetectionKey('CLAUDE_CODE_SOMETHING_NEW')).toBe(true)
  })

  it('does NOT match the auth vars (must be preserved)', () => {
    expect(isNestedDetectionKey('ANTHROPIC_API_KEY')).toBe(false)
    expect(isNestedDetectionKey('ANTHROPIC_BASE_URL')).toBe(false)
    expect(isNestedDetectionKey('ANTHROPIC_AUTH_TOKEN')).toBe(false)
  })

  it('does NOT match unrelated CLAUDE* vars', () => {
    // Narrow predicate: CLAUDE_EFFORT etc. must not be swept in.
    expect(isNestedDetectionKey('CLAUDE_EFFORT')).toBe(false)
    expect(isNestedDetectionKey('CLAUDE_CONFIG_DIR')).toBe(false)
    // `CLAUDECODE` is exact, not a prefix — a longer name must not match.
    expect(isNestedDetectionKey('CLAUDECODE_EXTRA')).toBe(false)
    // `AI_AGENT` is exact too.
    expect(isNestedDetectionKey('AI_AGENT_NAME')).toBe(false)
  })

  it('does NOT match unrelated baseline vars', () => {
    expect(isNestedDetectionKey('PATH')).toBe(false)
    expect(isNestedDetectionKey('HOME')).toBe(false)
    expect(isNestedDetectionKey('KOVITOBOARD_PROJECT_ROOT')).toBe(false)
  })
})

describe('scrubNestedDetectionEnv', () => {
  it('removes the nested-detection set and preserves auth + baseline', () => {
    const input = {
      CLAUDECODE: '1',
      AI_AGENT: 'claude',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'sk-secret',
      ANTHROPIC_BASE_URL: 'https://example.test',
      CLAUDE_EFFORT: 'high',
      PATH: '/usr/bin',
      HOME: '/home/user',
    }

    const out = scrubNestedDetectionEnv(input)

    expect(out.CLAUDECODE).toBeUndefined()
    expect(out.AI_AGENT).toBeUndefined()
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()

    expect(out.ANTHROPIC_API_KEY).toBe('sk-secret')
    expect(out.ANTHROPIC_BASE_URL).toBe('https://example.test')
    expect(out.CLAUDE_EFFORT).toBe('high')
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/user')
  })

  it('does not mutate the input env', () => {
    const input = { CLAUDECODE: '1', PATH: '/usr/bin' }
    const out = scrubNestedDetectionEnv(input)
    expect(input.CLAUDECODE).toBe('1')
    expect(out.CLAUDECODE).toBeUndefined()
    expect(out).not.toBe(input)
  })

  it('returns an equivalent copy when nothing matches', () => {
    const input = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk' }
    const out = scrubNestedDetectionEnv(input)
    expect(out).toEqual(input)
  })
})
