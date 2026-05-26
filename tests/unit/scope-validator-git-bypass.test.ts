/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Bypass tests for the `.git` exclusion family, covering the three
 * attack paths flagged during CVE-2026-26268 follow-up analysis
 * (security-threat-model.md §S2):
 *
 *   1. **Bare-repo embed** — `tools/helper.git/hooks/post-checkout`
 *      style nesting where the malicious gitdir does not live at the
 *      project root and is named `*.git` rather than `.git`. The
 *      Novee Security write-up uses this shape to land a sandbox
 *      escape via a later `git` operation that walks the nested
 *      gitdir's hooks. The pre-v0.2.1 `matchGit` predicate only
 *      blocked the literal `.git` directory and its descendants, so
 *      this nested form silently bypassed exclusion.
 *
 *   2. **Case-insensitive filesystem** (macOS HFS+ / APFS,
 *      Windows NTFS) — `.GIT/hooks` / `.Git/HEAD` style spellings.
 *      Already covered indirectly by `scope-validator-exclusion-v1-8`
 *      (the normalization pipeline case-folds before match); kept
 *      here as the SSOT for the §S2 mitigation evidence so the
 *      three attack paths sit in one file.
 *
 *   3. **Unicode variants** — zero-width / bidi-override characters
 *      embedded inside the `.git` segment, plus NFD-composed paths.
 *      Also covered indirectly elsewhere; consolidated here so the
 *      reviewer can verify the full §S2 surface in one place.
 *
 * The bare-repo case (1) is the only one that needed a code change in
 * v0.2.1 — extending `matchGit` to match any segment ending in
 * `.git`. Cases (2) and (3) lock in the existing defences so a
 * regression in the normalization pipeline cannot reopen them.
 *
 * @see docs/specs/security-threat-model.md §S2
 * @see CVE-2026-26268 (Cursor 2.5 sandbox escape via `.git/hooks` rewrite)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  normalizeForExclusionMatch,
  isForbidden,
  validatePathForScope,
} from '../../src/server/scopeValidator'

let tmpDir: string
let projectRoot: string
const APP_ID = 'test-app'

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-git-bypass-'))
  projectRoot = path.join(tmpDir, 'project')

  // Materialize the bare-repo embed surface so realpath resolution
  // produces a stable path inside `validatePathForScope`. The
  // attacker shape is `tools/helper.git/hooks/post-checkout` —
  // a nested gitdir whose basename ends in `.git` but is not
  // literally `.git`.
  fs.mkdirSync(path.join(projectRoot, 'tools', 'helper.git', 'hooks'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(projectRoot, 'tools', 'helper.git', 'hooks', 'post-checkout'),
    '#!/bin/sh\n',
  )
  // Bare-repo gitfile shape (single-file pointer) — same attack
  // surface, different on-disk shape.
  fs.mkdirSync(path.join(projectRoot, 'submodules', 'pkg.git'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(projectRoot, 'submodules', 'pkg.git', 'config'),
    '[core]\n',
  )

  // Standard `.git` for the existing-coverage anchor.
  fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.git', 'HEAD'), 'ref: x\n')

  // App data root so `own-data` scope resolution does not blow up
  // when we exercise `validatePathForScope` below.
  fs.mkdirSync(path.join(projectRoot, 'app', 'data', APP_ID), {
    recursive: true,
  })
})

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// =========================================
// Path 1: bare-repo embed (the v0.2.1 fix surface)
// =========================================

describe('matchGit — bare-repo embed (path 1)', () => {
  it('blocks tools/helper.git/hooks/post-checkout (read)', () => {
    const abs = path.join(
      projectRoot,
      'tools',
      'helper.git',
      'hooks',
      'post-checkout',
    )
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'read',
        approvedScopes: ['project-read'],
      }),
    ).toBe(true)
  })

  it('blocks tools/helper.git/hooks/post-checkout (write)', () => {
    const abs = path.join(
      projectRoot,
      'tools',
      'helper.git',
      'hooks',
      'post-checkout',
    )
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })

  it('blocks the bare gitdir itself (tools/helper.git)', () => {
    const abs = path.join(projectRoot, 'tools', 'helper.git')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })

  it('blocks deeper bare-repo nesting (submodules/pkg.git/config)', () => {
    const abs = path.join(projectRoot, 'submodules', 'pkg.git', 'config')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'read',
        approvedScopes: ['project-read'],
      }),
    ).toBe(true)
  })

  it('blocks the bare-repo write via validatePathForScope (PathForbidden)', () => {
    const result = validatePathForScope(
      'tools/helper.git/hooks/post-checkout',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(result.ok).toBe(false)
    expect(result.failedCode).toBe('PathForbidden')
  })

  it('does not block lookalike segments that merely contain "git"', () => {
    // `gitignore-helper`, `prettier-plugin-git`, `gitlab` etc. are
    // legitimate package / file names that happen to share the
    // `git` substring. The exclusion pattern must anchor to the
    // `.git` suffix so these stay reachable.
    expect(
      isForbidden('tools/gitignore-helper/README.md', projectRoot, {
        operation: 'read',
        approvedScopes: ['project-read'],
      }),
    ).toBe(false)
    expect(
      isForbidden('prettier-plugin-git/package.json', projectRoot, {
        operation: 'read',
        approvedScopes: ['project-read'],
      }),
    ).toBe(false)
  })
})

// =========================================
// Path 2: case-insensitive filesystem (regression anchor)
// =========================================

describe('matchGit — case-insensitive (path 2, regression anchor)', () => {
  it('blocks .GIT/HEAD via normalize → case-fold', () => {
    const abs = path.join(projectRoot, '.GIT', 'HEAD')
    // The on-disk fixture is `.git`; we ask normalize what the key
    // would be for an uppercase request — `normalize` does NOT
    // hit the filesystem for case folding, it just applies the
    // pipeline.
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(norm.key).toBe('.git/head')
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })

  it('blocks .Git/hooks/post-commit via mixed-case fold', () => {
    const abs = path.join(projectRoot, '.Git', 'hooks', 'post-commit')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(norm.key).toBe('.git/hooks/post-commit')
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })

  it('blocks an uppercase bare-repo embed (Tools/Helper.GIT/hooks)', () => {
    const abs = path.join(
      projectRoot,
      'Tools',
      'Helper.GIT',
      'hooks',
      'post-checkout',
    )
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    expect(norm.key).toBe('tools/helper.git/hooks/post-checkout')
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })
})

// =========================================
// Path 3: Unicode variants (regression anchor)
// =========================================

describe('matchGit — Unicode variants (path 3, regression anchor)', () => {
  it('rejects .git<U+200B>/HEAD as suspicious', () => {
    // Zero-width space inside the `.git` segment: the §6.6.2 step 3
    // reject list catches this before exclusion match so a recipe
    // cannot mask the segment from the normalize pipeline.
    const abs = path.join(projectRoot, '.git​', 'HEAD')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(false)
    if (norm.ok) return
    expect(norm.reason).toBe('SuspiciousChar')
  })

  it('rejects a bare-repo embed laced with U+200C', () => {
    const abs = path.join(
      projectRoot,
      'tools',
      'helper‌.git',
      'hooks',
      'post-checkout',
    )
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(false)
    if (norm.ok) return
    expect(norm.reason).toBe('SuspiciousChar')
  })

  it('rejects a bidi-override prefix (U+202E) before .git', () => {
    const abs = path.join(projectRoot, '‮.git', 'HEAD')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(false)
    if (norm.ok) return
    expect(norm.reason).toBe('SuspiciousChar')
  })

  it('matches the NFD-composed form of a bare-repo embed', () => {
    // U+0065 + U+0301 ("é" in NFD) folded back to NFC before match.
    // A recipe cannot smuggle a decomposed bare-repo path past the
    // exclusion table.
    const nfdHelper = 'hélper.git'
    const abs = path.join(projectRoot, 'tools', nfdHelper, 'hooks', 'post-checkout')
    const norm = normalizeForExclusionMatch(abs, projectRoot)
    expect(norm.ok).toBe(true)
    if (!norm.ok) return
    // The folded key uses the NFC form of `é`.
    expect(norm.key).toBe(
      `tools/${'hélper.git'.normalize('NFC')}/hooks/post-checkout`,
    )
    expect(
      isForbidden(norm.key, projectRoot, {
        operation: 'write',
        approvedScopes: ['project-write'],
      }),
    ).toBe(true)
  })
})
