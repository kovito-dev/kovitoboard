/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Table-driven tests for the shared path-safety helpers used by the
 * operator-facing diagnostics in `kb-start.mjs` / `kb-stop.mjs`.
 *
 * These helpers sit on a security boundary (the operator-supplied projectRoot
 * is rendered into logs and suggested shell commands), so the escaping rules
 * are pinned here once for both entrypoints rather than re-asserted through
 * each tool's spawn-based tests.
 */
import { describe, expect, it } from 'vitest'

import {
  escapeForLog,
  shellQuote,
  hasControlBytes,
  removalHint,
} from '../../tools/kb-path-safety.mjs'

describe('shellQuote', () => {
  const cases: Array<[string, string]> = [
    ['plain', "'plain'"],
    ['/home/user/project', "'/home/user/project'"],
    ['has space', "'has space'"],
    ['$(rm -rf /)', "'$(rm -rf /)'"],
    ['back`tick`', "'back`tick`'"],
    ['semi;colon', "'semi;colon'"],
    ["it's", "'it'\\''s'"], // single quote → close, literal, reopen
  ]
  it.each(cases)('quotes %j → %j', (input, expected) => {
    expect(shellQuote(input)).toBe(expected)
  })
})

describe('escapeForLog', () => {
  it('leaves control-free strings untouched', () => {
    expect(escapeForLog('/home/user/project')).toBe('/home/user/project')
    expect(escapeForLog('has space and $()')).toBe('has space and $()')
  })

  it('hex-escapes newlines, CR, tab, NUL, DEL, and ANSI ESC', () => {
    expect(escapeForLog('a\nb')).toBe('a\\x0ab')
    expect(escapeForLog('a\rb')).toBe('a\\x0db')
    expect(escapeForLog('a\tb')).toBe('a\\x09b')
    expect(escapeForLog('a\x00b')).toBe('a\\x00b')
    expect(escapeForLog('a\x7fb')).toBe('a\\x7fb')
    expect(escapeForLog('a\x1b[31mb')).toBe('a\\x1b[31mb')
  })
})

describe('hasControlBytes', () => {
  it.each([
    ['/home/user', false],
    ['has space', false],
    ['$(x)', false],
    ['a\nb', true],
    ['a\rb', true],
    ['a\x1b[0m', true],
    ['a\x00', true],
    ['a\x7f', true],
  ] as Array<[string, boolean]>)('%j → %s', (input, expected) => {
    expect(hasControlBytes(input)).toBe(expected)
  })
})

describe('removalHint', () => {
  it('emits a byte-accurate shell-quoted rm for a control-free path', () => {
    const out = removalHint('/home/user/project/.kovitoboard/run/supervisor.pid')
    expect(out).toContain(
      "rm -- '/home/user/project/.kovitoboard/run/supervisor.pid'",
    )
    // No escaped-byte / one-liner fallback for the normal case.
    expect(out).not.toContain('byte-accurate one-liner')
    expect(out).not.toContain('\\x')
  })

  it('shell-quotes a path with spaces / metacharacters but stays a real rm', () => {
    const out = removalHint('/home/u/my project/run/$(x).pid')
    expect(out).toContain("rm -- '/home/u/my project/run/$(x).pid'")
  })

  it('refuses a raw rm and offers a byte-accurate one-liner for control bytes', () => {
    const evil = '/tmp/evil\n[kb-start] ERROR forged line/supervisor.pid'
    const out = removalHint(evil)
    // The raw newline must NOT appear (no forged log line); it is escaped.
    expect(out).not.toContain('\n[kb-start] ERROR forged line')
    expect(out).toContain('contains control characters')
    expect(out).toContain('\\x0a') // the newline rendered inert
    expect(out).not.toContain("rm -- '") // no copy-paste rm command
    // The one-liner reconstructs the true path from its hex bytes.
    const hex = Buffer.from(evil, 'utf-8').toString('hex')
    expect(out).toContain(hex)
    expect(out).toContain("Buffer.from('" + hex + "','hex')")
  })

  it('applies the caller-supplied indent to every line', () => {
    const out = removalHint('/x/y.pid', '[kb-stop]        ')
    for (const line of out.split('\n')) {
      expect(line.startsWith('[kb-stop]        ')).toBe(true)
    }
  })
})
