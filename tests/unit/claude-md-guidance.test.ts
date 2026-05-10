/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the CLAUDE.md guidance-injection helper.
 *
 * Spec SSOT: `docs/specs/claude-md-guidance-injection.md` v1.2 (in
 * the kovitoboard-dev workspace), §5.2 / §5.3 / §5.4 / §8.1 / §8.2.
 *
 * Strategy: drive the real `DirectFsLayer` against a per-test
 * tempdir. The injection helper has no platform branches that we
 * need to mock (the only system call beyond fs is `Date.now`, and
 * we do not pin the timestamp).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DirectFsLayer } from '../../src/server/fs-layer.js'
import {
  maybeInjectClaudeMdGuidance,
  __testing__,
} from '../../src/server/services/claude-md-guidance.js'
import type { KovitoboardSetting } from '../../src/shared/setting-types.js'

let workDir: string
let claudeMdPath: string
const fs = new DirectFsLayer()

const baseSetting: KovitoboardSetting = {
  version: '1.1',
  user: { displayName: 'Test', avatar: null },
  // `project.path` is intentionally a *different* directory in the
  // tests so we can prove the helper anchors writes on the
  // server-trusted `projectRoot` argument and ignores
  // `setting.project.path` (security hardening covered in the
  // "ignores client-supplied project.path" test below).
  project: { name: 'test-project', description: '', path: '/tmp/should-not-be-used' },
  locale: 'en',
  onboarding: { completedAt: '2026-05-10T00:00:00.000Z', wizardVersion: '0.1.0' },
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-claude-md-guidance-'))
  claudeMdPath = join(workDir, 'CLAUDE.md')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function settingFor(opts: { disabled?: boolean } = {}): KovitoboardSetting {
  return {
    ...baseSetting,
    ...(opts.disabled === undefined
      ? {}
      : { claudeMdGuidance: { disabled: opts.disabled } }),
  }
}

describe('maybeInjectClaudeMdGuidance — opt-out flag', () => {
  it('skips entirely when claudeMdGuidance.disabled is true', () => {
    const result = maybeInjectClaudeMdGuidance(fs, settingFor({ disabled: true }), workDir)
    expect(result).toEqual({ injected: false, reason: 'disabled' })
    expect(fs.existsSync(claudeMdPath)).toBe(false)
  })

  it('does not skip when claudeMdGuidance is omitted', () => {
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('created')
    expect(fs.existsSync(claudeMdPath)).toBe(true)
  })

  it('does not skip when claudeMdGuidance.disabled is false', () => {
    const result = maybeInjectClaudeMdGuidance(fs, settingFor({ disabled: false }), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('created')
  })

  it('refuses to operate when projectRoot is empty', () => {
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), '')
    expect(result).toEqual({ injected: false, reason: 'no-project-path' })
  })

  it('ignores client-supplied project.path and writes under projectRoot', () => {
    // `baseSetting.project.path` points at /tmp/should-not-be-used
    // which does not exist; if the helper trusted it, this test
    // would either throw or write to that decoy path. The expected
    // behavior is that the helper writes under `workDir` (the
    // server-trusted projectRoot we pass) and leaves the decoy path
    // untouched.
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(fs.existsSync(claudeMdPath)).toBe(true)
    expect(fs.existsSync('/tmp/should-not-be-used/CLAUDE.md')).toBe(false)
  })
})

describe('maybeInjectClaudeMdGuidance — file missing (spec §5.4)', () => {
  it('creates a new CLAUDE.md containing only the marker block', () => {
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('created')
    expect(typeof result.injectedAt).toBe('string')

    const content = readFileSync(claudeMdPath, 'utf-8')
    // The brand-new file is exactly the canonical block plus a
    // trailing newline (POSIX text-file convention).
    expect(content).toBe(__testing__.GUIDANCE_LINES.join('\n') + '\n')
    expect(content).toContain('<!-- KB:GUIDANCE_START -->')
    expect(content).toContain('<!-- KB:GUIDANCE_END -->')
    expect(content).toContain('kovitoboard/docs/agent-ref/INDEX.md')
  })
})

describe('maybeInjectClaudeMdGuidance — append (spec §5.3)', () => {
  it('appends to a pre-existing CLAUDE.md without markers, preserving content', () => {
    const original = '# My project\n\nSome notes.\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('appended')

    const content = readFileSync(claudeMdPath, 'utf-8')
    // Original content preserved verbatim at the head; one blank line
    // separates it from the marker block; trailing newline at EOF.
    expect(content.startsWith('# My project\n\nSome notes.\n\n<!-- KB:GUIDANCE_START -->')).toBe(true)
    expect(content.endsWith('<!-- KB:GUIDANCE_END -->\n')).toBe(true)
  })

  it('preserves CRLF line endings when appending', () => {
    const original = '# My project\r\n\r\nSome notes.\r\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)

    const content = readFileSync(claudeMdPath, 'utf-8')
    // The detector picks CRLF iff the file contains at least one
    // CRLF pair, so the appended block must use CRLF too.
    expect(content.startsWith('# My project\r\n\r\nSome notes.\r\n\r\n<!-- KB:GUIDANCE_START -->')).toBe(true)
    // Verify the marker block lines themselves are CRLF-joined.
    expect(content).toContain('<!-- KB:GUIDANCE_START -->\r\n')
    expect(content).toContain('\r\n<!-- KB:GUIDANCE_END -->\r\n')
    // No bare LF without a preceding CR should appear in the marker
    // block region (the original was already CRLF).
    expect(/[^\r]\n/.test(content)).toBe(false)
  })

  it('handles a CLAUDE.md without a trailing newline', () => {
    const original = 'no trailing newline'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)

    const content = readFileSync(claudeMdPath, 'utf-8')
    expect(content.startsWith('no trailing newline\n\n<!-- KB:GUIDANCE_START -->')).toBe(true)
  })

  it('handles a CLAUDE.md ending with multiple blank lines', () => {
    const original = 'body\n\n\n\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)

    const content = readFileSync(claudeMdPath, 'utf-8')
    // Trailing blanks are collapsed before adding the standard
    // single-blank separator before the marker block.
    expect(content).toBe('body\n\n<!-- KB:GUIDANCE_START -->\n' +
      __testing__.GUIDANCE_LINES.slice(1, -1).join('\n') +
      '\n<!-- KB:GUIDANCE_END -->\n')
  })
})

describe('maybeInjectClaudeMdGuidance — already injected (spec §5.5)', () => {
  it('is a no-op when the file already contains a well-formed marker pair', () => {
    const original =
      'header\n\n<!-- KB:GUIDANCE_START -->\nold body\n<!-- KB:GUIDANCE_END -->\n'
    writeFileSync(claudeMdPath, original)
    const mtimeBefore = statSync(claudeMdPath).mtimeMs

    // Sleep a hair so a touch would be observable. Avoid actual
    // sleep — re-stat after the call is enough because we assert
    // the file content is byte-equal.
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'already-injected' })
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(original)
    // mtime check is best-effort; some filesystems coalesce mtime
    // updates within a tick, but at minimum we assert the bytes
    // are identical.
    expect(statSync(claudeMdPath).mtimeMs).toBe(mtimeBefore)
  })

  it('does not re-inject even when the marker body diverges from canonical', () => {
    const original =
      '<!-- KB:GUIDANCE_START -->\ntotally different body\n<!-- KB:GUIDANCE_END -->\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.reason).toBe('already-injected')
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(original)
  })

  it('tolerates whitespace inside the marker comments', () => {
    // Spec §8.1 regex allows arbitrary whitespace inside the
    // `<!-- ... -->` syntax — this matches what a hand-edit might
    // produce.
    const original =
      '<!--   KB:GUIDANCE_START   -->\nbody\n<!--KB:GUIDANCE_END-->\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.reason).toBe('already-injected')
  })
})

describe('maybeInjectClaudeMdGuidance — symlink / non-regular target rejection', () => {
  // Spec hardening (CodeX review on PR #19, finding "symlink
  // traversal"): the existing-file branch must use `lstat` (not
  // `stat`) so that a symlink at <projectRoot>/CLAUDE.md cannot
  // redirect the upstream `existsSync` / `readFileSync` chain to
  // another path. Following the link would either read content from
  // outside the project root (info disclosure) or block the
  // synchronous request on a FIFO / device file. We refuse symlinks
  // outright (`reason: 'special-file'`); the operator can repair the
  // file manually if desired.

  it('refuses to read or write when CLAUDE.md is a symlink (even when its target exists)', () => {
    // Plant the symlink target outside the project root so a
    // regression that follows the link would actually read from a
    // different file.
    const otherFile = join(workDir, '..', 'kb-claude-md-symlink-target.md')
    writeFileSync(otherFile, 'unrelated content that must not be read')
    try {
      symlinkSync(otherFile, claudeMdPath)
      const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
      expect(result).toEqual({ injected: false, reason: 'special-file' })
      // The symlink target file must remain untouched (proof that no
      // read or write followed the link).
      expect(readFileSync(otherFile, 'utf-8')).toBe(
        'unrelated content that must not be read',
      )
    } finally {
      rmSync(otherFile, { force: true })
    }
  })

  it('refuses to read or write when CLAUDE.md is a dangling symlink', () => {
    // Dangling symlink: lstat sees the link itself, isFile is false,
    // isSymbolicLink is true. Without the lstat gate, the upstream
    // `existsSync` would return false (existsSync follows the link)
    // and the helper would fall into the new-file branch, which would
    // then `writeFileAtomic` and replace the symlink. We refuse early.
    const danglingTarget = join(workDir, 'does-not-exist.md')
    symlinkSync(danglingTarget, claudeMdPath)
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'special-file' })
    // Symlink itself must still exist (we did not unlink it).
    // Use lstat-aware probing: we cannot rely on existsSync because
    // it follows the link.
    expect(fs.lstatSync(claudeMdPath).isSymbolicLink).toBe(true)
  })
})

describe('maybeInjectClaudeMdGuidance — empty existing CLAUDE.md', () => {
  // Spec hardening (CodeX review on PR #19, low-severity finding
  // "empty-file append handling"): when the existing file is
  // whitespace-only or zero-byte, the no-marker append branch
  // previously prefixed the block with two blank lines (`'' + EOL +
  // EOL + block + EOL`). That is inconsistent with the fresh-create
  // branch (spec §5.4 minimal-content goal). The fix special-cases
  // `trimmed === ''` and emits just the block + trailing EOL.

  it('emits just the block + EOL when the existing file is zero-byte', () => {
    writeFileSync(claudeMdPath, '')
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('appended')
    const content = readFileSync(claudeMdPath, 'utf-8')
    // No leading blank lines: matches the fresh-create branch byte-for-byte.
    expect(content.startsWith('<!-- KB:GUIDANCE_START -->')).toBe(true)
    expect(content.endsWith('\n')).toBe(true)
  })

  it('emits just the block + EOL when the existing file is whitespace-only (multiple newlines)', () => {
    writeFileSync(claudeMdPath, '\n\n\n')
    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    const content = readFileSync(claudeMdPath, 'utf-8')
    expect(content.startsWith('<!-- KB:GUIDANCE_START -->')).toBe(true)
    expect(content.endsWith('\n')).toBe(true)
  })
})

describe('maybeInjectClaudeMdGuidance — defensive size cap', () => {
  // Spec hardening (CodeX review on PR #19, finding "unbounded file
  // read"): the existing CLAUDE.md lives under the user-controlled
  // project root. Reading and regex-scanning an unusually large file
  // synchronously would block the event loop on the onboarding
  // request. We cap at 1 MB and skip injection above the cap; the
  // caller (`config-routes.ts`) treats this as a best-effort skip
  // (`reason: 'file-too-large'`) and continues with the rest of the
  // settings PUT. The spec follow-up tracks the formal §5 entry; for
  // now this test pins the helper-level contract.

  it('skips with reason file-too-large when the existing CLAUDE.md exceeds 1 MB', () => {
    // Build a string just over the 1 MB cap. The marker-scan branch
    // would otherwise compile two global regex matches over this
    // entire body on every onboarding completion.
    const body = 'a'.repeat(1024 * 1024 + 1)
    writeFileSync(claudeMdPath, body)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'file-too-large' })
    // The file must remain byte-identical — defensive skip, not a
    // rewrite.
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(body)
  })

  it('still injects when the existing CLAUDE.md is exactly at the 1 MB cap', () => {
    // The cap is "above 1 MB skipped" — exactly 1 MB still goes
    // through (the comparison is `> MAX`, not `>=`). We use a body
    // that is exactly 1 MB and would still parse cleanly through the
    // marker scanner (the scanner ignores the body content; it just
    // wants START / END markers, of which we have none here).
    const body = 'a'.repeat(1024 * 1024)
    writeFileSync(claudeMdPath, body)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result.injected).toBe(true)
    expect(result.reason).toBe('appended')
  })
})

describe('maybeInjectClaudeMdGuidance — broken markers (spec §8.2)', () => {
  it('refuses to repair a file with only the start marker', () => {
    const original = 'body\n<!-- KB:GUIDANCE_START -->\nstuff\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'broken-markers' })
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(original)
  })

  it('refuses to repair a file with only the end marker', () => {
    const original = 'body\nstuff\n<!-- KB:GUIDANCE_END -->\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'broken-markers' })
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(original)
  })

  it('refuses to operate when multiple START / END pairs exist', () => {
    const original =
      '<!-- KB:GUIDANCE_START -->\na\n<!-- KB:GUIDANCE_END -->\n' +
      '<!-- KB:GUIDANCE_START -->\nb\n<!-- KB:GUIDANCE_END -->\n'
    writeFileSync(claudeMdPath, original)

    const result = maybeInjectClaudeMdGuidance(fs, settingFor(), workDir)
    expect(result).toEqual({ injected: false, reason: 'broken-markers' })
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(original)
  })
})

describe('marker regex (spec §8.1)', () => {
  it('matches the canonical pair', () => {
    expect(
      __testing__.PAIR_REGEX.test(
        '<!-- KB:GUIDANCE_START -->\nbody\n<!-- KB:GUIDANCE_END -->',
      ),
    ).toBe(true)
  })

  it('matches with arbitrary whitespace inside the comment delimiters', () => {
    expect(
      __testing__.PAIR_REGEX.test(
        '<!--   KB:GUIDANCE_START   -->\nbody\n<!--KB:GUIDANCE_END-->',
      ),
    ).toBe(true)
  })

  it('does not match an unrelated marker', () => {
    expect(
      __testing__.PAIR_REGEX.test('<!-- something:else -->\n<!-- /something -->'),
    ).toBe(false)
  })
})

describe('detectEol', () => {
  it('returns CRLF when the file contains \\r\\n', () => {
    expect(__testing__.detectEol('a\r\nb')).toBe('\r\n')
  })

  it('returns LF when the file is LF-only', () => {
    expect(__testing__.detectEol('a\nb')).toBe('\n')
  })

  it('returns LF for an empty string', () => {
    expect(__testing__.detectEol('')).toBe('\n')
  })
})
