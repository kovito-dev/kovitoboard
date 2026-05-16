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
    // file that is NOT readable by anyone other than the owner.
    // We assert the security invariant directly — "no group / world
    // access" — rather than the exact 0o600 bit pattern, because
    // Node's `fs.writeFileSync(..., { mode })` still passes the
    // requested mode through the process `umask`. A CI runner or
    // hardened user shell could set a `umask` (e.g. `0o277` for a
    // read-only style hardening) that clears bits we asked for on
    // the owner side as well, and a strict-equality check would
    // then fail spuriously even though the security property holds.
    //
    // The owner-bit direction is left unchecked on purpose: any
    // umask the platform applies only makes the file MORE
    // restrictive than the production code requested, and a file
    // KovitoBoard wrote with owner bits cleared is still strictly
    // tighter than the original threat (other-UID readability)
    // demanded.
    const fs = new DirectFsLayer()
    const target = join(dir, 'hardened.txt')

    fs.writeFileSync(target, 'secret', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })

    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0) // no group / world access
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
