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
 * `FileAccessLayer.writeFileSync` plus the dedicated
 * `writePrivateExclusiveFileSync` helper.
 *
 * Motivation: `tmux-bridge.sendViaBuffer` writes the paste body to a
 * `/tmp/kovitoboard-tmux-<uuid>.txt` tmpfile. Codex Review §15 flagged
 * that the previous 3-arg form went through Node's default mode
 * (`0o666 & ~umask`) on a world-readable `/tmp`, leaving the paste
 * exposed to other local accounts for the lifetime of the file.
 *
 * The fix lives in two API surfaces that intentionally do not
 * overlap:
 *
 *   - `writeFileSync` keeps its generic shape and gains a typed
 *     `WriteFileSyncOptions` form (`encoding` / `mode` / `flag`).
 *     `flag` is narrowed to `WriteOpenFlag` so invalid / read-only
 *     flags are rejected at compile time. This path still honors
 *     the process `umask` — i.e. `{ mode }` is a defence-in-depth
 *     ceiling, not an exact contract.
 *   - `writePrivateExclusiveFileSync` is the spec-grade umask-
 *     independent path. It bakes `O_CREAT | O_EXCL` + `0o600` +
 *     `fchmod(2)` into a single tightly-scoped helper used only
 *     for tmpfile hardening callers like
 *     `tmux-bridge.sendViaBuffer`. The narrow shape keeps the
 *     umask-bypass capability from leaking into the generic
 *     `writeFileSync` API.
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

  it('applies mode 0o600 subject to umask on the options-form path', () => {
    // The options form goes through Node's regular `writeFileSync`,
    // which honors the process `umask`. We can guarantee the
    // security invariant ("no group / world access") because any
    // umask only tightens the file further — but we cannot pin
    // the exact 0o600 bit pattern here. That guarantee belongs
    // to `writePrivateExclusiveFileSync` below.
    const fs = new DirectFsLayer()
    const target = join(dir, 'hardened-options-form.txt')

    fs.writeFileSync(target, 'secret', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })

    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0)
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

    writeFileSync(target, 'planted', 'utf-8')

    expect(() => {
      fs.writeFileSync(target, 'fresh', {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      })
    }).toThrowError(/EEXIST/)

    expect(readFileSync(target, 'utf-8')).toBe('planted')
  })

  it('writes Buffer content with options without forcing encoding', () => {
    // The abstraction must keep the Buffer path working so future
    // callers (binary tmpfiles) can also harden their mode through
    // the options form, even though strings are the only shape
    // exercised in production today.
    const fs = new DirectFsLayer()
    const target = join(dir, 'binary.bin')
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff])

    fs.writeFileSync(target, payload, { mode: 0o600, flag: 'wx' })

    const stat = statSync(target)
    expect(stat.mode & 0o077).toBe(0)
    expect(readFileSync(target)).toEqual(payload)
  })

  it('defaults encoding to utf-8 when options omit it for a string', () => {
    // Match the legacy 3-arg form's default so callers can switch
    // to the options form purely to add `mode` / `flag` without
    // losing their implicit encoding contract.
    const fs = new DirectFsLayer()
    const target = join(dir, 'default-enc.txt')

    fs.writeFileSync(target, 'こんにちは', { mode: 0o600, flag: 'wx' })

    expect(readFileSync(target, 'utf-8')).toBe('こんにちは')
  })
})

describe('DirectFsLayer.writePrivateExclusiveFileSync (§15 spec-grade path)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fs-layer-private-excl-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file with mode 0o600 even under a hostile umask', () => {
    // The whole point of the dedicated helper is that it gives a
    // normative-grade guarantee for `0o600` regardless of the
    // operator's process `umask`. Simulate a hardened shell that
    // masks owner-read (`umask 0o477`) around the write and pin
    // the exact bit pattern; without the in-helper `fchmod` this
    // would land at `0o100` and break `tmux load-buffer`.
    const fs = new DirectFsLayer()
    const target = join(dir, 'private.txt')

    const previousUmask = process.umask(0o477)
    try {
      fs.writePrivateExclusiveFileSync(target, 'secret')
    } finally {
      process.umask(previousUmask)
    }

    const stat = statSync(target)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(readFileSync(target, 'utf-8')).toBe('secret')
  })

  it('refuses a pre-existing path with EEXIST and leaves it intact', () => {
    // The exclusive-create flag is the second leg of the threat
    // model (Codex Review §15): even if an attacker pre-created
    // the predicted UUID path, we must not silently truncate
    // their file or write into a planted symlink target. The
    // helper bakes `O_CREAT | O_EXCL` in so this property cannot
    // be opted out of by a caller.
    const fs = new DirectFsLayer()
    const target = join(dir, 'preexisting.txt')

    writeFileSync(target, 'planted', 'utf-8')

    expect(() => {
      fs.writePrivateExclusiveFileSync(target, 'fresh')
    }).toThrowError(/EEXIST/)

    // Original content + mode must be unchanged: the failed
    // exclusive open never touched the file.
    expect(readFileSync(target, 'utf-8')).toBe('planted')
  })

  it('writes Buffer content without forcing an encoding', () => {
    // tmux-bridge writes strings, but the helper supports Buffer
    // for parity with the rest of the layer. We exercise that
    // path here so a future binary-spool caller (if any) doesn't
    // need to rediscover the contract.
    const fs = new DirectFsLayer()
    const target = join(dir, 'private-binary.bin')
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff])

    fs.writePrivateExclusiveFileSync(target, payload)

    const stat = statSync(target)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(readFileSync(target)).toEqual(payload)
  })

  it('defaults encoding to utf-8 for string content', () => {
    // Match the rest of the layer so the helper does not become
    // a sharp-edged exception that needs special remembering at
    // every call site.
    const fs = new DirectFsLayer()
    const target = join(dir, 'private-utf8.txt')

    fs.writePrivateExclusiveFileSync(target, 'こんにちは')

    expect(readFileSync(target, 'utf-8')).toBe('こんにちは')
  })
})
