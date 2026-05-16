/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DirectFsLayer } from '../../src/server/fs-layer.js'

/**
 * Tests for the `WriteFileSyncOptions` form of
 * `FileAccessLayer.writeFileSync`.
 *
 * Motivation: `tmux-bridge.sendViaBuffer` writes the paste body to a
 * `/tmp/kovitoboard-tmux-<uuid>.txt` tmpfile. Codex Review §15 flagged
 * that the previous 3-arg form went through Node's default mode
 * (`0o666 & ~umask`) on a world-readable `/tmp`, leaving the paste
 * exposed to other local accounts for the lifetime of the file. The
 * fix is to pass `{ mode: 0o600, flag: 'wx' }` so the file is created
 * owner-only and refuses a pre-existing path.
 */

describe('DirectFsLayer.writeFileSync (options form)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fs-layer-write-opts-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the legacy 3-arg encoding form working', () => {
    // Back-compat guard: every existing caller that passes a
    // BufferEncoding string MUST keep getting the previous behavior.
    const fs = new DirectFsLayer()
    const target = join(dir, 'legacy.txt')

    fs.writeFileSync(target, 'hello', 'utf-8')

    expect(readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('applies mode 0o600 subject to umask when forceMode is omitted', () => {
    // Without `forceMode`, the requested `mode` still passes through
    // the process `umask`, so we cannot assert the full 0o600 bit
    // pattern. What we CAN guarantee is the security invariant
    // ("no group / world access"): any umask only tightens the
    // file further, never opens it up.
    const fs = new DirectFsLayer()
    const target = join(dir, 'hardened-no-force.txt')

    fs.writeFileSync(target, 'secret', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })

    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0)
    expect(readFileSync(target, 'utf-8')).toBe('secret')
  })

  it('applies mode 0o600 verbatim when forceMode: true (umask bypass)', () => {
    // `forceMode: true` is the spec-grade path used by
    // `tmux-bridge.sendViaBuffer` (Codex Review §15,
    // `session-management.md` §7.1). The implementation MUST apply
    // the requested mode via `fchmod(2)` so the on-disk mode equals
    // exactly `0o600` regardless of the operator's `umask`. Without
    // this, a hardened shell that masks owner bits (e.g.
    // `umask 0o477`) would turn the spool file unreadable to the
    // subsequent `tmux load-buffer` call — an availability
    // regression on top of a security fix.
    //
    // Simulate that scenario inside the test: set a hostile umask
    // around the write and confirm the file still lands at 0o600.
    const fs = new DirectFsLayer()
    const target = join(dir, 'hardened-force.txt')

    const previousUmask = process.umask(0o477)
    try {
      fs.writeFileSync(target, 'secret', {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
        forceMode: true,
      })
    } finally {
      process.umask(previousUmask)
    }

    const stat = statSync(target)
    // Exact bit pattern — fchmod bypassed umask, so we get every
    // bit we asked for and no more.
    expect(stat.mode & 0o777).toBe(0o600)
    expect(readFileSync(target, 'utf-8')).toBe('secret')
  })

  it("rejects pre-existing paths when flag is 'wx' (EEXIST)", () => {
    // The `O_CREAT | O_EXCL` flag combination defends against the
    // "attacker pre-created the path" attack. With `randomUUID()`
    // names the realistic race is vanishingly small, but the spec
    // (Codex Review §15) treats EEXIST as a structural guarantee
    // rather than a probability argument.
    const fs = new DirectFsLayer()
    const target = join(dir, 'preexisting.txt')

    // Plant a file at the target path first.
    writeFileSync(target, 'planted', 'utf-8')

    expect(() => {
      fs.writeFileSync(target, 'fresh', {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      })
    }).toThrowError(/EEXIST/)

    // Original content must be intact (no truncation, no overwrite).
    expect(readFileSync(target, 'utf-8')).toBe('planted')
  })

  it('writes Buffer content with options without forcing encoding', () => {
    // `sendViaBuffer` only writes strings today, but the abstraction
    // must keep the Buffer path working so future callers (binary
    // tmpfiles) can also harden their mode.
    const fs = new DirectFsLayer()
    const target = join(dir, 'binary.bin')
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff])

    fs.writeFileSync(target, payload, { mode: 0o600, flag: 'wx' })

    // Same security-invariant style as the string case above —
    // assert "no group / world access" and leave the owner-bit
    // direction unchecked, because any umask the platform applies
    // only tightens the file further than the production code
    // requested.
    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0)
    expect(readFileSync(target)).toEqual(payload)
  })

  it('rejects forceMode with a non-exclusive flag (TypeError)', () => {
    // `forceMode: true` combined with `'w'` / `'a'` / `'r+'` would
    // turn this option into a generic "chmod an existing file"
    // primitive, broader than the tmpfile-hardening requirement
    // and a future authz footgun if reused outside `tmux-bridge`.
    // The implementation rejects it structurally; this test pins
    // that the constraint is enforced at runtime rather than just
    // documented.
    const fs = new DirectFsLayer()
    const target = join(dir, 'reject-non-exclusive.txt')

    for (const badFlag of ['w', 'w+', 'a', 'ax', 'a+', 'r+'] as const) {
      expect(() => {
        fs.writeFileSync(target, 'data', {
          encoding: 'utf-8',
          mode: 0o600,
          flag: badFlag,
          forceMode: true,
        })
      }).toThrowError(TypeError)
    }
  })

  it('defaults encoding to utf-8 when options omit it for a string', () => {
    // Match the legacy 3-arg form's default so callers can switch to
    // the options form purely to add `mode` / `flag` without losing
    // their implicit encoding contract.
    const fs = new DirectFsLayer()
    const target = join(dir, 'default-enc.txt')

    fs.writeFileSync(target, 'こんにちは', { mode: 0o600, flag: 'wx' })

    expect(readFileSync(target, 'utf-8')).toBe('こんにちは')
  })
})
