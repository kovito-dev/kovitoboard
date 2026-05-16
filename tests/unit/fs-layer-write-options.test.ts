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

  it('applies mode 0o600 verbatim when supplied via options', () => {
    // The hardened tmpfile path (Codex Review §15) must produce a
    // file that is readable / writable ONLY by the owner. We assert
    // on the security invariant directly rather than on the full
    // 0o600 bit pattern: Node's `fs.writeFileSync(..., { mode })`
    // still passes through the process `umask`, so a CI runner or
    // hardened developer shell with `umask 0o077` would clear bits
    // the production code intentionally asked for and make a
    // strict-equality check spuriously fail while the actual
    // security property (no group / world access) holds.
    //
    // What we care about is: bits below 0o600 (group + world) must
    // be zero, and the owner-rw bits must be present. Anything
    // umask might clear from the owner side is still strictly
    // tighter than what we requested, so it is safe to leave that
    // direction unchecked here.
    const fs = new DirectFsLayer()
    const target = join(dir, 'hardened.txt')

    fs.writeFileSync(target, 'secret', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })

    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0) // no group / world access
    expect(stat.mode & 0o600).toBe(0o600) // owner read+write intact
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
    // assert "no group / world access + owner-rw intact" rather
    // than the exact 0o600 bit pattern so a hardened `umask 0o077`
    // CI / dev shell does not flip this into a false negative.
    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0)
    expect(stat.mode & 0o600).toBe(0o600)
    expect(readFileSync(target)).toEqual(payload)
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
