/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the v1.8 operation-aware exclusion table and the
 * §6.6.2 path normalization pipeline.
 *
 * Covers:
 *   - `normalizeForExclusionMatch` step 2-6 (NFC, suspicious-char
 *     reject, separator unification, Win32 canonicalization,
 *     case-fold) and the "outside projectRoot" empty-key shortcut.
 *   - `isForbidden` operation-aware semantics: read+write full blocks
 *     vs. write-only blocks with read bypass via `agents-read` /
 *     `skills-read` / `claude-md-read`.
 *   - `filterExcludedEntries` per-entry bypass selection from the
 *     recipe's approved scopes.
 *   - `validatePathForScope` end-to-end: legacy patterns (`.env`,
 *     `.git/`, `node_modules/`, `.claude/credentials*`) plus the v1.8
 *     additions (`.claude/hooks/`, `.claude/settings.json`,
 *     `.claude/settings.local.json`, `.claude/commands/`,
 *     `.claude/agents/`, `.claude/skills/`, any nested `CLAUDE.md` /
 *     `CLAUDE.local.md`).
 *   - Case-fold and Win32 canonicalization (`.GIT/HEAD`, `Claude.md`,
 *     `CLAUDE.md.`, `CLAUDE.md ` trailing space).
 *   - The `PathRejectedSuspiciousChar` security event for zero-width /
 *     bidi-override characters.
 *
 * @see recipe-system.md v1.8 §6.5.4 / §6.5.5 / §6.6 / §6.6.2 / §6.6.3
 * @see security-threat-model.md v1.2 §S2 / §S3 / §S9
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  normalizeForExclusionMatch,
  isForbidden,
  filterExcludedEntries,
  validatePathForScope,
} from '../../src/server/scopeValidator'

let tmpDir: string
let projectRoot: string
const APP_ID = 'test-app'

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-excl-v18-'))
  projectRoot = path.join(tmpDir, 'project')
  // Materialise enough of the project tree so realpath resolution
  // produces stable paths inside `validatePathForScope`.
  fs.mkdirSync(path.join(projectRoot, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.claude', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.claude', 'commands'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'app', 'data', APP_ID), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'pkg', 'sub'), { recursive: true })

  fs.writeFileSync(path.join(projectRoot, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(projectRoot, '.env.production'), 'PROD=1')
  fs.writeFileSync(path.join(projectRoot, '.git', 'HEAD'), 'ref: x')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'credentials'), 'tok')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), '{}')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'hooks', 'post-launch.sh'), '#!/bin/sh')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'commands', 'cmd.md'), 'cmd')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'agents', 'agent.md'), '# agent')
  fs.writeFileSync(path.join(projectRoot, '.claude', 'skills', 'skill.md'), '# skill')
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# root CLAUDE')
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.local.md'), '# root local')
  fs.writeFileSync(path.join(projectRoot, 'pkg', 'CLAUDE.md'), '# pkg CLAUDE')
  fs.writeFileSync(path.join(projectRoot, 'pkg', 'sub', 'CLAUDE.md'), '# sub CLAUDE')
  fs.writeFileSync(path.join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'm.e={}')
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# proj')
})

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// =========================================
// normalizeForExclusionMatch
// =========================================

describe('normalizeForExclusionMatch', () => {
  it('produces a project-relative case-folded forward-slash key', () => {
    const abs = path.join(projectRoot, '.Git', 'HEAD')
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe('.git/head')
  })

  it('returns an empty key for paths outside the project root', () => {
    const result = normalizeForExclusionMatch(
      path.join(os.tmpdir(), 'somewhere-else'),
      projectRoot,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe('')
  })

  it('does not classify in-project names starting with ".." as outside-root', () => {
    // Segment-aware outside-root check: legitimate in-project paths
    // such as `..cache/.env` or `..team/CLAUDE.md` must still flow
    // into exclusion match. A naive `startsWith('..')` would let
    // them bypass the table entirely.
    const dotdotEnv = path.join(projectRoot, '..cache', '.env')
    const r1 = normalizeForExclusionMatch(dotdotEnv, projectRoot)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.key).toBe('..cache/.env')

    const dotdotClaude = path.join(projectRoot, '..team', 'CLAUDE.md')
    const r2 = normalizeForExclusionMatch(dotdotClaude, projectRoot)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.key).toBe('..team/claude.md')
  })

  it('still classifies "../foo" relative paths as outside the project root', () => {
    // Sanity check: actual parent-directory escapes still produce
    // an empty exclusion key (treated as outside the root by
    // upstream scope region checks).
    const outside = path.dirname(projectRoot)
    const r = normalizeForExclusionMatch(outside, projectRoot)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.key).toBe('')
  })

  it('returns an empty key for the project root itself', () => {
    const result = normalizeForExclusionMatch(projectRoot, projectRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe('')
  })

  it('strips trailing dots from each segment (NTFS alias defence)', () => {
    const abs = path.join(projectRoot, 'CLAUDE.md.')
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe('claude.md')
  })

  it('strips trailing spaces from each segment (NTFS alias defence)', () => {
    const abs = path.join(projectRoot, 'CLAUDE.md ')
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe('claude.md')
  })

  it('rejects a path containing a zero-width character (U+200B)', () => {
    const abs = path.join(projectRoot, '.git​', 'HEAD')
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('SuspiciousChar')
  })

  it('rejects a path containing a bidi override (U+202E)', () => {
    const abs = path.join(projectRoot, '‮.env')
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('SuspiciousChar')
  })

  it('normalizes NFD-composed input to NFC before matching', () => {
    // U+00E9 "é" (NFC, single code point) vs. U+0065 + U+0301 (NFD).
    // The match key for both forms must be byte-identical so a recipe
    // cannot smuggle a decomposed variant past the exclusion match.
    const nfdSegment = 'é'
    const abs = path.join(projectRoot, `${nfdSegment}.env`)
    const result = normalizeForExclusionMatch(abs, projectRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toBe(`${'é'.normalize('NFC')}.env`)
  })
})

// =========================================
// isForbidden — operation-aware
// =========================================

describe('isForbidden', () => {
  it('blocks .env on read and write (no bypass)', () => {
    expect(
      isForbidden('.env', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.env', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  it('blocks .env.production (the .env.* variant)', () => {
    expect(
      isForbidden('.env.production', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  it('blocks .git tree on read and write', () => {
    expect(
      isForbidden('.git/head', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.git/hooks/post-commit', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  it('blocks node_modules tree', () => {
    expect(
      isForbidden('node_modules/pkg/index.js', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  it('blocks .claude/credentials*', () => {
    expect(
      isForbidden('.claude/credentials', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/credentials.json', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  // v1.8: full-block additions
  it('blocks .claude/hooks/** read and write (v1.8)', () => {
    expect(
      isForbidden('.claude/hooks/post-launch.sh', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/hooks/post-launch.sh', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  it('blocks .claude/settings.json read and write (v1.8)', () => {
    expect(
      isForbidden('.claude/settings.json', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/settings.json', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  it('blocks .claude/settings.local.json read and write (v1.8)', () => {
    expect(
      isForbidden('.claude/settings.local.json', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/settings.local.json', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  it('blocks .claude/commands/** read and write (v1.8)', () => {
    expect(
      isForbidden('.claude/commands/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/commands/foo.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
  })

  // v1.8: narrow-scope subtree blocks with read bypass via the
  // dedicated `agents-read` / `skills-read` / `claude-md-read` scope.
  // (project-read alone cannot reach these paths.)
  it('blocks .claude/agents/** read+write; allows reads only via agents-read (v1.8)', () => {
    expect(
      isForbidden('.claude/agents/foo.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
    // agents-read bypasses the read block (its scope root is
    // .claude/agents/ — the dedicated narrow scope).
    expect(
      isForbidden('.claude/agents/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: 'agents-read',
      }),
    ).toBe(false)
    // project-read alone is **not** sufficient — narrow-scope subtree
    // remains read-blocked.
    expect(
      isForbidden('.claude/agents/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
    // agents-read does **not** bypass writes (write opt-in scope is
    // deferred to v0.3.0).
    expect(
      isForbidden('.claude/agents/foo.md', projectRoot, {
        operation: 'write',
        matchedScope: 'agents-read',
      }),
    ).toBe(true)
  })

  it('blocks .claude/skills/** read+write; allows reads only via skills-read (v1.8)', () => {
    expect(
      isForbidden('.claude/skills/foo.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
    expect(
      isForbidden('.claude/skills/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: 'skills-read',
      }),
    ).toBe(false)
    expect(
      isForbidden('.claude/skills/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  // Regression: overlapping rules must each get a chance to grant a
  // bypass. `.claude/agents/CLAUDE.md` matches both the
  // `.claude/agents/**` entry (bypass via `agents-read`) and the
  // `CLAUDE.md` basename entry (bypass via `claude-md-read`). A
  // first-match short-circuit would block the path for a recipe that
  // only holds `claude-md-read`, contrary to spec §6.5.4 where the
  // bypass applies to any nested CLAUDE.md under the project root.
  it('allows .claude/agents/CLAUDE.md read via claude-md-read despite the agents subtree overlap', () => {
    expect(
      isForbidden('.claude/agents/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'claude-md-read',
      }),
    ).toBe(false)
  })

  it('allows .claude/skills/CLAUDE.md read via claude-md-read despite the skills subtree overlap', () => {
    expect(
      isForbidden('.claude/skills/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'claude-md-read',
      }),
    ).toBe(false)
  })

  it('allows .claude/agents/CLAUDE.md read via agents-read (first matching entry bypass)', () => {
    expect(
      isForbidden('.claude/agents/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'agents-read',
      }),
    ).toBe(false)
  })

  it('blocks .claude/agents/CLAUDE.md read under project-read (neither overlap grants bypass)', () => {
    expect(
      isForbidden('.claude/agents/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  it('blocks any nested CLAUDE.md read+write; allows reads only via claude-md-read (v1.8)', () => {
    expect(
      isForbidden('claude.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
    expect(
      isForbidden('pkg/sub/claude.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
    expect(
      isForbidden('claude.local.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(true)
    // claude-md-read bypasses the read block (case-folded match for
    // CLAUDE.md / CLAUDE.local.md anywhere under the project root).
    expect(
      isForbidden('pkg/sub/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'claude-md-read',
      }),
    ).toBe(false)
    // project-read alone is **not** sufficient.
    expect(
      isForbidden('pkg/sub/claude.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(true)
  })

  it('returns false for an empty key (outside projectRoot)', () => {
    expect(
      isForbidden('', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(false)
  })

  it('returns false for a benign path under the project', () => {
    expect(
      isForbidden('readme.md', projectRoot, {
        operation: 'read',
        matchedScope: 'project-read',
      }),
    ).toBe(false)
    expect(
      isForbidden('intel/report.md', projectRoot, {
        operation: 'write',
        matchedScope: 'project-write',
      }),
    ).toBe(false)
  })

  it('ignores bypass scopes when matchedScope is null (artifact path)', () => {
    // The artifact-path-validator passes matchedScope: null; in that
    // mode no bypass applies, so the artifact preview sees the
    // strongest read-time exclusion (no recipe-style narrow scope is
    // in play). Both the full-block `.git/` entry and the narrow-scope
    // `.claude/agents/` entry collapse to a read block here.
    expect(
      isForbidden('.claude/agents/foo.md', projectRoot, {
        operation: 'read',
        matchedScope: null,
      }),
    ).toBe(true)
    expect(
      isForbidden('.git/head', projectRoot, {
        operation: 'read',
        matchedScope: null,
      }),
    ).toBe(true)
  })
})

// =========================================
// filterExcludedEntries — per-entry bypass selection
// =========================================

describe('filterExcludedEntries', () => {
  it('keeps benign entries and drops full-block entries', () => {
    const entries = [
      { path: 'readme.md' },
      { path: '.env' },
      { path: '.git/HEAD' },
      { path: 'node_modules/pkg/index.js' },
      { path: 'intel/report.md' },
    ]
    const result = filterExcludedEntries(entries, {
      operation: 'read',
      approvedScopes: ['project-read'],
      projectRoot,
    })
    expect(result.map((e) => e.path)).toEqual(['readme.md', 'intel/report.md'])
  })

  it('keeps .claude/agents entries on read when agents-read is approved', () => {
    const entries = [
      { path: '.claude/agents/agent.md' },
      { path: '.claude/hooks/post-launch.sh' },
    ]
    const result = filterExcludedEntries(entries, {
      operation: 'read',
      approvedScopes: ['agents-read'],
      projectRoot,
    })
    expect(result.map((e) => e.path)).toEqual(['.claude/agents/agent.md'])
  })

  it('drops .claude/agents entries on read when only project-read is approved (v1.8)', () => {
    const entries = [
      { path: '.claude/agents/agent.md' },
      { path: '.claude/skills/skill.md' },
      { path: 'CLAUDE.md' },
      { path: 'readme.md' },
    ]
    const result = filterExcludedEntries(entries, {
      operation: 'read',
      approvedScopes: ['project-read'],
      projectRoot,
    })
    expect(result.map((e) => e.path)).toEqual(['readme.md'])
  })

  it('keeps nested CLAUDE.md on read when claude-md-read is approved', () => {
    const entries = [
      { path: 'CLAUDE.md' },
      { path: 'pkg/CLAUDE.md' },
      { path: 'pkg/sub/CLAUDE.md' },
      { path: '.git/HEAD' },
    ]
    const result = filterExcludedEntries(entries, {
      operation: 'read',
      approvedScopes: ['claude-md-read'],
      projectRoot,
    })
    expect(result.map((e) => e.path)).toEqual([
      'CLAUDE.md',
      'pkg/CLAUDE.md',
      'pkg/sub/CLAUDE.md',
    ])
  })

  it('silently drops suspicious-char entries (security-event emission is covered indirectly)', () => {
    // The `PathRejectedSuspiciousChar` server-log event fires inside
    // the same code path; we verify the user-visible outcome here
    // (silent drop) and leave logger Proxy interception out of unit
    // scope. The event is exercised indirectly: the same rejection
    // branch in `normalizeForExclusionMatch` powers both this filter
    // and `validatePathForScope`'s suspicious-char path below.
    const entries = [
      { path: 'readme.md' },
      { path: '.git​/HEAD' },
    ]
    const result = filterExcludedEntries(entries, {
      operation: 'read',
      approvedScopes: ['project-read'],
      projectRoot,
    })
    expect(result.map((e) => e.path)).toEqual(['readme.md'])
  })
})

// =========================================
// validatePathForScope — end-to-end operation-aware behaviour
// =========================================

describe('validatePathForScope (v1.8 operation-aware)', () => {
  // Legacy patterns retained from v0.1.0.
  it('blocks .env read with PathForbidden', () => {
    const r = validatePathForScope(
      '.env',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .git/HEAD read with PathForbidden', () => {
    const r = validatePathForScope(
      '.git/HEAD',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks node_modules/pkg/index.js read with PathForbidden', () => {
    const r = validatePathForScope(
      'node_modules/pkg/index.js',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/credentials read with PathForbidden', () => {
    const r = validatePathForScope(
      '.claude/credentials',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  // v1.8 full-block additions.
  it('blocks .claude/hooks/post-launch.sh read with PathForbidden (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/hooks/post-launch.sh',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/settings.json write with PathForbidden (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/settings.json',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/settings.local.json write with PathForbidden (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/settings.local.json',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/commands/cmd.md read with PathForbidden (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/commands/cmd.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  // v1.8 write-only blocks with read bypass.
  it('allows .claude/agents/agent.md read with agents-read (v1.8)', () => {
    const r = validatePathForScope(
      'agent.md',
      ['agents-read'],
      ['agents-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
    expect(r.resolvedPath).toBe(
      fs.realpathSync(path.join(projectRoot, '.claude', 'agents', 'agent.md')),
    )
  })

  it('blocks .claude/agents/foo.md write with project-write (v1.8 temporary disabled)', () => {
    const r = validatePathForScope(
      '.claude/agents/foo.md',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('allows .claude/skills/skill.md read with skills-read (v1.8)', () => {
    const r = validatePathForScope(
      'skill.md',
      ['skills-read'],
      ['skills-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('blocks .claude/skills/foo.md write with project-write (v1.8 temporary disabled)', () => {
    const r = validatePathForScope(
      '.claude/skills/foo.md',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('allows root CLAUDE.md read with claude-md-read (v1.8)', () => {
    const r = validatePathForScope(
      'CLAUDE.md',
      ['claude-md-read'],
      ['claude-md-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('allows nested pkg/CLAUDE.md read with claude-md-read (v1.8 SSOT)', () => {
    const r = validatePathForScope(
      'pkg/CLAUDE.md',
      ['claude-md-read'],
      ['claude-md-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('allows nested pkg/sub/CLAUDE.md read with claude-md-read (v1.8 SSOT)', () => {
    const r = validatePathForScope(
      'pkg/sub/CLAUDE.md',
      ['claude-md-read'],
      ['claude-md-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('allows root CLAUDE.local.md read with claude-md-read (v1.8 SSOT)', () => {
    const r = validatePathForScope(
      'CLAUDE.local.md',
      ['claude-md-read'],
      ['claude-md-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('blocks CLAUDE.md write with project-write (v1.8 sanctioned write only)', () => {
    const r = validatePathForScope(
      'CLAUDE.md',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks nested pkg/CLAUDE.md write with project-write (v1.8)', () => {
    const r = validatePathForScope(
      'pkg/CLAUDE.md',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  // Case-fold / NTFS alias defences.
  it('blocks .GIT/HEAD read with PathForbidden (case-fold)', () => {
    const r = validatePathForScope(
      '.GIT/HEAD',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks Claude.md write with PathForbidden (case-fold)', () => {
    const r = validatePathForScope(
      'Claude.md',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks CLAUDE.md. write with PathForbidden (NTFS trailing dot alias)', () => {
    const r = validatePathForScope(
      'CLAUDE.md.',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks "CLAUDE.md " write with PathForbidden (NTFS trailing space alias)', () => {
    const r = validatePathForScope(
      'CLAUDE.md ',
      ['project-write'],
      ['project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  // Suspicious-char path: §6.6.2 step 3 fail-fast — return-value
  // surface only. Server-log event emission via the lazy `serverLogger`
  // Proxy is not unit-testable in isolation; behaviour is covered by
  // the manual smoke run during PR review (and would be visible in
  // production logs as `event: 'PathRejectedSuspiciousChar'`).
  it('returns Internal for a zero-width path (suspicious-char fail-fast)', () => {
    const r = validatePathForScope(
      '.git​/HEAD',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('Internal')
  })

  // Benign happy path — make sure the v1.8 rework did not regress the
  // simple project-read flow.
  it('allows README.md read under project-read', () => {
    const r = validatePathForScope(
      'README.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(true)
  })

  it('returns PathOutOfScope when no scope contains the target', () => {
    const r = validatePathForScope(
      path.join(os.tmpdir(), 'kb-outside-test'),
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathOutOfScope')
  })

  // v1.8: narrow-scope subtrees are read-blocked from `project-read`.
  // The dedicated `*-read` scopes are the only read paths.
  it('blocks .claude/agents/* read under project-read alone (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/agents/agent.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/skills/* read under project-read alone (v1.8)', () => {
    const r = validatePathForScope(
      '.claude/skills/skill.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks CLAUDE.md read under project-read alone (v1.8)', () => {
    const r = validatePathForScope(
      'CLAUDE.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks nested pkg/CLAUDE.md read under project-read alone (v1.8)', () => {
    const r = validatePathForScope(
      'pkg/CLAUDE.md',
      ['project-read'],
      ['project-read'],
      APP_ID,
      projectRoot,
      undefined,
      'read',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })

  it('blocks .claude/credentials write even when scope arrays list own-data first (precedence sort)', () => {
    // Regression for the v0.2.x precedence sort: an
    // `approvedScopes` / `requiredScopes` array that happens to
    // declare `own-data` ahead of `project-write` must still see
    // `project-write` evaluated first, so the exclusion table hits
    // before `own-data` re-interprets `.claude/credentials` under
    // the recipe's data root. Without the sort the validator would
    // return `{ ok: true }` here (or fail downstream as NotFound).
    const r = validatePathForScope(
      '.claude/credentials',
      ['own-data', 'project-write'],
      ['own-data', 'project-write'],
      APP_ID,
      projectRoot,
      undefined,
      'write',
    )
    expect(r.ok).toBe(false)
    expect(r.failedCode).toBe('PathForbidden')
  })
})
