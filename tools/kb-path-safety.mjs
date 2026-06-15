/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Path-safety helpers for operator-facing diagnostics shared by the
 * supervisor (`kb-start.mjs`) and the stop CLI (`kb-stop.mjs`).
 *
 * These sit on a security boundary: the PID-file path is derived from the
 * operator-supplied projectRoot, and both tools print it into multi-line
 * error output and suggested shell commands. Keeping a single source for the
 * escaping rules avoids a future fix landing in only one entrypoint and
 * reintroducing inconsistent behavior. The helpers are pure (no side
 * effects, no `child_process`), so they are unit-tested directly without
 * importing the full supervisor module (which runs its launch sequence on
 * import).
 *
 * Public API:
 *
 * - `escapeForLog(s)` — hex-escape control bytes for terminal/log safety.
 * - `shellQuote(s)` — POSIX single-quote for shell-paste safety.
 * - `hasControlBytes(s)` — true when a string contains C0 controls / DEL.
 * - `removalHint(path, indent)` — render a copy-paste-safe removal
 *   instruction for `path`: a byte-accurate `rm -- '<path>'` when the path
 *   is control-free, or a display-safe manual-removal block when it is not
 *   (so the printed command is never both unsafe AND wrong).
 */

// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\x00-\x1f\x7f]/

/**
 * Escape control characters (newlines, carriage returns, ANSI escapes, other
 * C0 controls + DEL) before printing an operator-supplied string into a
 * log / error line. Replaces each control byte with its `\xHH` hex escape,
 * keeping the message single-line and inert. Use this for the raw `Path:` /
 * `PID file:` lines where byte-accuracy is not required (the operator reads,
 * does not paste, them).
 */
export function escapeForLog(s) {
  return String(s).replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )
}

/**
 * POSIX single-quote a string for safe inclusion in a shell command. Wrapping
 * in single quotes neutralizes every shell metacharacter (`$()`, backticks,
 * `;`, spaces); an embedded single quote is escaped as `'\''` (close-quote,
 * literal quote, re-open). Note this does NOT neutralize raw control bytes
 * (newline / CR / ANSI) for terminal display — pair it with `escapeForLog`
 * or gate on `hasControlBytes` for that.
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** True when `s` contains any C0 control byte or DEL. */
export function hasControlBytes(s) {
  return CONTROL_BYTES.test(String(s))
}

/**
 * Render an operator-facing removal instruction for `path`.
 *
 * The tension: a copy-paste `rm -- '<path>'` must be BOTH byte-accurate (so
 * the operator can actually remove the file) AND terminal-safe (so control
 * bytes in the path cannot forge log lines). Those two goals conflict only
 * when the path contains control bytes:
 *
 * - control-free path (the normal case): emit the byte-accurate, shell-safe
 *   `rm -- '<path>'`. `escapeForLog` is a no-op here, so the command pastes
 *   correctly.
 * - path with control bytes (pathological): do NOT emit a copy-paste command
 *   that would be either unsafe (raw bytes) or wrong (escaped, names a
 *   different file). Print a display-safe rendering of the path plus a
 *   byte-accurate Node one-liner that reconstructs the real pathname from its
 *   escaped form, so the operator still has a working removal path.
 *
 * `indent` is the leading whitespace applied to each rendered line so the
 * block aligns with the caller's `[kb-start]` / `[kb-stop]` prefix style.
 * Returns a multi-line string WITHOUT a trailing newline.
 */
export function removalHint(path, indent = '        ') {
  const p = String(path)
  if (!hasControlBytes(p)) {
    return `${indent}Remove it with:\n${indent}  rm -- ${shellQuote(p)}`
  }
  // Pathological path: render a safe display form + a byte-accurate Node
  // one-liner. We pass the original bytes as a hex-decoded buffer so the
  // command names the true file even though it is never printed raw.
  const hex = Buffer.from(p, 'utf-8').toString('hex')
  return (
    `${indent}The PID-file path contains control characters and is shown escaped:\n` +
    `${indent}  ${escapeForLog(p)}\n` +
    `${indent}Do NOT paste a raw rm command. Remove the file with this byte-accurate one-liner:\n` +
    `${indent}  node -e "require('fs').unlinkSync(Buffer.from('${hex}','hex').toString('utf8'))"`
  )
}
