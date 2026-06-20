/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'
import { buildTmuxAttachCommand } from '../../src/renderer/lib/tmux-command'

describe('buildTmuxAttachCommand', () => {
  it('single-quotes a normal window name', () => {
    expect(buildTmuxAttachCommand('agent-01')).toBe("tmux attach -t 'agent-01'")
  })

  it('neutralizes shell command substitution', () => {
    // The window name can never contain these today (server constrains
    // tmux names to ^[a-zA-Z0-9_-]{1,64}$), but the encoding must keep
    // them inert if that invariant ever regressed (BL-2026-267).
    expect(buildTmuxAttachCommand('$(rm -rf /)')).toBe(
      "tmux attach -t '$(rm -rf /)'",
    )
    expect(buildTmuxAttachCommand('`whoami`')).toBe(
      "tmux attach -t '`whoami`'",
    )
  })

  it('neutralizes embedded double quotes and whitespace', () => {
    expect(buildTmuxAttachCommand('a" ; ls "b')).toBe(
      `tmux attach -t 'a" ; ls "b'`,
    )
  })

  it('escapes an embedded single quote with the canonical sequence', () => {
    expect(buildTmuxAttachCommand("a'b")).toBe(`tmux attach -t 'a'\\''b'`)
  })

  it('escapes a single quote that opens a substitution', () => {
    expect(buildTmuxAttachCommand("'$(id)'")).toBe(
      `tmux attach -t ''\\''$(id)'\\'''`,
    )
  })
})
