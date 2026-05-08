/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DirectFsLayer } from '../../src/server/fs-layer.js'

/**
 * Tests for the atomic write helper added to `DirectFsLayer`.
 *
 * Strategy:
 *
 * - Happy-path / mode / cleanup-on-success cases run against the real
 *   filesystem in a per-test tempdir.
 * - Failure-injection cases (rename throws, fsync throws,
 *   cross-device) cannot use `vi.spyOn(nodeFs, ...)` because vitest
 *   ESM can't redefine module namespace exports. Instead we use a
 *   subclass of `DirectFsLayer` and override the small private hook
 *   methods (`_rename`, `_fsync`) — these are added below the public
 *   interface specifically for testability and have no production
 *   callers.
 *
 * Mapping back to C-1 spec T-1..T-6:
 *
 * - T-1 happy path
 * - T-2 default mode 0o600
 * - T-3 caller-supplied mode override
 * - T-4 atomicity: a failed rename leaves the previous file untouched
 * - T-5 error cleanup: a failed fsync leaves no leftover temp file
 * - T-6 cross-device rename error surfaces as a thrown error
 */

let workDir: string
const fs = new DirectFsLayer()

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-atomic-write-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('DirectFsLayer.writeFileAtomic — T-1 happy path', () => {
  it('writes string content to the destination', () => {
    const target = join(workDir, 'target.json')
    fs.writeFileAtomic(target, '{"ok":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"ok":1}')
  })

  it('writes Buffer content to the destination', () => {
    const target = join(workDir, 'binary.bin')
    fs.writeFileAtomic(target, Buffer.from([0x01, 0x02, 0x03]))
    expect(readFileSync(target).equals(Buffer.from([0x01, 0x02, 0x03]))).toBe(
      true,
    )
  })

  it('leaves no temp files behind on success', () => {
    const target = join(workDir, 'target.json')
    fs.writeFileAtomic(target, '{"ok":1}')
    expect(readdirSync(workDir)).toEqual(['target.json'])
  })

  it('overwrites a pre-existing destination file', () => {
    const target = join(workDir, 'target.json')
    writeFileSync(target, '{"version":1}')
    fs.writeFileAtomic(target, '{"version":2}')
    expect(readFileSync(target, 'utf-8')).toBe('{"version":2}')
    expect(readdirSync(workDir)).toEqual(['target.json'])
  })
})

describe('DirectFsLayer.writeFileAtomic — T-2 default mode 0o600', () => {
  it('creates the destination file with mode 0o600 by default', () => {
    const target = join(workDir, 'mode-default.json')
    fs.writeFileAtomic(target, 'x')
    // The low 9 bits hold the rwxrwxrwx mode triplet; mask the rest
    // (file-type bits, sticky/setuid) so the comparison is portable.
    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('DirectFsLayer.writeFileAtomic — T-3 mode override', () => {
  it('honours an explicit mode option', () => {
    const target = join(workDir, 'mode-override.json')
    fs.writeFileAtomic(target, 'x', { mode: 0o644 })
    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o644)
  })

  it('treats fsync=false as a valid opt-out (no exception)', () => {
    const target = join(workDir, 'no-fsync.json')
    expect(() =>
      fs.writeFileAtomic(target, 'x', { fsync: false }),
    ).not.toThrow()
    expect(readFileSync(target, 'utf-8')).toBe('x')
  })
})

/**
 * Failure-injection harness: subclass `DirectFsLayer` and override
 * the rename / fsync hooks. The base class delegates to these hooks
 * exactly once per `writeFileAtomic` call, so a throwing override
 * exercises the same finally-cleanup path the production code would
 * see if the kernel returned ENOSPC / EIO / EXDEV.
 */
class InjectableFs extends DirectFsLayer {
  renameImpl: ((oldPath: string, newPath: string) => void) | null = null
  fsyncImpl: ((fd: number) => void) | null = null

  protected override _rename(oldPath: string, newPath: string): void {
    if (this.renameImpl) {
      this.renameImpl(oldPath, newPath)
      return
    }
    super._rename(oldPath, newPath)
  }

  protected override _fsync(fd: number): void {
    if (this.fsyncImpl) {
      this.fsyncImpl(fd)
      return
    }
    super._fsync(fd)
  }
}

describe('DirectFsLayer.writeFileAtomic — T-4 atomicity: rename failure preserves prior content', () => {
  it('leaves the previous destination untouched when rename throws', () => {
    const target = join(workDir, 'preserved.json')
    writeFileSync(target, '{"version":1}')

    const inj = new InjectableFs()
    let renameCalls = 0
    inj.renameImpl = () => {
      renameCalls += 1
      throw new Error('ENOSPC: simulated disk full')
    }

    expect(() => inj.writeFileAtomic(target, '{"version":2}')).toThrow(
      /ENOSPC|disk full/,
    )

    // Original file untouched, temp file cleaned up.
    expect(readFileSync(target, 'utf-8')).toBe('{"version":1}')
    expect(renameCalls).toBe(1)
    expect(readdirSync(workDir)).toEqual(['preserved.json'])
  })
})

describe('DirectFsLayer.writeFileAtomic — T-5 error cleanup: fsync failure removes the temp file', () => {
  it('removes the temp file when fsync throws mid-write', () => {
    const target = join(workDir, 'cleanup.json')
    const inj = new InjectableFs()
    let fsyncCalls = 0
    inj.fsyncImpl = () => {
      fsyncCalls += 1
      throw new Error('EIO: simulated fsync failure')
    }

    expect(() => inj.writeFileAtomic(target, '{"never":true}')).toThrow(
      /EIO|fsync failure/,
    )

    // Destination must not exist (write never reached rename) and no
    // temp sibling should be left lying around.
    expect(readdirSync(workDir)).toEqual([])
    expect(fsyncCalls).toBe(1)
  })
})

describe('DirectFsLayer.writeFileAtomic — T-6 cross-device rename error propagates', () => {
  it('throws when rename fails with EXDEV (cross-device)', () => {
    const target = join(workDir, 'xdev.json')
    const inj = new InjectableFs()
    inj.renameImpl = () => {
      const err = new Error('EXDEV: cross-device link not permitted') as Error & {
        code: string
      }
      err.code = 'EXDEV'
      throw err
    }

    expect(() => inj.writeFileAtomic(target, 'x')).toThrow(/EXDEV/)
    // Temp cleanup should still have run despite the failure.
    expect(readdirSync(workDir)).toEqual([])
  })
})
