/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  countMatchesInText,
  INTERNAL_ID_DEFAULT_MODE,
  INTERNAL_ID_MODES,
  INTERNAL_ID_PATTERNS,
  INTERNAL_ID_TEMPLATE_AGENT_SKIPPED_PATTERN_IDS,
  isInternalIdTemplateAgentFile,
  parseArgs,
  PII_EXPECTED_LITERALS,
  PII_PATTERNS,
  runPiiCheckForFiles,
  scanFile,
  scanFileForPatterns,
  severityForPattern,
  shouldScanFileForInternalId,
} from '../../tools/check-release-hygiene.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'hygiene-internal-id')

function getPattern(id: string) {
  const p = INTERNAL_ID_PATTERNS.find((x: { id: string }) => x.id === id)
  if (!p) throw new Error(`pattern ${id} not found`)
  return p as { id: string; label: string; regex: RegExp; errorInPhases: Set<string> }
}

// ---------------------------------------------------------------------------
// T-1: Each P-1〜P-7 regex matches the expected example strings.
// ---------------------------------------------------------------------------

describe('T-1: pattern regexes match expected strings', () => {
  it('P-1 matches DEC-018 / DEC-024 but not bare "DEC"', () => {
    const re = getPattern('P-1').regex
    expect(re.test('see DEC-018 for details')).toBe(true)
    expect(re.test('DEC-024 v2.0 install handover')).toBe(true)
    expect(re.test('the DEC keyword alone')).toBe(false)
  })

  it('P-1 is bounded by `\\b` so concatenated identifiers do not match', () => {
    // Word-boundary anchor prevents substring matches inside longer tokens.
    const re = getPattern('P-1').regex
    expect(re.test('xDEC-018')).toBe(false)
    expect(re.test('DEC-018foo')).toBe(false)
    // Adjacent punctuation still matches because the punctuation itself is
    // a word boundary.
    expect(re.test('see DEC-018-test-quality.md')).toBe(true)
    expect(re.test('(DEC-018) note')).toBe(true)
  })

  it('P-2 matches BL-2026-083 but not BL-99 (4-digit year required)', () => {
    const re = getPattern('P-2').regex
    expect(re.test('tracked under BL-2026-083')).toBe(true)
    expect(re.test('BL-99 is not the right shape')).toBe(false)
  })

  it('P-2 is bounded by `\\b` so concatenated identifiers do not match', () => {
    const re = getPattern('P-2').regex
    expect(re.test('xBL-2026-083')).toBe(false)
    expect(re.test('BL-2026-083foo')).toBe(false)
    expect(re.test('see (BL-2026-083) reference')).toBe(true)
  })

  it('P-3 matches (agent: developer) and (agent: kb-architect)', () => {
    const re = getPattern('P-3').regex
    expect(re.test('signed off (agent: developer)')).toBe(true)
    expect(re.test('handed off (agent: kb-architect)')).toBe(true)
    expect(re.test('agent without parens')).toBe(false)
  })

  it('P-4 matches kb-architect / kb-pdm only (not kb-other)', () => {
    const re = getPattern('P-4').regex
    expect(re.test('the kb-architect notes')).toBe(true)
    expect(re.test('kb-pdm escalated')).toBe(true)
    expect(re.test('kb-developer is not a real agent')).toBe(false)
  })

  it('P-5 matches standalone agent names (architect, biz-dev, secretary, etc.)', () => {
    const re = getPattern('P-5').regex
    expect(re.test('the architect reviewed it')).toBe(true)
    expect(re.test('biz-dev signed off')).toBe(true)
    expect(re.test('handed to secretary')).toBe(true)
    expect(re.test('developer is captured by P-6 not P-5')).toBe(false)
  })

  it('P-6 matches developer / tester / pdm', () => {
    const re = getPattern('P-6').regex
    expect(re.test('the developer wrote tests')).toBe(true)
    expect(re.test('handed to tester')).toBe(true)
    expect(re.test('pdm scoped this')).toBe(true)
  })

  it('P-6 also matches inside hyphenated names like kovito-developer', () => {
    // Word boundary semantics: `-` is a non-word character, so \bdeveloper\b
    // matches inside `kovito-developer`. This is acknowledged in design notes
    // §2.2 and the pattern is permanently warn-level for this reason.
    const re = getPattern('P-6').regex
    expect(re.test('defaultAgentId = "kovito-developer"')).toBe(true)
  })

  it('P-7 matches Q4 / SS-3 / AA-7 with the narrowed prefix list', () => {
    const re = getPattern('P-7').regex
    expect(re.test('see Q4 for the rationale')).toBe(true)
    expect(re.test('SS-3 covers this')).toBe(true)
    expect(re.test('AA-7 in the supplementary review')).toBe(true)
  })

  it('P-7 does NOT match HTTP-2 / RFC-1234 / IETF-1234 (false-positive guard)', () => {
    const re = getPattern('P-7').regex
    expect(re.test('over HTTP-2 only')).toBe(false)
    expect(re.test('RFC-1234 says')).toBe(false)
    expect(re.test('IETF-1234 ratified')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T-2: Placeholder forms (DEC-xxx, BL-xxxx) used in examples are NOT matched.
// ---------------------------------------------------------------------------

describe('T-2: placeholder DEC-xxx / BL-xxxx are auto-allowed', () => {
  it('P-1 (DEC-[0-9]+) does not match DEC-xxx', () => {
    const re = getPattern('P-1').regex
    expect(re.test('use DEC-xxx as a placeholder')).toBe(false)
  })

  it('P-2 (BL-[0-9]{4}-[0-9]+) does not match BL-xxxx', () => {
    const re = getPattern('P-2').regex
    expect(re.test('placeholder BL-xxxx')).toBe(false)
  })

  it('false-positive fixture file matches none of the broad-but-narrowed patterns', () => {
    const fixturePath = join(FIXTURE_DIR, 'false-positive.ts')
    // Patterns that should NEVER fire on this fixture:
    for (const id of ['P-1', 'P-2', 'P-7']) {
      const hits = scanFile(fixturePath, getPattern(id).regex)
      expect(
        hits,
        `${id} should not match in false-positive fixture`,
      ).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// T-3: tools/check-release-hygiene.mjs itself is excluded from scan targets.
// ---------------------------------------------------------------------------

describe('T-3: hygiene script self-exclusion', () => {
  it('shouldScanFileForInternalId returns false for tools/check-release-hygiene.mjs', () => {
    expect(shouldScanFileForInternalId('tools/check-release-hygiene.mjs')).toBe(false)
  })

  it('also excludes the matching unit-test file (it embeds intentional samples)', () => {
    expect(
      shouldScanFileForInternalId('tests/unit/check-release-hygiene.test.ts'),
    ).toBe(false)
  })

  it('still includes other tool files', () => {
    expect(shouldScanFileForInternalId('tools/kb-start.mjs')).toBe(true)
    expect(shouldScanFileForInternalId('tools/kb-diagnose.mjs')).toBe(true)
  })

  it('still includes other unit-test files', () => {
    expect(shouldScanFileForInternalId('tests/unit/log-config.test.ts')).toBe(true)
  })

  it('scans documentation and config files at the repository root by extension', () => {
    // Pattern-based root scanning: any documentation or config format at the
    // root is in scope, including new files not in any hard-coded list.
    expect(shouldScanFileForInternalId('README.md')).toBe(true)
    expect(shouldScanFileForInternalId('CHANGELOG.ja.md')).toBe(true)
    expect(shouldScanFileForInternalId('RELEASE-NOTES.md')).toBe(true) // hypothetical new file
    expect(shouldScanFileForInternalId('package.json')).toBe(true)
    expect(shouldScanFileForInternalId('tsconfig.web.json')).toBe(true)
    expect(shouldScanFileForInternalId('lefthook.yml')).toBe(true)
    expect(shouldScanFileForInternalId('vitest.config.ts')).toBe(true)
    expect(shouldScanFileForInternalId('playwright.config.l1.ts')).toBe(true)
    // `.mjs` / `.js` are commonly used for tooling configs at the root.
    expect(shouldScanFileForInternalId('eslint.config.mjs')).toBe(true)
    expect(shouldScanFileForInternalId('build.js')).toBe(true)
  })

  it('excludes generated and external root files explicitly', () => {
    // package-lock.json is generated; LICENSE is external license text.
    expect(shouldScanFileForInternalId('package-lock.json')).toBe(false)
    expect(shouldScanFileForInternalId('LICENSE')).toBe(false) // no scanned extension
    expect(shouldScanFileForInternalId('.gitignore')).toBe(false)
    expect(shouldScanFileForInternalId('.gitattributes')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T-4: tests/fixtures/projects/ and tests/fixtures/hygiene-internal-id/
//      are excluded from scan targets.
// ---------------------------------------------------------------------------

describe('T-4: fixture trees are excluded', () => {
  it('excludes tests/fixtures/projects/ subtree', () => {
    expect(shouldScanFileForInternalId('tests/fixtures/projects/blank/somefile.ts')).toBe(false)
    expect(shouldScanFileForInternalId('tests/fixtures/projects/blank/.kovitoboard/agents/x.md')).toBe(false)
  })

  it('excludes the hygiene-internal-id fixture subtree', () => {
    expect(shouldScanFileForInternalId('tests/fixtures/hygiene-internal-id/dirty.ts')).toBe(false)
    expect(shouldScanFileForInternalId('tests/fixtures/hygiene-internal-id/agent-tag.md')).toBe(false)
  })

  it('still includes other tests/ files', () => {
    expect(shouldScanFileForInternalId('tests/unit/some.test.ts')).toBe(true)
    expect(shouldScanFileForInternalId('tests/e2e/helpers/foo.ts')).toBe(true)
  })

  it('only the false-positive-prone agent-name patterns are skipped in agent templates', () => {
    // Skipping more (e.g. P-1 / P-2 / P-3 / P-7) would create a coverage gap
    // — agent template files must still be checked for DEC IDs, BL IDs,
    // agent: tags, KB-prefixed names, and question IDs.
    expect(INTERNAL_ID_TEMPLATE_AGENT_SKIPPED_PATTERN_IDS).toEqual(new Set(['P-5', 'P-6']))
    // Sanity check: the skipped IDs are real entries in the pattern list.
    const patternIds = new Set(INTERNAL_ID_PATTERNS.map((p: { id: string }) => p.id))
    for (const skipped of INTERNAL_ID_TEMPLATE_AGENT_SKIPPED_PATTERN_IDS) {
      expect(patternIds.has(skipped as string)).toBe(true)
    }
  })

  it('isInternalIdTemplateAgentFile matches .md and .en.md at the templates/agents/ flat path', () => {
    expect(isInternalIdTemplateAgentFile('templates/agents/kovito-developer.md')).toBe(true)
    // The English-locale variant ends in `.md` too, so it is also treated as
    // an agent template — agent IDs may legitimately appear in both files.
    expect(isInternalIdTemplateAgentFile('templates/agents/kovito-developer.en.md')).toBe(true)
    expect(isInternalIdTemplateAgentFile('templates/agents/sub/x.md')).toBe(false)
    expect(isInternalIdTemplateAgentFile('templates/other.md')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T-5 / T-6 / T-7: severity table per phase mode.
// ---------------------------------------------------------------------------

describe('T-5: warn-only mode emits warn for every pattern', () => {
  it.each(INTERNAL_ID_PATTERNS.map((p: { id: string }) => p.id))(
    '%s -> warn',
    (id: string) => {
      expect(severityForPattern(getPattern(id), 'warn-only')).toBe('warn')
    },
  )
})

describe('T-6: partial-error mode promotes P-1/P-2/P-3/P-4/P-7 to error', () => {
  const errorIds = ['P-1', 'P-2', 'P-3', 'P-4', 'P-7']
  const warnIds = ['P-5', 'P-6']

  it.each(errorIds)('%s -> error', (id) => {
    expect(severityForPattern(getPattern(id), 'partial-error')).toBe('error')
  })

  it.each(warnIds)('%s -> warn (false-positive prone)', (id) => {
    expect(severityForPattern(getPattern(id), 'partial-error')).toBe('warn')
  })
})

describe('T-7: full-error mode keeps P-5/P-6 as warn (per design notes §2.2)', () => {
  // Phase C "全パターン error" with the explicit carve-out for the
  // false-positive-prone agent-name patterns. Design notes §2.2 column lists
  // P-5 and P-6 as warn even in Phase C (with permanence open for review).
  const errorIds = ['P-1', 'P-2', 'P-3', 'P-4', 'P-7']
  const warnIds = ['P-5', 'P-6']

  it.each(errorIds)('%s -> error', (id) => {
    expect(severityForPattern(getPattern(id), 'full-error')).toBe('error')
  })

  it.each(warnIds)('%s -> warn', (id) => {
    expect(severityForPattern(getPattern(id), 'full-error')).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// T-8: --internal-id-only flag skips other sections; mode parsing works.
// ---------------------------------------------------------------------------

describe('T-8: parseArgs / --internal-id-only / --internal-id-mode', () => {
  it('default invocation runs all sections in warn-only mode', () => {
    const opts = parseArgs(['node', 'check-release-hygiene.mjs'])
    expect(opts.runAll).toBe(true)
    expect(opts.internalIdOnly).toBe(false)
    expect(opts.internalIdMode).toBe(INTERNAL_ID_DEFAULT_MODE)
    expect(opts.strict).toBe(false)
  })

  it('--internal-id-only restricts to the new section', () => {
    const opts = parseArgs(['node', 'check-release-hygiene.mjs', '--internal-id-only'])
    expect(opts.runAll).toBe(false)
    expect(opts.internalIdOnly).toBe(true)
    expect(opts.piiOnly).toBe(false)
    expect(opts.japaneseOnly).toBe(false)
    expect(opts.metaOnly).toBe(false)
  })

  it('--internal-id-mode parses partial-error and full-error', () => {
    const partial = parseArgs([
      'node',
      'check-release-hygiene.mjs',
      '--internal-id-mode=partial-error',
    ])
    expect(partial.internalIdMode).toBe('partial-error')

    const full = parseArgs([
      'node',
      'check-release-hygiene.mjs',
      '--internal-id-mode=full-error',
    ])
    expect(full.internalIdMode).toBe('full-error')
  })

  it('--internal-id-mode rejects unknown values', () => {
    expect(() =>
      parseArgs(['node', 'check-release-hygiene.mjs', '--internal-id-mode=bogus']),
    ).toThrowError(/Invalid --internal-id-mode/)
  })

  it('--strict and --internal-id-mode are independent flags', () => {
    const opts = parseArgs([
      'node',
      'check-release-hygiene.mjs',
      '--strict',
      '--internal-id-only',
      '--internal-id-mode=warn-only',
    ])
    expect(opts.strict).toBe(true)
    expect(opts.internalIdMode).toBe('warn-only')
    expect(opts.internalIdOnly).toBe(true)
  })

  it('exposes the canonical mode list for callers', () => {
    expect(INTERNAL_ID_MODES).toEqual(['warn-only', 'partial-error', 'full-error'])
  })
})

// ---------------------------------------------------------------------------
// countMatchesInText: per-line occurrence counter (CodeX feedback fix)
// ---------------------------------------------------------------------------

describe('countMatchesInText: counts every occurrence on a single line', () => {
  it('returns 1 for a single match', () => {
    expect(countMatchesInText('see DEC-018 for details', /DEC-[0-9]+/)).toBe(1)
  })

  it('returns N for N matches on the same line', () => {
    // Multiple P-7 matches on a single line.
    const re = getPattern('P-7').regex
    expect(countMatchesInText('see SS-3 / Q4 / AA-7 in supplementary review', re)).toBe(3)
  })

  it('returns 0 when the regex does not match', () => {
    expect(countMatchesInText('clean text without any IDs', /DEC-[0-9]+/)).toBe(0)
  })

  it('handles regex flags by injecting a global flag copy', () => {
    // Original regex without /g; helper must not mutate it.
    const re = /DEC-[0-9]+/
    expect(countMatchesInText('DEC-001 DEC-002 DEC-003', re)).toBe(3)
    expect(re.flags.includes('g')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// scanFileForPatterns: single-read multi-pattern scan (CodeX feedback fix)
// ---------------------------------------------------------------------------

describe('scanFileForPatterns: reads file once and scans every pattern', () => {
  it('returns hits for matching patterns and empty arrays for the rest', () => {
    const out = scanFileForPatterns(join(FIXTURE_DIR, 'dirty.ts'), INTERNAL_ID_PATTERNS)
    expect(out.skipped).toBe(false)
    if (out.skipped) return
    const byId = new Map(out.results.map((r: { pattern: { id: string }; hits: unknown[] }) => [r.pattern.id, r.hits]))
    expect((byId.get('P-1') as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((byId.get('P-2') as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((byId.get('P-7') as unknown[]).length).toBeGreaterThanOrEqual(1)
    // No agent: tag in dirty.ts → P-3 must be empty.
    expect(byId.get('P-3') as unknown[]).toEqual([])
  })

  it('returns size-cap envelope when the file exceeds the cap', () => {
    const out = scanFileForPatterns(
      join(FIXTURE_DIR, 'dirty.ts'),
      INTERNAL_ID_PATTERNS,
      { sizeCap: 1 }, // 1 byte — guaranteed to trip
    )
    expect(out.skipped).toBe(true)
    if (!out.skipped) return
    expect(out.reason).toBe('size-cap')
    expect(out.results).toEqual([])
    expect(out.size).toBeGreaterThan(1)
  })

  it('returns read-error envelope for missing files', () => {
    const out = scanFileForPatterns(
      join(FIXTURE_DIR, 'does-not-exist.ts'),
      INTERNAL_ID_PATTERNS,
    )
    expect(out.skipped).toBe(true)
    if (!out.skipped) return
    expect(out.reason).toBe('read-error')
  })

  it('returns special-file envelope for symlinks (does not follow them)', () => {
    // Build a tracked-style symlink in a tmpdir and confirm the scanner
    // refuses it via lstat — a symlink to /dev/zero or outside the repo
    // would otherwise let `readFileSync` hang or read out-of-scope content.
    const dir = mkdtempSync(join(tmpdir(), 'kb-hygiene-symlink-'))
    const linkPath = join(dir, 'link.ts')
    try {
      // Symlink targeting a non-existent path is sufficient — `lstat`
      // succeeds on the symlink itself and reports it as not-a-file.
      symlinkSync('/tmp/does-not-exist-target', linkPath)
      const out = scanFileForPatterns(linkPath, INTERNAL_ID_PATTERNS)
      expect(out.skipped).toBe(true)
      if (!out.skipped) return
      expect(out.reason).toBe('special-file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clean.ts produces zero hits across all patterns', () => {
    const out = scanFileForPatterns(join(FIXTURE_DIR, 'clean.ts'), INTERNAL_ID_PATTERNS)
    expect(out.skipped).toBe(false)
    if (out.skipped) return
    for (const r of out.results) {
      expect(r.hits, `${r.pattern.id} matched clean.ts unexpectedly`).toEqual([])
    }
  })

  it('does not leak lastIndex across lines when given a global regex', () => {
    // Defensive: a stateful (/g) regex would advance `lastIndex` per `.test()`
    // call. The fixture is laid out specifically to trip that bug:
    //   line 1: "prefix MATCH end"          (MATCH at column 7, lastIndex -> 12)
    //   line 2: "MATCH at column zero ..."  (MATCH at column 0)
    // Without the defensive copy, the second `.test()` would search from
    // lastIndex 12, find no match in line 2's tail, return false, and the
    // line-2 MATCH would be silently dropped.
    const globalPattern = { id: 'TEST', label: 'global probe', regex: /MATCH/g }
    const probeFile = join(FIXTURE_DIR, 'multi-match.txt')

    const out = scanFileForPatterns(probeFile, [globalPattern])
    expect(out.skipped).toBe(false)
    if (out.skipped) return
    // Lines 1, 2, and 4 contain MATCH; line 3 does not. With the defensive
    // copy the helper finds all three. Without it, line 2 would be missed.
    expect(out.results[0].hits.map((h: { line: number }) => h.line)).toEqual([1, 2, 4])

    // Re-scan with the same regex object — must still produce the same hits.
    const out2 = scanFileForPatterns(probeFile, [globalPattern])
    expect(out2.skipped).toBe(false)
    if (out2.skipped) return
    expect(out2.results[0].hits).toEqual(out.results[0].hits)

    // The original regex's lastIndex must remain at 0 — we work on a copy.
    expect(globalPattern.regex.lastIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Auxiliary: scanFile against the fixture files exercises the real pipeline.
// ---------------------------------------------------------------------------

describe('auxiliary: scanFile on dirty fixture finds the expected patterns', () => {
  it('detects P-1 in dirty.ts', () => {
    const hits = scanFile(join(FIXTURE_DIR, 'dirty.ts'), getPattern('P-1').regex)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h: { text: string }) => h.text.includes('DEC-018'))).toBe(true)
  })

  it('detects P-2 in dirty.ts', () => {
    const hits = scanFile(join(FIXTURE_DIR, 'dirty.ts'), getPattern('P-2').regex)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h: { text: string }) => h.text.includes('BL-2026-099'))).toBe(true)
  })

  it('detects P-3 in agent-tag.md', () => {
    const hits = scanFile(join(FIXTURE_DIR, 'agent-tag.md'), getPattern('P-3').regex)
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('clean.ts produces no hits', () => {
    for (const pat of INTERNAL_ID_PATTERNS) {
      const hits = scanFile(join(FIXTURE_DIR, 'clean.ts'), pat.regex)
      expect(hits, `${pat.id} matched clean.ts unexpectedly`).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// PII allowlist (PII_EXPECTED_LITERALS): narrowly scoped exemption for
// governance files. Each entry pairs a `literal` with a `lineMustMatch`
// anchor; only lines matching the anchor have the literal scrubbed before
// the PII pattern is re-tested. Any unrelated occurrence of the same
// literal — and any extra PII on the same line — must still be detected
// (no whole-file blind spot).
//
// Fixture strings below are reconstructed at runtime from neutral
// fragments so that this test file's own source does not contain
// continuous occurrences of the published maintainer handle / email or
// the home-directory pattern. The hygiene checker scans this file as
// plain text and would otherwise be flagged here by the very patterns we
// are exercising.
// ---------------------------------------------------------------------------

type AllowlistEntry = { literal: RegExp; lineMustMatch: RegExp }

function stripExpectedLiteralsIfLineMatches(
  line: string,
  entries: AllowlistEntry[],
): string {
  let out = line
  for (const entry of entries) {
    if (entry.lineMustMatch.test(line)) {
      out = out.replace(entry.literal, '')
    }
  }
  return out
}

// Fragments are never written as a continuous PII string in this file's
// source. At runtime the templates evaluate to the real maintainer
// literals, but the hygiene checker only ever sees the fragmented form.
const HANDLE_USER = 'kousuke'
const HANDLE_FAM = 'iri' + 'kura'
const HANDLE = `@${HANDLE_USER}-${HANDLE_FAM}`
const EMAIL_LOCAL = 'REDACTED'
const EMAIL_HOST = '@' + 'gmail' + '.com'
const EMAIL = `${EMAIL_LOCAL}${EMAIL_HOST}`
const ADVERSARY_EMAIL = `${'bad'}${EMAIL_HOST}`
const HOME_PATH = `/${'home'}/${HANDLE_FAM}/scratch/notes.md`
const GMAIL_PATTERN_LABEL = EMAIL_HOST
const HOME_PATH_PATTERN_LABEL = `/${'home'}/${HANDLE_FAM}`

describe('PII allowlist: PII_EXPECTED_LITERALS only strips the literal in the expected line context', () => {
  it('CODEOWNERS rule line "* <handle>" survives no PII match after the strip', () => {
    const entries = PII_EXPECTED_LITERALS.get('CODEOWNERS')
    expect(entries).toBeDefined()
    const stripped = stripExpectedLiteralsIfLineMatches(`* ${HANDLE}`, entries!)
    for (const { label, regex } of PII_PATTERNS) {
      expect(
        regex.test(stripped),
        `expected no PII match for label "${label}" after strip, got line="${stripped}"`,
      ).toBe(false)
    }
  })

  it('CODEOWNERS preamble comment line is also stripped (multi-context anchor)', () => {
    const entries = PII_EXPECTED_LITERALS.get('CODEOWNERS')!
    const stripped = stripExpectedLiteralsIfLineMatches(
      `# Global ownership — ${HANDLE} is the maintainer for all areas.`,
      entries,
    )
    for (const { regex } of PII_PATTERNS) {
      expect(regex.test(stripped)).toBe(false)
    }
  })

  it('SECURITY.md bold-email line is stripped cleanly', () => {
    const entries = PII_EXPECTED_LITERALS.get('SECURITY.md')
    expect(entries).toBeDefined()
    const stripped = stripExpectedLiteralsIfLineMatches(`**${EMAIL}**`, entries!)
    for (const { regex } of PII_PATTERNS) {
      expect(regex.test(stripped)).toBe(false)
    }
  })

  it('CODE_OF_CONDUCT.md Enforcement paragraph is stripped cleanly', () => {
    const entries = PII_EXPECTED_LITERALS.get('CODE_OF_CONDUCT.md')
    expect(entries).toBeDefined()
    const stripped = stripExpectedLiteralsIfLineMatches(
      `Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to the community leaders responsible for enforcement at ${EMAIL}. All complaints will be reviewed and investigated promptly and fairly.`,
      entries!,
    )
    for (const { regex } of PII_PATTERNS) {
      expect(regex.test(stripped)).toBe(false)
    }
  })

  it('an extra unexpected email on the same line as the expected literal still triggers PII detection', () => {
    const entries = PII_EXPECTED_LITERALS.get('SECURITY.md')!
    // Adversarial: someone edits SECURITY.md and adds a foreign address on
    // the same line as the expected one. The expected literal is stripped
    // (the anchor still matches because the bold form is present), but
    // the foreign email survives and must match the Gmail PII pattern.
    const stripped = stripExpectedLiteralsIfLineMatches(
      `**${EMAIL}** see also ${ADVERSARY_EMAIL}`,
      entries,
    )
    const gmail = PII_PATTERNS.find(
      (p: { label: string }) => p.label === GMAIL_PATTERN_LABEL,
    )
    expect(gmail, 'Gmail PII pattern must exist').toBeDefined()
    expect(gmail!.regex.test(stripped)).toBe(true)
  })

  it('the expected literal in a non-anchor line is NOT stripped (no blind spot from line-context mismatch)', () => {
    const entries = PII_EXPECTED_LITERALS.get('SECURITY.md')!
    // Same literal as the expected bold-line context, but appearing in a
    // free-form sentence (e.g. a pasted log excerpt) that does not match
    // the bold anchor. The strip pass must be skipped and the line must
    // still carry the literal.
    const adversarialLine = `please ignore the address ${EMAIL} found in the log excerpt above`
    const stripped = stripExpectedLiteralsIfLineMatches(adversarialLine, entries)
    expect(stripped).toBe(adversarialLine)
    const gmail = PII_PATTERNS.find(
      (p: { label: string }) => p.label === GMAIL_PATTERN_LABEL,
    )
    expect(gmail!.regex.test(stripped)).toBe(true)
  })

  it('an unexpected absolute path on the same allowed line still triggers PII detection', () => {
    const entries = PII_EXPECTED_LITERALS.get('CODEOWNERS')!
    const stripped = stripExpectedLiteralsIfLineMatches(
      `* ${HANDLE} # cached at ${HOME_PATH}`,
      entries,
    )
    const homePath = PII_PATTERNS.find(
      (p: { label: string }) => p.label === HOME_PATH_PATTERN_LABEL,
    )
    expect(homePath, 'home-directory PII pattern must exist').toBeDefined()
    // The CODEOWNERS anchor matches `^* <handle>` exactly; the trailing
    // comment with the home path is permitted by `\s*$` not being part of
    // the anchor (the `^* <handle>\s*$` arm allows only the bare rule
    // line). The combined adversarial line therefore fails the anchor
    // and is not stripped — the home-path PII surfaces.
    expect(homePath!.regex.test(stripped)).toBe(true)
  })

  it('PII_EXPECTED_LITERALS only carves out the three governance files (no test-file entry)', () => {
    expect(PII_EXPECTED_LITERALS.has('README.md')).toBe(false)
    expect(PII_EXPECTED_LITERALS.has('src/server/index.ts')).toBe(false)
    expect(PII_EXPECTED_LITERALS.has('CONTRIBUTING.md')).toBe(false)
    expect(PII_EXPECTED_LITERALS.has('CODEOWNERS')).toBe(true)
    expect(PII_EXPECTED_LITERALS.has('CODE_OF_CONDUCT.md')).toBe(true)
    expect(PII_EXPECTED_LITERALS.has('SECURITY.md')).toBe(true)
    expect(
      PII_EXPECTED_LITERALS.has('tests/unit/check-release-hygiene.test.ts'),
    ).toBe(false)
  })

  it('every PII_EXPECTED_LITERALS entry is a list of { literal, lineMustMatch } pairs', () => {
    for (const [file, entries] of PII_EXPECTED_LITERALS.entries()) {
      expect(Array.isArray(entries), `${file} value must be an array`).toBe(true)
      for (const entry of entries as AllowlistEntry[]) {
        expect(
          entry.literal,
          `${file} entry.literal must be a RegExp`,
        ).toBeInstanceOf(RegExp)
        expect(
          entry.literal.flags.includes('g'),
          `${file} entry.literal must have the g flag for multi-occurrence replace`,
        ).toBe(true)
        expect(
          entry.lineMustMatch,
          `${file} entry.lineMustMatch must be a RegExp`,
        ).toBeInstanceOf(RegExp)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// runPiiCheckForFiles end-to-end: drives the production scanner against the
// real repository state. The strip-only assertions above test the strip
// helper in isolation; the assertions below cover the full
// filename-lookup + scrub-and-retest wiring so that a typo in the lookup
// or a regression in `scanFile` integration would surface here too.
// ---------------------------------------------------------------------------

describe('runPiiCheckForFiles end-to-end against the live repository state', () => {
  it('emits zero errors against every allowlisted file (real scanner wiring check)', () => {
    const errors: string[] = []
    runPiiCheckForFiles(
      Array.from(PII_EXPECTED_LITERALS.keys()),
      (msg: string) => errors.push(msg),
    )
    expect(
      errors,
      `expected no PII findings against allowlisted files, got:\n${errors.join('\n')}`,
    ).toEqual([])
  })

  it('emits zero errors against a known-clean non-allowlisted file (README.md)', () => {
    const errors: string[] = []
    runPiiCheckForFiles(['README.md'], (msg: string) => errors.push(msg))
    expect(errors).toEqual([])
  })

  it('skips its own source file (tools/check-release-hygiene.mjs) so the PII-pattern definitions do not match themselves', () => {
    const errors: string[] = []
    runPiiCheckForFiles(
      ['tools/check-release-hygiene.mjs'],
      (msg: string) => errors.push(msg),
    )
    expect(errors).toEqual([])
  })
})
