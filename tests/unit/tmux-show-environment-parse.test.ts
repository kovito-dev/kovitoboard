/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * `parseShowEnvironmentKeys` — raw `tmux show-environment` output parsing
 * for the interactive-tmux nested-detection scrub
 * (session-management.md §7.1.4.1).
 *
 * Covers the four line forms the contract pins:
 *   1. `NAME=value`             → key before the first `=`
 *   2. `-NAME` (removed marker) → key with the single leading `-` stripped
 *   3. `NAME` (no `=`)          → whole line is the key
 *   4. `NAME=a=b` (value has `=`)→ key before the FIRST `=` only
 * Plus: blank-line skipping, and that matched keys feed the scrub
 * predicate while `ANTHROPIC_*` does not.
 */
import { describe, it, expect } from 'vitest'
import { parseShowEnvironmentKeys } from '../../src/server/tmux-bridge'
import { isNestedDetectionKey } from '../../src/server/nested-detection-env'

describe('parseShowEnvironmentKeys', () => {
  it('parses a normal NAME=value entry', () => {
    expect(parseShowEnvironmentKeys('CLAUDECODE=1')).toEqual(['CLAUDECODE'])
  })

  it('parses a removed-marker entry (-NAME) by stripping one leading dash', () => {
    expect(parseShowEnvironmentKeys('-CLAUDE_CODE_SESSION_ID')).toEqual([
      'CLAUDE_CODE_SESSION_ID',
    ])
  })

  it('parses an entry with no = as the whole line', () => {
    expect(parseShowEnvironmentKeys('SOME_FLAG')).toEqual(['SOME_FLAG'])
  })

  it('splits on the first = when the value itself contains =', () => {
    expect(parseShowEnvironmentKeys('CLAUDE_CODE_ENTRYPOINT=a=b=c')).toEqual([
      'CLAUDE_CODE_ENTRYPOINT',
    ])
  })

  it('skips blank lines and parses a mixed multi-line block', () => {
    const output = [
      'PATH=/usr/bin',
      '',
      'CLAUDECODE=1',
      '-AI_AGENT',
      'ANTHROPIC_API_KEY=sk-secret',
      'CLAUDE_CODE_AGENT=chief',
      'BARE_KEY',
      '',
    ].join('\n')

    expect(parseShowEnvironmentKeys(output)).toEqual([
      'PATH',
      'CLAUDECODE',
      'AI_AGENT',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_AGENT',
      'BARE_KEY',
    ])
  })

  it('feeds keys that the scrub predicate classifies correctly', () => {
    const output = [
      'CLAUDECODE=1',
      '-AI_AGENT',
      'CLAUDE_CODE_SESSION_ID=abc',
      'ANTHROPIC_API_KEY=sk-secret',
      'CLAUDE_EFFORT=high',
      'PATH=/usr/bin',
    ].join('\n')

    const matched = parseShowEnvironmentKeys(output).filter(isNestedDetectionKey)

    expect(matched).toEqual([
      'CLAUDECODE',
      'AI_AGENT',
      'CLAUDE_CODE_SESSION_ID',
    ])
    // ANTHROPIC_API_KEY, CLAUDE_EFFORT, PATH are deliberately preserved.
    expect(matched).not.toContain('ANTHROPIC_API_KEY')
    expect(matched).not.toContain('CLAUDE_EFFORT')
  })
})
