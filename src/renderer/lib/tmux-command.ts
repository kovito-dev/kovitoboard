/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Wrap a value in POSIX single quotes, escaping any embedded single quote
 * with the canonical `'\''` sequence (close quote, escaped literal quote,
 * reopen quote). Single-quoting disables every shell metacharacter —
 * `$()`, backticks, `"`, whitespace, `;` — so the wrapped value can never
 * be interpreted as shell syntax.
 */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Build the `tmux attach` command string for a given window name.
 *
 * The window name is single-quote encoded rather than interpolated into a
 * double-quoted string. tmux window names are already constrained
 * server-side (`isValidTmuxName`: `^[a-zA-Z0-9_-]{1,64}$`), so a value with
 * shell metacharacters cannot occur today. This encoding is defense in
 * depth: even if that invariant ever regressed, the copied/displayed
 * snippet would stay inert when pasted into a shell.
 *
 * Used for both the clipboard payload and the on-screen `<code>` display so
 * the two can never diverge.
 */
export function buildTmuxAttachCommand(windowName: string): string {
  return `tmux attach -t ${singleQuote(windowName)}`
}
