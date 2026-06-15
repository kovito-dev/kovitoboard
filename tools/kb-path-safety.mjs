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
 * - `escapeForLog(s)` — escape control / line / bidi characters for
 *   terminal/log safety.
 * - `shellQuote(s)` — POSIX single-quote for shell-paste safety.
 * - `hasControlBytes(s)` — true when a string contains an unsafe-for-log char.
 * - `removalHint(path, indent)` — render a copy-paste-safe removal
 *   instruction for `path`: a byte-accurate `rm -- '<path>'` when the path is
 *   safe, or a display-safe manual-removal block when it is not (so the
 *   printed command is never both unsafe AND wrong).
 */

// Characters that are unsafe to print verbatim into a single-line log /
// terminal message. The class is built from explicit numeric code points (no
// literal invisible characters in this source, which could themselves reorder
// or break it):
//   - 0x00-0x1f + 0x7f: ASCII C0 controls + DEL (newline / CR / tab / ANSI).
//   - 0x85 NEL, 0x2028 LINE SEPARATOR, 0x2029 PARAGRAPH SEPARATOR: treated as
//     line breaks by some terminals / JS contexts, so they forge an extra log
//     line just like \n.
//   - 0x200e/0x200f (LRM/RLM) + 0x202a-0x202e + 0x2066-0x2069 (bidi embedding
//     / override / isolate, the "Trojan Source" class): can reorder the
//     displayed text to make a path look like something it is not.
const UNSAFE_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x85, 0x85],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

function isUnsafeLogChar(code) {
  for (const [lo, hi] of UNSAFE_RANGES) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/**
 * Escape unsafe characters before printing an operator-supplied string into a
 * log / error line. Covers ASCII C0 controls + DEL and the Unicode line /
 * paragraph separators + bidi/format controls (see `UNSAFE_RANGES`). Each
 * unsafe code point is replaced with `\xHH` (<= 0xff) or `\uHHHH`, keeping the
 * message single-line and visually inert. Use this for the raw `Path:` /
 * `PID file:` lines where byte-accuracy is not required (the operator reads,
 * does not paste, them).
 */
export function escapeForLog(s) {
  let out = ''
  for (const ch of String(s)) {
    const code = ch.codePointAt(0)
    if (isUnsafeLogChar(code)) {
      out +=
        code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return out
}

/**
 * POSIX single-quote a string for safe inclusion in a shell command. Wrapping
 * in single quotes neutralizes every shell metacharacter (`$()`, backticks,
 * `;`, spaces); an embedded single quote is escaped as `'\''` (close-quote,
 * literal quote, re-open). Note this does NOT neutralize unsafe-for-log
 * characters (newline / CR / ANSI / bidi) for terminal display — pair it with
 * `escapeForLog` or gate on `hasControlBytes` for that.
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** True when `s` contains any character unsafe to print verbatim in a log line. */
export function hasControlBytes(s) {
  for (const ch of String(s)) {
    if (isUnsafeLogChar(ch.codePointAt(0))) return true
  }
  return false
}

/**
 * Render an operator-facing removal instruction for `path`.
 *
 * The tension: a copy-paste `rm -- '<path>'` must be BOTH byte-accurate (so
 * the operator can actually remove the file) AND terminal-safe (so unsafe
 * characters in the path cannot forge log lines or reorder the display).
 * Those two goals conflict only when the path contains unsafe characters:
 *
 * - safe path (the normal case): emit the byte-accurate, shell-safe
 *   `rm -- '<path>'`. The path pastes correctly.
 * - path with unsafe characters (pathological): do NOT emit a copy-paste
 *   command that would be either unsafe (raw bytes) or wrong (escaped, names a
 *   different file). Print a display-safe rendering of the path plus a
 *   byte-accurate Node one-liner that reconstructs the real pathname from its
 *   hex bytes, so the operator still has a working removal path.
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
