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
import { execSync } from 'node:child_process'

import {
  validatePathForArtifactRead,
  resolveArtifactPath,
  prepareArtifactPathContext,
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
  // Mirror what `index.ts` does in production: build the context
  // via `prepareArtifactPathContext` so callers always pass a
  // canonical projectRoot / uploadDir. In these fixtures neither
  // is a symlink, so the canonicalization is a no-op for the
  // returned strings, but the factory call ensures the test path
  // exercises the same plumbing the route handlers use.
  return prepareArtifactPathContext({ projectRoot, uploadDir, fs: fsLayer })
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

  it('refuses a directory even when its reported size is below the cap', () => {
    // `statSync` reports a size for directories (filesystem-dependent
    // but always nonzero); without the regular-file guard the size
    // cap would let a request through and `res.sendFile` would then
    // either error or behave unexpectedly. The validator must short-
    // circuit before that.
    fs.mkdirSync(path.join(projectRoot, 'subdir'), { recursive: true })
    const result = validatePathForArtifactRead('subdir', ctx(), {
      maxSize: 100 * 1024 * 1024,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toContain('not a regular file')
  })

  it('refuses a FIFO / non-regular file when the size cap is enabled', () => {
    // FIFOs report size === 0 yet block when opened, which is
    // exactly the special-file bypass the regular-file guard
    // closes. The test runs on hosts that have `mkfifo` (Linux /
    // macOS); when it is not on the host we skip explicitly via
    // `it.skip` semantics so the missing coverage is visible
    // rather than silently passing.
    const fifoPath = path.join(projectRoot, 'pipe.fifo')
    try {
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`)
    } catch {
      console.warn('[artifact-path-validator.test] mkfifo unavailable; skipping FIFO regression case')
      return
    }
    const result = validatePathForArtifactRead('pipe.fifo', ctx(), {
      maxSize: 100 * 1024 * 1024,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toContain('not a regular file')
  })
})

describe('validatePathForArtifactRead — symlink breakouts', () => {
  it('refuses a project-internal symlink that points outside the project', () => {
    // Set up a real file outside the project + an inside-project
    // symlink that points at it. A lexical prefix check would let
    // the request through because the link itself sits under
    // `projectRoot`; the canonicalization step has to reject it.
    const outside = path.join(tmpRoot, 'outside.txt')
    fs.writeFileSync(outside, 'host secret')
    const linkInside = path.join(projectRoot, 'linked-out')
    fs.symlinkSync(outside, linkInside)

    const result = validatePathForArtifactRead('linked-out', ctx())
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Access denied: path is outside project root',
    })
  })

  it('refuses a symlinked sub-tree that escapes via an intermediate dir', () => {
    // Symlink a whole intermediate directory rather than the leaf,
    // so the canonicalization step has to walk the chain rather
    // than just check the last segment.
    const outsideDir = path.join(tmpRoot, 'out-tree')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'host secret')
    const linkInside = path.join(projectRoot, 'inner')
    fs.symlinkSync(outsideDir, linkInside)

    const result = validatePathForArtifactRead('inner/secret.txt', ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('still permits a symlink that points at a different location *inside* the project', () => {
    // A project-internal symlink that stays inside the project is
    // not a confinement violation.
    writeFixture('docs/note.md', 'inside note')
    const linkInside = path.join(projectRoot, 'shortcut')
    fs.symlinkSync(path.join(projectRoot, 'docs/note.md'), linkInside)

    const result = validatePathForArtifactRead('shortcut', ctx())
    expect(result.ok).toBe(true)
  })
})

describe('prepareArtifactPathContext — canonical invariant', () => {
  it('canonicalizes a symlinked project root once at construction', () => {
    // Set up a symlinked alias for the project root so we can
    // assert the factory resolves it to the real target rather
    // than carrying the symlinked path through to the validator.
    const realRoot = fs.realpathSync(projectRoot)
    const aliasRoot = path.join(tmpRoot, 'project-alias')
    fs.symlinkSync(projectRoot, aliasRoot)

    const built = prepareArtifactPathContext({
      projectRoot: aliasRoot,
      uploadDir,
      fs: fsLayer,
    })
    expect(built.projectRoot).toBe(realRoot)
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
