/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `extractActivityLine`.
 *
 * The extractor walks tmux captures bottom-up to find the most recent
 * "what is the agent doing right now" line, while skipping the input
 * box, the mode-indicator banner, and the help footer. The fixtures
 * below mirror live captures from Claude Code 2.1.126 because earlier
 * heuristics (used the empty arrow `❯` as the activity line) failed
 * exactly there.
 */
import { describe, it, expect } from 'vitest'
import { extractActivityLine } from '../../src/server/agent-activity-monitor'

const RULE = '─'.repeat(60)

function pane(...lines: string[]): string {
  return lines.join('\n')
}

describe('extractActivityLine', () => {
  it('returns the activity line above the input-box marker, NOT the empty `❯` arrow', () => {
    // Real layout from Claude Code 2.1.126 when the agent finished a
    // turn and is waiting for the next user input. The empty `❯` line
    // sits inside the input box; the prior heuristic returned it.
    const capture = pane(
      '● Done!',
      '',
      '✻ Brewed for 7s',
      '',
      `${RULE} kovito-concierge ──`,
      '❯ ',
      RULE,
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    )
    expect(extractActivityLine(capture)).toBe('✻ Brewed for 7s')
  })

  it('skips the `⏵⏵ accept edits` mode indicator banner', () => {
    // Even when the marker is absent, the mode banner must never
    // surface as the agent's activity.
    const capture = pane(
      '● Bash(echo "hello")',
      '  ⎿  Running…',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    )
    expect(extractActivityLine(capture)).toBe('⎿  Running…')
  })

  it('skips a focused but empty `❯` prompt arrow', () => {
    const capture = pane('● Read(/tmp/file.txt)', '', '❯ ')
    expect(extractActivityLine(capture)).toBe('● Read(/tmp/file.txt)')
  })

  it('skips a focused but empty `>` prompt arrow (legacy form)', () => {
    const capture = pane('● Read(/tmp/file.txt)', '', '> ')
    expect(extractActivityLine(capture)).toBe('● Read(/tmp/file.txt)')
  })

  it('preserves long file paths up to the new 120-char limit', () => {
    // 120 chars is the new ceiling (was 80). A typical
    // `● Read(<absolute path>)` was being chopped to a useless prefix.
    const longPath = '/home/dev/project/' + 'sub/'.repeat(20) + 'file.ts'
    const line = `● Read(${longPath})`
    const capture = pane(line, '', `${RULE} kobi ──`, '❯ ', RULE)
    const out = extractActivityLine(capture)
    expect(out).not.toBeNull()
    if (line.length <= 120) {
      expect(out).toBe(line)
    } else {
      expect(out!.length).toBeLessThanOrEqual(120)
      expect(out!.endsWith('…')).toBe(true)
    }
  })

  it('walks past several scrollback markers and finds the most recent activity', () => {
    // When the session has scrolled past previous input boxes, the
    // bottom-up marker search must pick the latest one so we do not
    // dig back into ancient activity.
    const capture = pane(
      '● Old activity from 5 minutes ago',
      `${RULE} kobi ──`,
      '│ user input from earlier        │',
      RULE,
      '● Recent Bash invocation',
      '✻ Synthesizing... (3s)',
      `${RULE} kobi ──`,
      '❯ ',
      RULE,
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    )
    expect(extractActivityLine(capture)).toBe('✻ Synthesizing... (3s)')
  })

  it('handles plan-mode indicator without leaking it as activity', () => {
    const capture = pane(
      '● Researching with the Plan tool',
      `${RULE} planner ──`,
      '❯ ',
      RULE,
      '  ⏸ plan mode on (shift+tab to cycle)',
    )
    expect(extractActivityLine(capture)).toBe('● Researching with the Plan tool')
  })

  it('returns null for a totally empty capture', () => {
    expect(extractActivityLine('')).toBeNull()
  })

  it('returns null when the capture only contains chrome', () => {
    const capture = pane(
      `${RULE} kobi ──`,
      '❯ ',
      RULE,
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
      '  ? for shortcuts',
    )
    expect(extractActivityLine(capture)).toBeNull()
  })

  it('skips lines that consist only of box-drawing characters even outside the input area', () => {
    const capture = pane(
      '● Useful activity',
      '────────────────────────────────',
      `${RULE} kobi ──`,
      '❯ ',
      RULE,
    )
    expect(extractActivityLine(capture)).toBe('● Useful activity')
  })

  it('falls back to the legacy heuristic when no agent-name marker is present', () => {
    // Defensive: pre-2.1.x captures or alternate shells may not have
    // the marker. Walking from the very bottom must still ignore the
    // empty arrow and find a real activity line.
    const capture = pane('● Doing something', '❯ ')
    expect(extractActivityLine(capture)).toBe('● Doing something')
  })
})
