/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Helpers for the Claude Code TUI slash-command warning dialog
 * (Q12 / SS-6).
 *
 * Why this is a separate util:
 *   - Two senders (ChatTimeline and AmbientSidebar) need the same
 *     detection rule and the same localStorage key. Centralising them
 *     keeps the suppression flag consistent between surfaces.
 *   - The detection regex matches the spec literally (`/^\/[a-z]/i`)
 *     so slash-prefixed prose ("// comment", "/path/to/file") and
 *     slash-only inputs ("/", "/ ") slip through without alarming
 *     the user. Multi-line composer drafts only check the first
 *     non-blank line — Claude Code TUI commands are always single
 *     lines, so a long edit attached after a slash-only first line
 *     should still trigger the dialog.
 */

/** localStorage key flipping the dialog off for the current browser. */
export const SLASH_COMMAND_WARNING_SUPPRESS_KEY = 'kb.tuiCommand.suppressWarning'

/** Detection regex per Q12 spec — leading "/" followed by a letter. */
const SLASH_COMMAND_PATTERN = /^\/[a-z]/i

/**
 * Returns the candidate command string when the trimmed message looks
 * like a Claude Code TUI command. Multi-line input is allowed: the
 * first non-blank line is what gets evaluated, since Claude's TUI
 * commands always live on their own line. Returns `null` when the
 * input is not slash-prefixed.
 */
export function detectSlashCommand(message: string): string | null {
  if (!message) return null
  const firstNonBlank = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstNonBlank) return null
  return SLASH_COMMAND_PATTERN.test(firstNonBlank) ? firstNonBlank : null
}

/**
 * Read whether the user previously asked KB to stop showing the
 * slash-command warning. Robust against missing-storage environments
 * (SSR, locked-down tabs) by treating any access failure as "do
 * still show the warning".
 */
export function isSlashCommandWarningSuppressed(): boolean {
  try {
    return window.localStorage.getItem(SLASH_COMMAND_WARNING_SUPPRESS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Persist the "do not show this again" preference. Silently ignores
 * storage errors — the warning will simply re-appear on the next
 * slash command, which is the safer default.
 */
export function suppressSlashCommandWarning(): void {
  try {
    window.localStorage.setItem(SLASH_COMMAND_WARNING_SUPPRESS_KEY, '1')
  } catch {
    // best-effort
  }
}
