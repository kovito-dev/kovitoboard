/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  countMatchesInText,
  INTERNAL_ID_DEFAULT_MODE,
  INTERNAL_ID_MODES,
  INTERNAL_ID_PATTERNS,
  isInternalIdTemplateAgentFile,
  parseArgs,
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

  it('clean.ts produces zero hits across all patterns', () => {
    const out = scanFileForPatterns(join(FIXTURE_DIR, 'clean.ts'), INTERNAL_ID_PATTERNS)
    expect(out.skipped).toBe(false)
    if (out.skipped) return
    for (const r of out.results) {
      expect(r.hits, `${r.pattern.id} matched clean.ts unexpectedly`).toEqual([])
    }
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
