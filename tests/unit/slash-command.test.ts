/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
/**
 * Tests for the Q12 / SS-6 slash-command warning helpers.
 *
 * `detectSlashCommand` decides which user inputs trigger the warning
 * dialog; the suppression helpers ensure that "Don't show this
 * again" survives across sends without leaking renderer state into
 * other surfaces.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  detectSlashCommand,
  isSlashCommandWarningSuppressed,
  suppressSlashCommandWarning,
  SLASH_COMMAND_WARNING_SUPPRESS_KEY,
} from '../../src/renderer/utils/slash-command'

// jsdom (vitest default for renderer code) provides window.localStorage
// out of the box, so we just clear it between tests.
beforeEach(() => {
  window.localStorage.clear()
})

describe('detectSlashCommand', () => {
  it('flags single-line slash commands', () => {
    expect(detectSlashCommand('/context')).toBe('/context')
    expect(detectSlashCommand('/help')).toBe('/help')
    expect(detectSlashCommand('/model sonnet')).toBe('/model sonnet')
  })

  it('treats leading whitespace as a slash command (Claude Code accepts it)', () => {
    expect(detectSlashCommand('  /context')).toBe('/context')
    expect(detectSlashCommand('\n\n/help\n')).toBe('/help')
  })

  it('returns null for prose, slash-only, and non-letter slash inputs', () => {
    expect(detectSlashCommand('Please /context this code')).toBeNull()
    expect(detectSlashCommand('/')).toBeNull()
    expect(detectSlashCommand('/  ')).toBeNull()
    expect(detectSlashCommand('// comment')).toBeNull()
    expect(detectSlashCommand('/12345 looks like a path')).toBeNull()
  })

  it('matches absolute file paths beginning with a letter (false positive accepted by spec §6.10)', () => {
    // The architect approved Q12 §6.10 detection rule is `/^\/[a-z]/i`
    // which intentionally over-detects. The user can dismiss the
    // warning if it fires on a real path, and Claude Code never
    // expands such an input as a TUI command anyway.
    expect(detectSlashCommand('/home/user/file.md')).toBe('/home/user/file.md')
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(detectSlashCommand('')).toBeNull()
    expect(detectSlashCommand('   ')).toBeNull()
    expect(detectSlashCommand('\n\n\n')).toBeNull()
  })

  it('matches uppercase slash commands too (e.g. /Context)', () => {
    expect(detectSlashCommand('/Context')).toBe('/Context')
  })

  it('honours the first non-blank line in multi-line inputs', () => {
    // Slash command on the first line wins.
    expect(detectSlashCommand('/exit\nfollowed by chatter')).toBe('/exit')
    // Prose on the first line means the slash on a later line does
    // not trigger — Claude Code TUI commands always live on their own
    // first line.
    expect(detectSlashCommand('Hi there\n/help')).toBeNull()
  })
})

describe('slash-command warning suppression', () => {
  it('reports false when nothing has been written yet', () => {
    expect(isSlashCommandWarningSuppressed()).toBe(false)
  })

  it('persists the suppression flag through localStorage', () => {
    suppressSlashCommandWarning()
    expect(isSlashCommandWarningSuppressed()).toBe(true)
    expect(window.localStorage.getItem(SLASH_COMMAND_WARNING_SUPPRESS_KEY)).toBe('1')
  })

  it('treats unrelated values as not-suppressed', () => {
    window.localStorage.setItem(SLASH_COMMAND_WARNING_SUPPRESS_KEY, 'maybe')
    expect(isSlashCommandWarningSuppressed()).toBe(false)
  })

  it('survives a localStorage failure without throwing', () => {
    const setSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const getSpy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(() => suppressSlashCommandWarning()).not.toThrow()
      expect(isSlashCommandWarningSuppressed()).toBe(false)
    } finally {
      setSpy.mockRestore()
      getSpy.mockRestore()
    }
  })
})
