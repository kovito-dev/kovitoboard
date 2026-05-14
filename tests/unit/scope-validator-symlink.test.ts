/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Regression test: scope validation must succeed when projectRoot is
 * itself a symlink.
 *
 * Original failure mode: `validatePathForScope` called `realpath` on
 * the user-supplied `path` argument (via `normalizePath`) but kept
 * `scopeRoot` as the unresolved symlink path. The two values then
 * never shared a prefix, so even `path: "."` was rejected with
 * `PathOutOfScope`. Reproduced in the kb-test runner, which exposes
 * the user's project as `~/test/kb-latest -> kb-blank-<ts>`.
 *
 * The fix resolves both `projectRoot` and `scopeRoot` up front so
 * `isWithin` compares two physical paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { validatePathForScope } from '../../src/server/scopeValidator'

let tmpDir: string
let realProject: string
let symlinkProject: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scope-symlink-test-'))
  realProject = path.join(tmpDir, 'real-project')
  symlinkProject = path.join(tmpDir, 'project-link')

  fs.mkdirSync(path.join(realProject, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(realProject, 'docs', 'README.md'), '# hi')
  fs.symlinkSync(realProject, symlinkProject, 'dir')
})

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('validatePathForScope — symlink projectRoot', () => {
  it('accepts "." (project root itself) when projectRoot is a symlink', () => {
    const result = validatePathForScope(
      '.',
      ['project-read'],
      ['project-read'],
      'rid',
      symlinkProject,
      undefined,
      'read',
    )
    expect(result.ok).toBe(true)
    // The dispatcher now consumes `resolvedPath` as the physical
    // base, so it must be the realpath of the symlink target.
    expect(result.resolvedPath).toBe(fs.realpathSync(realProject))
  })

  it('accepts a relative subpath when projectRoot is a symlink', () => {
    const result = validatePathForScope(
      'docs/README.md',
      ['project-read'],
      ['project-read'],
      'rid',
      symlinkProject,
      undefined,
      'read',
    )
    expect(result.ok).toBe(true)
    expect(result.resolvedPath).toBe(
      path.join(fs.realpathSync(realProject), 'docs', 'README.md'),
    )
  })

  it('still rejects an out-of-tree absolute path under symlink projectRoot', () => {
    // tmpDir's parent is /tmp; pick a path guaranteed to be outside
    // the project tree.
    const outside = path.join(os.tmpdir(), 'definitely-outside-kb-scope-test')
    const result = validatePathForScope(
      outside,
      ['project-read'],
      ['project-read'],
      'rid',
      symlinkProject,
      undefined,
      'read',
    )
    expect(result.ok).toBe(false)
    expect(result.failedCode).toBe('PathOutOfScope')
    expect(result.resolvedPath).toBeUndefined()
  })

  it('continues to work when projectRoot is a regular directory (no regression)', () => {
    const result = validatePathForScope(
      '.',
      ['project-read'],
      ['project-read'],
      'rid',
      realProject,
      undefined,
      'read',
    )
    expect(result.ok).toBe(true)
    expect(result.resolvedPath).toBe(fs.realpathSync(realProject))
  })
})
