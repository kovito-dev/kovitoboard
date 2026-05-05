/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * parser.ts: detection of Claude Code's "interrupt / reject" sentinels.
 *
 * Claude Code records two fixed-English sentinels in the JSONL when the
 * user (or KB on the user's behalf) declines a permission prompt:
 *
 *   1. A `tool_result` block with `is_error: true` that begins with
 *      "The user doesn't want to proceed with this tool use ...".
 *   2. A follow-up user message whose only content is the literal
 *      string `[Request interrupted by user for tool use]`.
 *
 * These sentinels end the agent turn (Claude Code emits no subsequent
 * assistant message). Without explicit detection, KB would (a) leave the
 * session in `waiting` because `updateStatus` blindly transitions on
 * `event.type === 'user'`, and (b) render the raw English banner in the
 * timeline. parser.ts now flags both events with
 * `metadata.interrupted = 'user-interrupt' | 'tool-rejected'` so the
 * session manager and renderer can react.
 */
import { describe, it, expect } from 'vitest'
import { parseLine } from '../../src/server/parser'

const SESSION_ID = 'test-session'

function jsonl(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

describe('parser.ts interrupted detection', () => {
  it('flags the canonical "[Request interrupted by user for tool use]" sentinel', () => {
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    })
    const events = parseLine(line, SESSION_ID)
    const userEvent = events.find((e) => e.type === 'user')
    expect(userEvent).toBeDefined()
    expect(userEvent!.metadata.interrupted).toBe('user-interrupt')
  })

  it('flags the shorter "[Request interrupted by user]" variant (no `for tool use` suffix)', () => {
    // Some Claude Code releases drop the trailing qualifier; the regex
    // tolerates either form so the flag survives minor wording shifts.
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      },
    })
    const userEvent = parseLine(line, SESSION_ID).find((e) => e.type === 'user')
    expect(userEvent!.metadata.interrupted).toBe('user-interrupt')
  })

  it('does NOT flag a user message that merely mentions the word "interrupted"', () => {
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'I was interrupted while writing this, sorry.' }],
      },
    })
    const userEvent = parseLine(line, SESSION_ID).find((e) => e.type === 'user')
    expect(userEvent).toBeDefined()
    expect(userEvent!.metadata.interrupted).toBeUndefined()
  })

  it('does NOT flag a normal user message', () => {
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: 'こんにちは',
      },
    })
    const userEvent = parseLine(line, SESSION_ID).find((e) => e.type === 'user')
    expect(userEvent!.metadata.interrupted).toBeUndefined()
  })

  it('flags a tool_result whose content begins with the rejection sentinel', () => {
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_xyz',
            content:
              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
            is_error: true,
          },
        ],
      },
    })
    const events = parseLine(line, SESSION_ID)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.metadata.interrupted).toBe('tool-rejected')
  })

  it('does NOT flag a normal tool_result whose output happens to mention "tool use"', () => {
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: 'Tool use completed successfully. Output: 42',
          },
        ],
      },
    })
    const toolResult = parseLine(line, SESSION_ID).find((e) => e.type === 'tool_result')
    expect(toolResult!.metadata.interrupted).toBeUndefined()
  })

  it('handles a user event with both a rejection tool_result and the follow-up sentinel in one line', () => {
    // In live JSONL the rejection tool_result and the [Request
    // interrupted ...] sentinel arrive on separate lines (as observed
    // in 2.1.126 capture). Still, parser.ts must handle both blocks
    // landing in a single user event with a content array because the
    // schema technically allows it.
    const line = jsonl({
      type: 'user',
      timestamp: '2026-05-03T11:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_xyz',
            content: "The user doesn't want to proceed with this tool use. ...",
            is_error: true,
          },
          { type: 'text', text: '[Request interrupted by user for tool use]' },
        ],
      },
    })
    const events = parseLine(line, SESSION_ID)
    const toolResult = events.find((e) => e.type === 'tool_result')
    const userEvent = events.find((e) => e.type === 'user')
    expect(toolResult!.metadata.interrupted).toBe('tool-rejected')
    expect(userEvent!.metadata.interrupted).toBe('user-interrupt')
  })
})
