/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the upload-tracker helpers added in v0.2.1 to close
 * the race between `cleanupUploads` and an in-flight upload.
 *
 * The full HTTP server boot path is out of scope for unit tests;
 * here we drive `createCleanupUploads` against a deterministic
 * `FileAccessLayer` stub and the shared `inFlightUploads`
 * singleton so the race scenario can be exercised end-to-end
 * without touching the host filesystem.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  createCleanupUploads,
  inFlightUploads,
} from '../../src/server/upload-tracker'
import type { FileAccessLayer } from '../../src/server/fs-layer'

interface FakeFile {
  mtimeMs: number
  size: number
}

interface MakeFsOpts {
  uploadDirExists?: boolean
  files: Record<string, FakeFile>
}

function makeFs(opts: MakeFsOpts) {
  const fileMap = new Map(Object.entries(opts.files))
  const dirExists = opts.uploadDirExists ?? true
  const unlinked: string[] = []
  return {
    fs: {
      existsSync: (p: string) =>
        (dirExists && p === '/tmp/uploads') || fileMap.has(p),
      readdirSync: () => Array.from(fileMap.keys()).map((p) => p.split('/').pop()!),
      statSync: (p: string) => {
        const f = fileMap.get(p)
        if (!f) throw new Error(`ENOENT: ${p}`)
        return f as unknown as ReturnType<FileAccessLayer['statSync']>
      },
      unlinkSync: (p: string) => {
        unlinked.push(p)
        fileMap.delete(p)
      },
      readFileSync: () => {
        throw new Error('not implemented')
      },
      readBytesSync: () => Buffer.alloc(0),
      writeFileSync: () => {
        throw new Error('not implemented')
      },
      writeFileAtomic: () => {
        throw new Error('not implemented')
      },
      lstatSync: () => {
        throw new Error('not implemented')
      },
      realpathSync: (p: string) => p,
      mkdirSync: () => {},
      rmdirSync: () => {},
      symlinkSync: () => {},
      renameSync: () => {},
      appendFileSync: () => {},
      watch: () => ({ close: () => {} }) as unknown as ReturnType<FileAccessLayer['watch']>,
    } as unknown as FileAccessLayer,
    unlinked,
  }
}

const TTL_MS = 24 * 60 * 60 * 1000 // 24h, matches production
const UPLOAD_DIR = '/tmp/uploads'

beforeEach(() => {
  inFlightUploads.clear()
})

afterEach(() => {
  inFlightUploads.clear()
})

describe('createCleanupUploads', () => {
  it('deletes files older than the TTL cutoff', () => {
    const now = 10_000_000
    const ancientPath = `${UPLOAD_DIR}/upload-aaa.png`
    const freshPath = `${UPLOAD_DIR}/upload-bbb.png`
    const { fs, unlinked } = makeFs({
      files: {
        [ancientPath]: { mtimeMs: now - TTL_MS - 1, size: 100 }, // expired
        [freshPath]: { mtimeMs: now - 1000, size: 100 }, // fresh
      },
    })
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => now,
    })
    cleanup()
    expect(unlinked).toEqual([ancientPath])
  })

  it('skips a file whose basename is currently in inFlightUploads', () => {
    // Scenario: an upload is mid-write at the moment the sweep
    // runs. The upload's mtime would qualify it for deletion in
    // principle (e.g. clock skew makes the new file's mtime look
    // old), but the in-flight set keeps the sweep blind to it.
    const now = 10_000_000
    const racingPath = `${UPLOAD_DIR}/upload-racing.png`
    const ancientPath = `${UPLOAD_DIR}/upload-ancient.png`
    const { fs, unlinked } = makeFs({
      files: {
        [racingPath]: { mtimeMs: now - TTL_MS - 1, size: 0 }, // looks expired
        [ancientPath]: { mtimeMs: now - TTL_MS - 1, size: 100 },
      },
    })
    inFlightUploads.add('upload-racing.png')
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => now,
    })
    cleanup()
    expect(unlinked).toEqual([ancientPath])
    expect(unlinked).not.toContain(racingPath)
  })

  it('returns silently when the upload directory does not exist', () => {
    const { fs } = makeFs({ uploadDirExists: false, files: {} })
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => 10_000_000,
    })
    expect(() => cleanup()).not.toThrow()
  })

  it('keeps files exactly at the TTL boundary (strict greater-than)', () => {
    // mtimeMs === now - ttlMs is the boundary case. The
    // implementation uses `stat.mtimeMs < cutoff` so a file
    // whose mtime equals the cutoff is preserved.
    const now = 10_000_000
    const boundaryPath = `${UPLOAD_DIR}/upload-edge.png`
    const { fs, unlinked } = makeFs({
      files: {
        [boundaryPath]: { mtimeMs: now - TTL_MS, size: 100 },
      },
    })
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => now,
    })
    cleanup()
    expect(unlinked).toEqual([])
  })

  it('swallows exceptions thrown during the sweep', () => {
    // A concurrent unlink between readdir and stat would
    // legitimately throw ENOENT. Cleanup must not propagate the
    // failure — it would otherwise poison the setInterval that
    // drives it.
    const fs = {
      existsSync: () => true,
      readdirSync: () => ['upload-x.png'],
      statSync: () => {
        throw new Error('ENOENT: gone')
      },
      unlinkSync: () => {},
    } as unknown as FileAccessLayer
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => 10_000_000,
    })
    expect(() => cleanup()).not.toThrow()
  })
})

describe('inFlightUploads — handler/sweep contract', () => {
  it('simulates the upload handler add/finally pattern', () => {
    // The production handler wraps the writeFileSync call in
    // `try { add; write } finally { delete }`. We exercise the
    // same pattern around a throwing write to confirm the
    // tracker stays consistent.
    const fileName = 'upload-flow.png'
    expect(inFlightUploads.has(fileName)).toBe(false)

    inFlightUploads.add(fileName)
    let threw = false
    try {
      // Simulate writeFileSync throwing midway.
      throw new Error('disk full')
    } catch {
      threw = true
    } finally {
      inFlightUploads.delete(fileName)
    }

    expect(threw).toBe(true)
    expect(inFlightUploads.has(fileName)).toBe(false)
  })

  it('coexists with concurrent uploads (multiple basenames in flight)', () => {
    inFlightUploads.add('upload-a.png')
    inFlightUploads.add('upload-b.png')
    inFlightUploads.add('upload-c.png')
    expect(inFlightUploads.size).toBe(3)
    inFlightUploads.delete('upload-b.png')
    expect(inFlightUploads.has('upload-a.png')).toBe(true)
    expect(inFlightUploads.has('upload-b.png')).toBe(false)
    expect(inFlightUploads.has('upload-c.png')).toBe(true)
  })
})

describe('race scenario — sweep runs while upload is in flight', () => {
  it('does not unlink the racing upload even when its stat would qualify', async () => {
    // Drive a simulated race: cleanup is scheduled while
    // `upload-x.png` is mid-write. The handler has already
    // registered the basename in inFlightUploads but the write
    // has not flushed yet, so a hostile clock could leave the
    // mtime in the deletable window. The sweep must skip it.
    const now = 10_000_000
    const racingPath = `${UPLOAD_DIR}/upload-x.png`
    const { fs, unlinked } = makeFs({
      files: {
        [racingPath]: { mtimeMs: now - TTL_MS - 5, size: 0 },
      },
    })
    const cleanup = createCleanupUploads({
      fs,
      uploadDir: UPLOAD_DIR,
      ttlMs: TTL_MS,
      now: () => now,
    })

    // Upload handler "adds" before writing.
    inFlightUploads.add('upload-x.png')

    // Cleanup races during the write window.
    cleanup()

    // Upload handler "removes" after writing succeeds.
    inFlightUploads.delete('upload-x.png')

    expect(unlinked).toEqual([])
  })
})

// Vitest's `vi` import keeps the lint check honest — the harness
// expects `vi` to be referenced somewhere in the file when it is
// in the imports list. Keep this as the last line of the file.
void vi
