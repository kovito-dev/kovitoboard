/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the Q5 / SS-4 session status bar helpers.
 *
 * Covers the four pure functions that drive the UI: model → context
 * window resolution, latest-assistant event lookup, token formatter,
 * and elapsed-time formatter.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  findLatestAssistantWithUsage,
  computeContextTokens,
  formatTokens,
  formatElapsed,
} from '../../src/renderer/utils/session-status'
import type { ParsedEvent } from '../../src/renderer/types'

function makeEvent(
  type: ParsedEvent['type'],
  metadata?: ParsedEvent['metadata'],
  overrides: Partial<ParsedEvent> = {},
): ParsedEvent {
  return {
    id: overrides.id ?? `event-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: overrides.timestamp ?? '2026-05-04T10:00:00.000Z',
    content: overrides.content ?? '',
    metadata,
    ...overrides,
  } as ParsedEvent
}

describe('resolveContextWindow', () => {
  it('returns the default for missing / unknown models', () => {
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(resolveContextWindow('default')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(resolveContextWindow('mystery-model-7b')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
  })

  it('matches Claude family prefixes case-insensitively', () => {
    expect(resolveContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000)
    expect(resolveContextWindow('Claude-3-Opus-20240229')).toBe(200_000)
    expect(resolveContextWindow('claude-haiku-4-x')).toBe(200_000)
  })

  it('prefers the longest matching prefix when multiple apply', () => {
    // "claude-3-5-sonnet" is longer than "claude-sonnet"; the longer
    // prefix must win when both would technically match.
    expect(resolveContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000)
  })
})

describe('findLatestAssistantWithUsage', () => {
  it('returns null when there are no assistant events', () => {
    expect(findLatestAssistantWithUsage([])).toBeNull()
    expect(
      findLatestAssistantWithUsage([
        makeEvent('user', { inputTokens: 1234 }),
      ]),
    ).toBeNull()
  })

  it('returns null when assistant events have no model nor token usage', () => {
    expect(
      findLatestAssistantWithUsage([
        makeEvent('assistant', { stopReason: 'end_turn' }),
      ]),
    ).toBeNull()
  })

  it('returns the most recent assistant event with usage data', () => {
    const events: ParsedEvent[] = [
      makeEvent('assistant', { model: 'claude-3-5-sonnet', inputTokens: 100 }),
      makeEvent('user'),
      makeEvent('assistant', { model: 'claude-3-5-sonnet', inputTokens: 250 }),
      makeEvent('user'),
    ]
    const result = findLatestAssistantWithUsage(events)
    expect(result).not.toBeNull()
    expect(result?.inputTokens).toBe(250)
    expect(result?.model).toBe('claude-3-5-sonnet')
  })

  it('surfaces cache-creation and cache-read tokens alongside inputTokens', () => {
    const events: ParsedEvent[] = [
      makeEvent('assistant', {
        model: 'claude-3-5-sonnet',
        inputTokens: 10,
        cacheCreationTokens: 1_500,
        cacheReadTokens: 4_500,
      }),
    ]
    const result = findLatestAssistantWithUsage(events)
    expect(result?.inputTokens).toBe(10)
    expect(result?.cacheCreationTokens).toBe(1_500)
    expect(result?.cacheReadTokens).toBe(4_500)
  })

  it('returns the latest assistant turn even when only cache tokens are populated', () => {
    // Cache-warm replies after the first turn often report
    // `inputTokens === 0` (or undefined) while `cacheReadTokens`
    // captures the bulk of the prompt; the helper must still surface
    // them or the status bar would regress to "not set".
    const events: ParsedEvent[] = [
      makeEvent('assistant', {
        model: 'claude-3-5-sonnet',
        cacheReadTokens: 12_000,
      }),
    ]
    const result = findLatestAssistantWithUsage(events)
    expect(result).not.toBeNull()
    expect(result?.cacheReadTokens).toBe(12_000)
  })

  it('skips events whose metadata is missing entirely', () => {
    const events: ParsedEvent[] = [
      makeEvent('assistant', { model: 'claude-3-5-sonnet', inputTokens: 100 }),
      makeEvent('assistant', undefined),
    ]
    const result = findLatestAssistantWithUsage(events)
    expect(result?.inputTokens).toBe(100)
  })

  it('matches even when only the model is set on the latest event', () => {
    const events: ParsedEvent[] = [
      makeEvent('assistant', { inputTokens: 100 }),
      makeEvent('assistant', { model: 'claude-3-5-sonnet' }),
    ]
    const result = findLatestAssistantWithUsage(events)
    expect(result?.model).toBe('claude-3-5-sonnet')
    expect(result?.inputTokens).toBeUndefined()
  })
})

describe('computeContextTokens', () => {
  it('returns null when every counter is missing', () => {
    expect(computeContextTokens({})).toBeNull()
  })

  it('sums input plus cache-creation plus cache-read tokens', () => {
    expect(
      computeContextTokens({
        inputTokens: 100,
        cacheCreationTokens: 1_500,
        cacheReadTokens: 4_500,
      }),
    ).toBe(6_100)
  })

  it('treats absent fields as zero so partial usage still reports a total', () => {
    // Cache-warm follow-up turns frequently omit `inputTokens` /
    // `cacheCreationTokens` and report only `cacheReadTokens`. The
    // status bar must still show a non-null total in that case.
    expect(computeContextTokens({ cacheReadTokens: 12_000 })).toBe(12_000)
    expect(computeContextTokens({ inputTokens: 250 })).toBe(250)
  })

  it('returns zero when explicit zeros are reported (vs. missing)', () => {
    expect(
      computeContextTokens({
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0)
  })
})

describe('formatTokens', () => {
  it('uses raw counts under 1K', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(123)).toBe('123')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses K for thousands with one decimal', () => {
    expect(formatTokens(1_000)).toBe('1.0K')
    expect(formatTokens(12_345)).toBe('12.3K')
    expect(formatTokens(199_500)).toBe('199.5K')
  })

  it('uses M for millions with one decimal', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })
})

describe('formatElapsed', () => {
  it('clamps negative values to 0m', () => {
    expect(formatElapsed(-1)).toBe('0m')
    expect(formatElapsed(-1_000_000)).toBe('0m')
  })

  it('formats minutes-only when under an hour', () => {
    expect(formatElapsed(0)).toBe('0m')
    expect(formatElapsed(30 * 60_000)).toBe('30m')
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59m')
  })

  it('formats hours and minutes between 1h and 24h', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1h 0m')
    expect(formatElapsed(2 * 60 * 60_000 + 5 * 60_000)).toBe('2h 5m')
    expect(formatElapsed(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h 59m')
  })

  it('formats days and hours past 24h', () => {
    expect(formatElapsed(24 * 60 * 60_000)).toBe('1d 0h')
    expect(formatElapsed(2 * 24 * 60 * 60_000 + 5 * 60 * 60_000)).toBe('2d 5h')
  })
})
