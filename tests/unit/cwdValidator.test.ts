/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for cwdValidator.ts
 *
 * Coverage (spec `cwd-allowlist.md` v1.0 §9.1 SSOT):
 *   - All 6 failure reasons + the ok: true success path.
 *   - projectRoot vs additionalWorkRoots subtree matching.
 *   - Boundary safety (`/project-evil` MUST NOT match `/project`).
 *   - Paths containing `..`, absolute vs relative inputs.
 *   - Denylist coverage (each anchor + subtree allowance).
 *   - `probe_failed` fallback when matched root metadata is absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateCwd,
  normaliseCanonical,
  isSubtree,
  isDenylisted,
  getDenylistAnchors,
  type ValidateCwdResult,
  type RootKind,
} from '../../src/server/cwdValidator'
import { DirectFsLayer } from '../../src/server/fs-layer'
import type { WorkRootMetadata } from '../../src/shared/setting-types'

const fs = new DirectFsLayer()

const SENSITIVE_META: WorkRootMetadata = {
  caseSensitive: true,
  probedAt: '2026-05-15T00:00:00Z',
}
const INSENSITIVE_META: WorkRootMetadata = {
  caseSensitive: false,
  probedAt: '2026-05-15T00:00:00Z',
}

const TEST_ANCHORS = {
  denylistAnchors: {
    homedir: '/home/test-user',
    kbRepoRoot: '/opt/kovitoboard-test',
  },
}

// --- shared tmp scaffolding -------------------------------------------

let tmpRoot: string
let projectRoot: string
let extraRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kb-cwdvalidator-test-'))
  projectRoot = join(tmpRoot, 'proj')
  extraRoot = join(tmpRoot, 'extra')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(extraRoot, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function metaFor(roots: string[], caseSensitive = true): Record<string, WorkRootMetadata> {
  const out: Record<string, WorkRootMetadata> = {}
  for (const r of roots) {
    out[fs.realpathSync(r)] = caseSensitive ? SENSITIVE_META : INSENSITIVE_META
  }
  return out
}

// --- normaliseCanonical -----------------------------------------------

describe('normaliseCanonical', () => {
  it('strips trailing slash but preserves the root slash', () => {
    expect(normaliseCanonical('/foo/', true)).toBe('/foo')
    expect(normaliseCanonical('/foo', true)).toBe('/foo')
    expect(normaliseCanonical('/', true)).toBe('/')
  })

  it('unifies backslashes to forward slashes', () => {
    expect(normaliseCanonical('C:\\Users\\me\\proj', false)).toBe('c:/users/me/proj')
  })

  it('lowercases the Windows drive letter only when case-insensitive', () => {
    expect(normaliseCanonical('C:/users/me', true)).toBe('c:/users/me')
    expect(normaliseCanonical('C:/Users/Me', false)).toBe('c:/users/me')
  })

  it('lowercases the full path when caseSensitive=false', () => {
    expect(normaliseCanonical('/PROJ/Sub', false)).toBe('/proj/sub')
    expect(normaliseCanonical('/PROJ/Sub', true)).toBe('/PROJ/Sub')
  })

  // CodeX PR #38 Attempt 11 LOW 2 regression — canonically
  // equivalent Unicode spellings (NFD vs NFC) must compare equal.
  // Legacy macOS HFS+ surfaces NFD; APFS / ext4 surface NFC; a
  // hand-edited setting.json can contain either form.
  it('folds NFD into NFC so equivalent Unicode spellings compare equal', () => {
    // U+00E9 'é' (NFC, 1 codepoint) vs U+0065 + U+0301 'e' + combining
    // acute (NFD, 2 codepoints) — same character, different encoding.
    const nfc = '/proj/café'
    const nfd = '/proj/café'
    expect(nfc).not.toBe(nfd) // sanity: distinct strings on input
    expect(normaliseCanonical(nfd, true)).toBe(normaliseCanonical(nfc, true))
    // Verify the chosen canonical form is NFC.
    expect(normaliseCanonical(nfd, true)).toBe(nfc)
  })

  it('preserves an already-NFC path unchanged (other than slash/case folding)', () => {
    const nfc = '/proj/already-nfc'
    expect(normaliseCanonical(nfc, true)).toBe(nfc)
  })
})

// --- isSubtree ---------------------------------------------------------

describe('isSubtree', () => {
  it('returns true when the parent equals the candidate', () => {
    expect(isSubtree('/project', '/project', true)).toBe(true)
  })

  it('returns true for an immediate child', () => {
    expect(isSubtree('/project', '/project/sub', true)).toBe(true)
  })

  it('returns true for a deep descendant', () => {
    expect(isSubtree('/project', '/project/a/b/c', true)).toBe(true)
  })

  it('rejects sibling boundary collisions (`/project-evil` is not under `/project`)', () => {
    expect(isSubtree('/project', '/project-evil', true)).toBe(false)
    expect(isSubtree('/project', '/project-evil/sub', true)).toBe(false)
  })

  it('rejects ancestor paths', () => {
    expect(isSubtree('/project/sub', '/project', true)).toBe(false)
  })

  it('honours case rules', () => {
    expect(isSubtree('/Proj', '/proj/sub', true)).toBe(false)
    expect(isSubtree('/Proj', '/proj/sub', false)).toBe(true)
  })
})

// --- isDenylisted ------------------------------------------------------

describe('isDenylisted', () => {
  const HOMEDIR = '/home/alice'
  const KB_ROOT = '/opt/kovitoboard'

  it('rejects POSIX system directories', () => {
    for (const p of ['/', '/etc', '/usr', '/var', '/opt', '/srv', '/proc', '/sys', '/dev', '/run']) {
      expect(isDenylisted(p, HOMEDIR, KB_ROOT)).toBe(true)
    }
  })

  it('rejects macOS system directories (case-insensitive comparison)', () => {
    expect(isDenylisted('/System', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('/Library', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('/Applications', HOMEDIR, KB_ROOT)).toBe(true)
  })

  it('rejects Windows system directories', () => {
    expect(isDenylisted('C:\\Windows', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('C:/Program Files', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('C:/Program Files (x86)', HOMEDIR, KB_ROOT)).toBe(true)
  })

  it('rejects the homedir itself but allows its subtree', () => {
    expect(isDenylisted('/home/alice', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('/home/alice/', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('/home/alice/Documents', HOMEDIR, KB_ROOT)).toBe(false)
    expect(isDenylisted('/home/alice/projects/my-app', HOMEDIR, KB_ROOT)).toBe(false)
  })

  it('rejects the KB repo root itself but allows its subtree', () => {
    expect(isDenylisted('/opt/kovitoboard', HOMEDIR, KB_ROOT)).toBe(true)
    expect(isDenylisted('/opt/kovitoboard/playground', HOMEDIR, KB_ROOT)).toBe(false)
  })

  it('allows normal user paths', () => {
    expect(isDenylisted('/tmp/work', HOMEDIR, KB_ROOT)).toBe(false)
    expect(isDenylisted('/home/alice/projects', HOMEDIR, KB_ROOT)).toBe(false)
  })
})

// --- getDenylistAnchors --- CodeX PR #38 Attempt 5 HIGH 1 regression

describe('getDenylistAnchors', () => {
  // The denylist comparison normalises only slash and case. If the
  // anchor itself (kbRepoRoot) is a symlink to its real directory,
  // matching it against a canonicalised user path would fail and a
  // caller could add the canonical target of the KB repo root as a
  // work root, bypassing the denylist. The fix realpaths the anchors
  // inside `getDenylistAnchors()` so the comparison happens on
  // canonical forms on both sides.
  it('canonicalises kbRepoRoot via realpath when KOVITOBOARD_PROJECT_ROOT is a symlink', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kb-denylist-anchor-'))
    try {
      const realDir = join(tmp, 'real-repo')
      const linkDir = join(tmp, 'link-repo')
      mkdirSync(realDir, { recursive: true })
      symlinkSync(realDir, linkDir, 'dir')

      const previous = process.env.KOVITOBOARD_PROJECT_ROOT
      process.env.KOVITOBOARD_PROJECT_ROOT = linkDir
      try {
        const anchors = getDenylistAnchors()
        // kbRepoRoot must report the canonical (post-realpath) form,
        // not the symlink we just wrote. fs.realpathSync(linkDir)
        // resolves to the canonical realDir form.
        expect(anchors.kbRepoRoot).toBe(fs.realpathSync(linkDir))
        // And the denylist correctly matches a canonical request cwd
        // (= realDir) against the canonical anchor (= realDir).
        expect(
          isDenylisted(fs.realpathSync(realDir), anchors.homedir, anchors.kbRepoRoot),
        ).toBe(true)
      } finally {
        if (previous === undefined) {
          delete process.env.KOVITOBOARD_PROJECT_ROOT
        } else {
          process.env.KOVITOBOARD_PROJECT_ROOT = previous
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Defensive: when realpath fails for some reason (vanished
  // directory, exotic FS), the helper must still return the raw
  // value so the denylist continues to block the literal form.
  it('falls back to the raw env value when realpath fails', () => {
    const previous = process.env.KOVITOBOARD_PROJECT_ROOT
    process.env.KOVITOBOARD_PROJECT_ROOT = '/definitely-not-a-real-path-' + Date.now()
    try {
      const anchors = getDenylistAnchors()
      expect(anchors.kbRepoRoot).toBe(process.env.KOVITOBOARD_PROJECT_ROOT)
    } finally {
      if (previous === undefined) {
        delete process.env.KOVITOBOARD_PROJECT_ROOT
      } else {
        process.env.KOVITOBOARD_PROJECT_ROOT = previous
      }
    }
  })
})

// --- validateCwd: success paths ---------------------------------------

describe('validateCwd — success', () => {
  it('returns ok:true when cwd is inside projectRoot', () => {
    const sub = join(projectRoot, 'sub')
    mkdirSync(sub)
    const result = validateCwd(sub, projectRoot, [], metaFor([projectRoot]), fs)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.matchedRootKind).toBe<RootKind>('project_root')
      expect(result.resolvedCwd).toBe(fs.realpathSync(sub))
    }
  })

  it('returns ok:true when cwd equals projectRoot', () => {
    const result = validateCwd(projectRoot, projectRoot, [], metaFor([projectRoot]), fs)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.matchedRoot).toBe(fs.realpathSync(projectRoot))
    }
  })

  it('returns ok:true when cwd is inside an additionalWorkRoots entry', () => {
    const sub = join(extraRoot, 'inner')
    mkdirSync(sub)
    const result = validateCwd(
      sub,
      projectRoot,
      [extraRoot],
      metaFor([projectRoot, extraRoot]),
      fs,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.matchedRootKind).toBe<RootKind>('additional_work_root')
    }
  })

  it('returns resolvedCwd in canonical (symlink-resolved) form', () => {
    const real = join(projectRoot, 'real')
    mkdirSync(real)
    const link = join(projectRoot, 'link')
    symlinkSync(real, link, 'dir')
    const result = validateCwd(link, projectRoot, [], metaFor([projectRoot]), fs)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolvedCwd).toBe(fs.realpathSync(real))
    }
  })
})

// --- validateCwd: failure reasons -------------------------------------

describe('validateCwd — failure reasons', () => {
  // CodeX PR #38 Attempt 7 MED 1 regression — `validateCwd()` must
  // reject relative paths before calling realpathSync(), otherwise
  // values like '.' or 'subdir' would be resolved against the Node
  // process cwd and silently pass the allow-list boundary.
  it('not_absolute when the requested cwd is a bare dot', () => {
    const result = validateCwd('.', projectRoot, [], metaFor([projectRoot]), fs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_absolute')
    }
  })

  it('not_absolute when the requested cwd is a relative subdir', () => {
    const result = validateCwd(
      'subdir',
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_absolute')
    }
  })

  it('not_absolute when the requested cwd is an empty string', () => {
    const result = validateCwd('', projectRoot, [], metaFor([projectRoot]), fs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_absolute')
    }
  })

  it('not_found when the path does not exist', () => {
    const result = validateCwd(
      join(tmpRoot, 'missing'),
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
      TEST_ANCHORS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_found')
  })

  it('not_directory when the path is a regular file', () => {
    const filePath = join(projectRoot, 'file.txt')
    writeFileSync(filePath, 'hi')
    const result = validateCwd(
      filePath,
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
      TEST_ANCHORS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_directory')
  })

  it('not_allowed when the cwd is outside every allowed root', () => {
    const outside = join(tmpRoot, 'outside')
    mkdirSync(outside)
    const result = validateCwd(
      outside,
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
      TEST_ANCHORS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_allowed')
      // outside is /tmp/.../outside, not denylisted -> CTA possible.
      expect(result.addToAllowListPossible).toBe(true)
    }
  })

  it('not_allowed with addToAllowListPossible=false when cwd is denylisted', () => {
    // /etc itself is denylisted; we cannot mkdir it inside the sandbox,
    // so pass projectRoot's parent as a stand-in by overriding anchors
    // to mark `tmpRoot` as the homedir. The cwd resolves to tmpRoot
    // exactly = a denylist anchor.
    const result = validateCwd(
      tmpRoot,
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
      { denylistAnchors: { homedir: tmpRoot, kbRepoRoot: '/unused' } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_allowed')
      expect(result.addToAllowListPossible).toBe(false)
    }
  })

  it('rejects path-component boundary collisions (`<root>-evil` not under `<root>`)', () => {
    const evil = join(tmpRoot, 'proj-evil')
    mkdirSync(evil)
    const result = validateCwd(
      evil,
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
      TEST_ANCHORS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_allowed')
  })

  it('accepts paths containing `..` once resolved into projectRoot', () => {
    const sub = join(projectRoot, 'sub')
    mkdirSync(sub)
    // `/<proj>/sub/../sub` resolves to `/<proj>/sub` and is allowed.
    const result = validateCwd(
      join(sub, '..', 'sub'),
      projectRoot,
      [],
      metaFor([projectRoot]),
      fs,
    )
    expect(result.ok).toBe(true)
  })

  it('probe_failed when matched root metadata is missing', () => {
    const sub = join(projectRoot, 'sub')
    mkdirSync(sub)
    const result = validateCwd(
      sub,
      projectRoot,
      [],
      {}, // no metadata at all
      fs,
      TEST_ANCHORS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('probe_failed')
      expect(result.matchedRoot).toBe(fs.realpathSync(projectRoot))
      expect(result.matchedRootKind).toBe<RootKind>('project_root')
    }
  })
})

// --- validateCwd: stale-root resilience ------------------------------

describe('validateCwd — stale roots', () => {
  it('skips additionalWorkRoots entries that no longer exist', () => {
    const dead = join(tmpRoot, 'dead')
    // intentionally do NOT mkdir `dead`
    const sub = join(projectRoot, 'sub')
    mkdirSync(sub)
    const result = validateCwd(
      sub,
      projectRoot,
      [dead],
      metaFor([projectRoot]),
      fs,
    )
    expect(result.ok).toBe(true)
  })
})
