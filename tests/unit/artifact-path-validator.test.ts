/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `validatePathForArtifactRead` — the helper used by
 * `/api/artifact{,/raw}` to refuse paths that would either (a) reach
 * outside the project + upload roots or (b) hit the dispatcher's
 * hardcoded exclusion list, and to enforce an opt-in size cap on the
 * raw branch.
 *
 * Pinned behaviour (Codex review #9):
 *   - `?path=.env` / `?path=.git/HEAD` / `?path=node_modules/foo`
 *     return 403 with the "matches the artifact exclusion list" error
 *     even though they sit inside the project root, so the preview
 *     route cannot be used as a side-channel around the dispatcher's
 *     scope rules.
 *   - Upload-directory reads are still permitted because the
 *     exclusion patterns are project-relative.
 *   - The raw size cap is opt-in: omitting `maxSize` keeps the JSON
 *     branch's existing behaviour, passing it returns 413 for any
 *     file whose size exceeds the cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  validatePathForArtifactRead,
  resolveArtifactPath,
} from '../../src/server/artifact-path-validator'
import { DirectFsLayer } from '../../src/server/fs-layer'

let tmpRoot: string
let projectRoot: string
let uploadDir: string

const fsLayer = new DirectFsLayer()

beforeEach(() => {
  // Each test gets a fresh project root + upload directory so we can
  // freely create exclusion-pattern files, oversized files, etc.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-artifact-validator-'))
  projectRoot = path.join(tmpRoot, 'project')
  uploadDir = path.join(tmpRoot, 'uploads')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(uploadDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function ctx() {
  return { projectRoot, uploadDir, fs: fsLayer }
}

function writeFixture(rel: string, content = 'x'): string {
  const abs = path.join(projectRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

describe('validatePathForArtifactRead — confinement', () => {
  it('accepts a project-rooted relative path', () => {
    writeFixture('docs/note.md', 'hello')
    const result = validatePathForArtifactRead('docs/note.md', ctx())
    expect(result).toEqual({
      ok: true,
      resolved: path.join(projectRoot, 'docs/note.md'),
    })
  })

  it('accepts an absolute path inside the project', () => {
    writeFixture('docs/note.md', 'hello')
    const abs = path.join(projectRoot, 'docs/note.md')
    const result = validatePathForArtifactRead(abs, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toBe(abs)
  })

  it('refuses a path that escapes the project root via ..', () => {
    const result = validatePathForArtifactRead('../escape.txt', ctx())
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Access denied: path is outside project root',
    })
  })

  it('accepts a path inside the upload directory', () => {
    const upload = path.join(uploadDir, 'abc-123.png')
    fs.writeFileSync(upload, 'x')
    const result = validatePathForArtifactRead(upload, ctx())
    expect(result).toEqual({ ok: true, resolved: upload })
  })

  it('refuses an absolute path under neither root', () => {
    const elsewhere = path.join(tmpRoot, 'somewhere-else.txt')
    fs.writeFileSync(elsewhere, 'x')
    const result = validatePathForArtifactRead(elsewhere, ctx())
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Access denied: path is outside project root',
    })
  })
})

describe('validatePathForArtifactRead — exclusion list', () => {
  it('refuses .env in the project root', () => {
    writeFixture('.env', 'SECRET=1')
    const result = validatePathForArtifactRead('.env', ctx())
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Access denied: path matches the artifact exclusion list',
    })
  })

  it('refuses .env.production', () => {
    writeFixture('.env.production', 'SECRET=1')
    const result = validatePathForArtifactRead('.env.production', ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('refuses files anywhere under .git/', () => {
    writeFixture('.git/HEAD', 'ref: refs/heads/main')
    const result = validatePathForArtifactRead('.git/HEAD', ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('refuses files anywhere under node_modules/', () => {
    writeFixture('node_modules/some-pkg/package.json', '{}')
    const result = validatePathForArtifactRead(
      'node_modules/some-pkg/package.json',
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('refuses .claude/credentials variants', () => {
    writeFixture('.claude/credentials.json', '{}')
    const result = validatePathForArtifactRead(
      '.claude/credentials.json',
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('does NOT apply the exclusion list to upload-directory reads', () => {
    // The exclusion patterns are project-relative; an upload that
    // happens to be named `.env` is still produced by KB's own
    // upload pipeline and must remain previewable.
    const dotEnvUpload = path.join(uploadDir, '.env')
    fs.writeFileSync(dotEnvUpload, 'SECRET=1')
    const result = validatePathForArtifactRead(dotEnvUpload, ctx())
    expect(result).toEqual({ ok: true, resolved: dotEnvUpload })
  })
})

describe('validatePathForArtifactRead — size cap', () => {
  it('returns 413 when the resolved file exceeds the cap', () => {
    writeFixture('big.bin', 'x'.repeat(200))
    const result = validatePathForArtifactRead('big.bin', ctx(), {
      maxSize: 100,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
    expect(result.error).toContain('exceeds the artifact read limit')
  })

  it('returns ok when the file size is within the cap', () => {
    writeFixture('small.bin', 'tiny')
    const result = validatePathForArtifactRead('small.bin', ctx(), {
      maxSize: 100,
    })
    expect(result.ok).toBe(true)
  })

  it('skips the size check when maxSize is omitted', () => {
    writeFixture('big.bin', 'x'.repeat(10000))
    const result = validatePathForArtifactRead('big.bin', ctx())
    expect(result.ok).toBe(true)
  })

  it('returns 404 when the size check finds no file', () => {
    const result = validatePathForArtifactRead('missing.bin', ctx(), {
      maxSize: 100,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('File not found')
  })
})

describe('resolveArtifactPath — bare confinement', () => {
  it('returns the absolute path for a project-relative input', () => {
    writeFixture('a.txt', '1')
    const result = resolveArtifactPath('a.txt', { projectRoot, uploadDir })
    expect(result).toBe(path.join(projectRoot, 'a.txt'))
  })

  it('returns null for a path outside both allowed roots', () => {
    const result = resolveArtifactPath(
      path.join(tmpRoot, 'other.txt'),
      { projectRoot, uploadDir },
    )
    expect(result).toBeNull()
  })
})
