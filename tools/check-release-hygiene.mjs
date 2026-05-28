#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Release hygiene checker for KovitoBoard OSS repository.
// Validates that the repo is clean for public release:
//   1. No Japanese characters in source files (except i18n/ja.ts)
//   2. No personal information patterns
//   3. No docs/specs/ directory
//   4. No internal meta-notes in user-facing content
//   5. License consistency (package.json + LICENSE file + AGPL marker)
//   6. No internal IDs (DEC / BL / agent: tags / question IDs / agent names)
//
// This module exports its pattern definitions and helpers so unit tests can
// exercise them in isolation. When invoked directly (CI or lefthook), the
// `main()` call at the bottom runs the full check.

import { execSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Section [1] / [2] / [4] configuration
// ---------------------------------------------------------------------------

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.css']

// Relative paths excluded from Japanese character checks.
// These files legitimately contain Japanese for:
//   - i18n dictionaries (ja.ts, initial-prompts.ts, upgrade-prompts.ts)
//   - CLAUDE.md parsing regex (settings-reader.ts, agent-reader.ts)
//   - Security inspection patterns (recipe-inspector.ts)
//   - Agent prompt templates (app-creation-prompt.ts, recipe-applicator.ts)
export const JAPANESE_EXCLUDE = new Set([
  'src/renderer/i18n/ja.ts',
  'src/renderer/i18n/en.ts',       // language endonyms are intentional
  'src/server/services/initial-prompts.ts',
  'src/server/services/upgrade-prompts.ts',
  'src/shared/app-creation-prompt.ts',  // agent prompt template
  'src/shared/app-removal-prompt.ts',   // agent prompt template
  'src/server/recipe-applicator.ts',    // agent prompt template
  'src/server/settings-reader.ts',
  'src/server/agent-reader.ts',
  'src/server/recipe-inspector.ts',
  'tools/check-release-hygiene.mjs', // contains Japanese patterns for meta-note detection
])

// Path prefixes excluded from Japanese character checks.
// tests/ is developer-facing test code that does not impact OSS end-user UX,
// so Japanese describe/it identifiers are allowed there.
export const JAPANESE_EXCLUDE_PREFIXES = [
  'templates/agents/',
  'tests/',
]

// Personal information patterns (always error)
export const PII_PATTERNS = [
  { label: 'irikura', regex: /irikura/i },
  { label: '@Zenbook', regex: /@Zenbook/i },
  { label: 'orolira', regex: /orolira/i },
  { label: '@gmail.com', regex: /@gmail\.com/i },
  { label: '/home/irikura', regex: /\/home\/irikura/i },
]

// Narrowly scoped PII allowlist for external-facing governance files.
// The maintainer's published handle / email is intentional in these files
// (CODEOWNERS ownership declaration, Code of Conduct enforcement contact,
// security reporting secondary channel). Listing the expected literals here
// — instead of exempting the whole file — keeps the PII scan active for
// every other pattern, so future edits that accidentally introduce a
// different email, handle, or absolute path are still caught.
//
// Semantics: when scanning a governance file, every line is first scrubbed
// of these expected literals; if a PII pattern still matches the stripped
// line, it is flagged as an error.
export const PII_EXPECTED_LITERALS = new Map([
  ['CODEOWNERS', [/@kousuke-irikura\b/g]],
  ['CODE_OF_CONDUCT.md', [/orolira@gmail\.com/g]],
  ['SECURITY.md', [/orolira@gmail\.com/g]],
])

// Japanese character ranges (Hiragana + Katakana + CJK Unified Ideographs)
export const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/


// Internal meta-note patterns that should not appear in OSS release content.
// ERROR-level patterns cause CI failure (scanned per line).
export const META_ERROR_PATTERNS = [
  { label: '叩き台 (draft/scaffold)', regex: /叩き台/ },
  { label: '(draft)', regex: /\(draft\)/i },
  { label: '改訂履歴 (revision history)', regex: /改訂履歴/ },
]

// ERROR-level pattern that requires multi-line context (scanned against full content).
// Matches "Revision history" as a heading followed within a few lines by a table header.
export const META_ERROR_MULTILINE = [
  { label: 'Revision history table', regex: /Revision\s+history[^\n]*\n(?:[^\n]*\n){0,3}\s*\|/i },
]

// WARNING-level patterns are logged but do not fail the check.
//
// Note: `biz-dev` was previously listed here too. It is now owned by section
// [6/7]'s standalone agent name pattern (the "false-positive prone" set), so
// keeping it here would double-count every hit and make the summary noisy.
// `kovito-hq` is unique to this list — section [6/7] does not check for it.
export const META_WARN_PATTERNS = [
  { label: 'TODO/FIXME/XXX/TBD', regex: /(^|\s)(?:TODO:|FIXME:|XXX:|TBD\b)/ },
  { label: 'kovito-hq (internal repo)', regex: /kovito-hq/i },
]

// Directories and files scanned for internal meta-note patterns.
export const META_SCAN_TARGETS = [
  'templates/',
  'docs/agent-ref/',
  'app.example/',
  'recipes/',
  'README.md',
  'CONTRIBUTING.md',
]

// Paths excluded from meta-note scanning.
export const META_EXCLUDE_PREFIXES = [
  'tests/',
  'docs/specs/',
  'node_modules/',
  'dist/',
]

// ---------------------------------------------------------------------------
// Section [6] internal-ID detection configuration
// ---------------------------------------------------------------------------
//
// Patterns mirror tools/githooks/kovitoboard-commit-msg in the kovitoboard-dev
// workspace (the SSOT for the commit-msg hook). Because that hook lives in a
// different repository, the definitions are intentionally duplicated here;
// keep the two in sync when either evolves.
//
// Each pattern declares the modes in which it should produce an error
// (`errorInPhases`). In the default `warn-only` mode every pattern emits a
// warning so that the C-4 cleanup work has a measurable signal.

export const INTERNAL_ID_PATTERNS = [
  {
    // Anchored with `\b` so substrings inside longer identifiers, hashes, or
    // URL fragments do not produce noise. The commit-msg hook uses the
    // unanchored form because messages are short and false positives are
    // tolerable; code scanning needs the tighter bound.
    id: 'P-1',
    label: 'DEC ID (DEC-NNN)',
    regex: /\bDEC-[0-9]+\b/,
    errorInPhases: new Set(['partial-error', 'full-error']),
  },
  {
    id: 'P-2',
    label: 'BL ID (BL-YYYY-NNN)',
    regex: /\bBL-[0-9]{4}-[0-9]+\b/,
    errorInPhases: new Set(['partial-error', 'full-error']),
  },
  {
    id: 'P-3',
    label: 'agent: tag',
    regex: /\(agent:[^)]+\)/,
    errorInPhases: new Set(['partial-error', 'full-error']),
  },
  {
    id: 'P-4',
    label: 'KB-prefixed agent name (kb-architect / kb-pdm)',
    regex: /\bkb-(?:architect|pdm)\b/,
    errorInPhases: new Set(['partial-error', 'full-error']),
  },
  {
    id: 'P-5',
    label: 'standalone agent name (false-positive prone)',
    // Excludes "developer / tester / pdm" — those are captured by P-6.
    regex: /\b(?:architect|biz-dev|secretary|workspace-architect|idea-partner|researcher|planner|writer|pipeline-dev|media-ops)\b/,
    // Permanently warn (see C-4 design notes §2.2).
    errorInPhases: new Set(),
  },
  {
    id: 'P-6',
    label: 'common-word agent name (max false-positive)',
    regex: /\b(?:developer|tester|pdm)\b/,
    // Permanently warn (strongly recommended in C-4 design notes §2.2).
    errorInPhases: new Set(),
  },
  {
    id: 'P-7',
    label: 'internal question ID (Q / SS / SM / SDA / AA / BB prefixes)',
    regex: /\bQ[0-9]+\b|\bSS-[0-9]+\b|\bSM-[0-9]+\b|\bSDA-[0-9]+\b|\bAA-[0-9]+\b|\bBB-[0-9]+\b/,
    errorInPhases: new Set(['partial-error', 'full-error']),
  },
]

export const INTERNAL_ID_MODES = ['warn-only', 'partial-error', 'full-error']

export const INTERNAL_ID_DEFAULT_MODE = 'warn-only'

// Internal-ID scan must read each candidate file once. To bound CI memory and
// CPU even if a large text file (e.g. a generated fixture) sneaks past the
// extension allowlist, apply a hard size cap. Files larger than the cap are
// reported once and skipped.
export const INTERNAL_ID_FILE_SIZE_CAP = 1024 * 1024 // 1 MiB

// Files that are never scanned for internal IDs.
//
// The hygiene script itself contains the patterns we're looking for, and the
// matching unit-test file embeds intentional sample strings to exercise those
// patterns. Both must be excluded — otherwise stricter modes (partial-error /
// full-error) would flag the project's own test corpus instead of release
// content.
export const INTERNAL_ID_EXCLUDE_FILES = new Set([
  'tools/check-release-hygiene.mjs',
  'tests/unit/check-release-hygiene.test.ts',
])

// Path prefixes that are never scanned for internal IDs.
export const INTERNAL_ID_EXCLUDE_PREFIXES = [
  'tests/fixtures/projects/',
  'tests/fixtures/hygiene-internal-id/',
]

// Root-level scanning is pattern-based rather than allowlist-based: a new
// root file (a future RELEASE-NOTES.md, a new tooling config, etc.) cannot
// silently bypass the gate by virtue of not appearing in a hard-coded list.
// Only documentation and config formats are scanned; binary and license
// files are not in scope.
//
// `.js` and `.mjs` are included because tooling configs often live at the
// repo root (e.g. `eslint.config.mjs`, a future `vite.config.mjs`).
export const INTERNAL_ID_ROOT_EXTENSIONS = [
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.ts',
  '.mjs',
  '.js',
]

// Root-level files that are deliberately excluded from the scan even though
// their extension would otherwise qualify them. `package-lock.json` is
// generated and dwarfs the size cap; LICENSE is external GPL/AGPL text.
export const INTERNAL_ID_ROOT_FILE_EXCLUDES = new Set([
  'package-lock.json',
])

// In agent template files the false-positive-prone agent-name patterns are
// skipped because those identifiers legitimately appear as template content
// (each template defines its own agent ID). The genuine internal-ID patterns
// (DEC IDs, BL IDs, agent: tags, KB-prefixed names, question IDs) still
// apply: those identifiers have no business living in a public agent
// template either, and skipping them would create a coverage gap in the
// release-hygiene gate.
export const INTERNAL_ID_TEMPLATE_AGENT_SKIPPED_PATTERN_IDS = new Set(['P-5', 'P-6'])

export function isInternalIdTemplateAgentFile(relPath) {
  return /^templates\/agents\/[^/]+\.md$/.test(relPath)
}

// Decide whether a tracked file belongs to the internal-ID scan set.
export function shouldScanFileForInternalId(relPath) {
  if (INTERNAL_ID_EXCLUDE_FILES.has(relPath)) return false
  for (const prefix of INTERNAL_ID_EXCLUDE_PREFIXES) {
    if (relPath.startsWith(prefix)) return false
  }
  if (relPath.startsWith('src/') && /\.(?:ts|tsx|js|mjs|css)$/.test(relPath)) return true
  if (relPath.startsWith('tools/') && /\.(?:mjs|js|ts|sh)$/.test(relPath)) return true
  if (relPath.startsWith('tests/') && /\.(?:ts|tsx|js|mjs)$/.test(relPath)) return true
  if (relPath.startsWith('templates/') && /\.(?:md|json|yaml|yml)$/.test(relPath)) return true
  if (relPath.startsWith('docs/') && relPath.endsWith('.md')) return true
  if (relPath.startsWith('app.example/')) return true
  if (relPath.startsWith('recipes/')) return true
  // Root-level files (no slash). Pattern-based: any documentation or config
  // format at the repo root, minus an explicit exclude list for generated /
  // external content.
  if (!relPath.includes('/')) {
    if (INTERNAL_ID_ROOT_FILE_EXCLUDES.has(relPath)) return false
    return INTERNAL_ID_ROOT_EXTENSIONS.some((ext) => relPath.endsWith(ext))
  }
  return false
}

// Map (pattern, mode) -> 'warn' | 'error'. Pure function for unit testing.
export function severityForPattern(pattern, mode) {
  if (mode === 'warn-only') return 'warn'
  return pattern.errorInPhases.has(mode) ? 'error' : 'warn'
}

// ---------------------------------------------------------------------------
// CLI argument parsing (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse argv into a normalized options object.
 *
 * @param {string[]} argv - process.argv-shaped array (we slice from index 2).
 * @returns {{
 *   piiOnly: boolean,
 *   japaneseOnly: boolean,
 *   metaOnly: boolean,
 *   internalIdOnly: boolean,
 *   strict: boolean,
 *   internalIdMode: 'warn-only' | 'partial-error' | 'full-error',
 *   runAll: boolean,
 * }}
 * @throws {Error} when --internal-id-mode receives an unknown value.
 */
export function parseArgs(argv) {
  const args = argv.slice(2)
  const piiOnly = args.includes('--pii-only')
  const japaneseOnly = args.includes('--japanese-only')
  const metaOnly = args.includes('--meta-only')
  const internalIdOnly = args.includes('--internal-id-only')
  const postBuildOnly = args.includes('--post-build-only')
  const strict = args.includes('--strict')

  const modeArg = args.find((a) => a.startsWith('--internal-id-mode='))
  const internalIdMode = modeArg
    ? modeArg.slice('--internal-id-mode='.length)
    : INTERNAL_ID_DEFAULT_MODE
  if (!INTERNAL_ID_MODES.includes(internalIdMode)) {
    throw new Error(
      `Invalid --internal-id-mode: "${internalIdMode}". Must be one of: ${INTERNAL_ID_MODES.join(', ')}`,
    )
  }

  const runAll =
    !piiOnly && !japaneseOnly && !metaOnly && !internalIdOnly && !postBuildOnly

  return {
    piiOnly,
    japaneseOnly,
    metaOnly,
    internalIdOnly,
    postBuildOnly,
    strict,
    internalIdMode,
    runAll,
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Get git-tracked files matching given extensions.
 *
 * Uses `git ls-files -z` so filenames are separated by NUL bytes rather than
 * newlines: Git permits tracked filenames containing newlines, and naive
 * line-splitting can corrupt the file list and let crafted paths slip past
 * the hygiene scan.
 *
 * @param {string[]} extensions
 * @returns {string[]}
 */
export function getTrackedSourceFiles(extensions) {
  try {
    const output = execSync('git ls-files -z', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output
      .split('\0')
      .filter((f) => f && extensions.some((ext) => f.endsWith(ext)))
  } catch {
    return []
  }
}

/**
 * Get all git-tracked text files (excludes known binary extensions).
 *
 * Uses `git ls-files -z` for the same reason — filenames may contain newlines.
 *
 * @returns {string[]}
 */
export function getAllTrackedTextFiles() {
  const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot',
  ])
  try {
    const output = execSync('git ls-files -z', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output
      .split('\0')
      .filter((f) => {
        if (!f) return false
        const ext = f.substring(f.lastIndexOf('.'))
        return !BINARY_EXTS.has(ext)
      })
  } catch {
    return []
  }
}

/** @param {string} relPath */
export function isJapaneseExcluded(relPath) {
  if (JAPANESE_EXCLUDE.has(relPath)) return true
  return JAPANESE_EXCLUDE_PREFIXES.some((prefix) => relPath.startsWith(prefix))
}

/**
 * Scan a file for regex matches, returning line-level hits.
 * @param {string} filePath - absolute path
 * @param {RegExp} pattern
 * @returns {{ line: number, text: string }[]}
 */
export function scanFile(filePath, pattern) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push({ line: i + 1, text: lines[i].trim() })
      }
    }
    return hits
  } catch {
    return []
  }
}

/**
 * Scan a file for a multi-line regex match against the full content.
 * @param {string} filePath - absolute path
 * @param {RegExp} pattern
 * @returns {{ line: number, text: string }[]}
 */
export function scanFileMultiline(filePath, pattern) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
    )
    const hits = []
    let match
    while ((match = globalPattern.exec(content)) !== null) {
      const before = content.substring(0, match.index)
      const line = before.split('\n').length
      const matchedLine = content.split('\n')[line - 1] || ''
      hits.push({ line, text: matchedLine.trim() })
    }
    return hits
  } catch {
    return []
  }
}

/**
 * Get git-tracked text files that match META_SCAN_TARGETS and are not excluded.
 * @returns {string[]}
 */
export function getMetaScanFiles() {
  const allFiles = getAllTrackedTextFiles()
  return allFiles.filter((f) => {
    const isTarget = META_SCAN_TARGETS.some((t) =>
      t.endsWith('/') ? f.startsWith(t) : f === t,
    )
    if (!isTarget) return false
    const isExcluded = META_EXCLUDE_PREFIXES.some((prefix) => f.startsWith(prefix))
    return !isExcluded
  })
}

/**
 * Get git-tracked files that should be scanned for internal IDs.
 * @returns {string[]}
 */
export function getInternalIdScanFiles() {
  return getAllTrackedTextFiles().filter(shouldScanFileForInternalId)
}

/**
 * Count every regex occurrence inside a single text line. `scanFile` returns
 * one entry per matching line which is the right granularity for surfacing
 * code locations, but a line such as a comment listing several question IDs
 * contains multiple actual matches; the cleanup metric tracks the total
 * occurrence count, not the matching-line count.
 *
 * @param {string} text
 * @param {RegExp} regex - non-global regex; a global copy is used internally.
 * @returns {number}
 */
export function countMatchesInText(text, regex) {
  const globalRe = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : regex.flags + 'g',
  )
  const matches = text.match(globalRe)
  return matches ? matches.length : 0
}

/**
 * Read a file once and evaluate every supplied pattern against it.
 *
 * `scanFile` is convenient when a section runs a single regex per file (the
 * Japanese / PII / multiline-meta-note paths), but the internal-ID detector
 * runs ~7 patterns per file. Calling `scanFile` per pattern would re-read and
 * re-split the same file each time. This helper does the I/O once.
 *
 * If the file is missing, unreadable, or larger than `sizeCap`, it returns a
 * skipped envelope so the caller can surface a single diagnostic instead of
 * silently dropping data.
 *
 * @param {string} filePath - absolute path
 * @param {Array<{ regex: RegExp }>} patterns
 * @param {{ sizeCap?: number }} [opts]
 * @returns {{
 *   skipped: false,
 *   results: Array<{ pattern: { regex: RegExp }, hits: { line: number, text: string }[] }>,
 * } | {
 *   skipped: true,
 *   reason: 'size-cap' | 'read-error',
 *   size?: number,
 *   results: [],
 * }}
 */
export function scanFileForPatterns(filePath, patterns, opts = {}) {
  const { sizeCap } = opts
  let content
  try {
    // `lstatSync` does NOT follow symlinks, so a tracked symlink pointing
    // outside the repo or to a special file (FIFO, device, socket) is
    // detected and refused before we open it. Without this, `readFileSync`
    // on a symlink to /dev/zero or a FIFO can hang or exhaust CI memory.
    const stats = lstatSync(filePath)
    if (!stats.isFile()) {
      return { skipped: true, reason: 'special-file', results: [] }
    }
    if (typeof sizeCap === 'number' && stats.size > sizeCap) {
      return { skipped: true, reason: 'size-cap', size: stats.size, results: [] }
    }
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return { skipped: true, reason: 'read-error', results: [] }
  }
  const lines = content.split('\n')
  // Defensive: build a non-stateful regex copy for each pattern so a future
  // /g or /y flag would not leak `lastIndex` across lines and skip matches
  // nondeterministically. Today's internal-ID patterns are all non-global,
  // but the helper is generic and the cost of one fresh RegExp per scan is
  // negligible.
  const localRegexes = patterns.map((p) =>
    p.regex.global || p.regex.sticky
      ? new RegExp(p.regex.source, p.regex.flags.replace(/[gy]/g, ''))
      : p.regex,
  )
  const results = patterns.map((p) => ({ pattern: p, hits: [] }))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let pi = 0; pi < results.length; pi++) {
      if (localRegexes[pi].test(line)) {
        results[pi].hits.push({ line: i + 1, text: line.trim() })
      }
    }
  }
  return { skipped: false, results }
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

class Counters {
  constructor() {
    this.warnings = 0
    this.errors = 0
  }
}

/**
 * Generic warn helper used by sections [1] / [4] only. In `--strict` mode the
 * existing CI policy escalates these warnings to errors.
 *
 * Section [6] internal-ID detection deliberately does NOT use this helper —
 * its severity is controlled by `--internal-id-mode`, independent of `--strict`.
 */
function makeWarn(counters, strict) {
  return (msg) => {
    if (strict) {
      console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
      counters.errors++
    } else {
      console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`)
      counters.warnings++
    }
  }
}

function makeError(counters) {
  return (msg) => {
    console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
    counters.errors++
  }
}

/**
 * Internal-ID specific reporter. Severity is derived from `--internal-id-mode`
 * via {@link severityForPattern}; the global `--strict` flag does NOT promote
 * these warnings to errors. Counts go to the shared counters per-occurrence
 * (not per emitted line) so that the final summary reflects the total number
 * of internal-ID hits — the metric the C-4 cleanup work tracks.
 */
function makeInternalIdReport(counters) {
  return (severity, msg, hitCount) => {
    if (severity === 'error') {
      console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
      counters.errors += hitCount
    } else {
      console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`)
      counters.warnings += hitCount
    }
  }
}

// ---------------------------------------------------------------------------
// Section runners
// ---------------------------------------------------------------------------

function runJapaneseCheck(warn) {
  console.log('\n\x1b[1m[1/7] Japanese character detection\x1b[0m')

  const sourceFiles = getTrackedSourceFiles(SOURCE_EXTENSIONS).filter(
    (f) => !isJapaneseExcluded(f),
  )

  let japaneseFileCount = 0
  for (const file of sourceFiles) {
    const hits = scanFile(join(ROOT, file), JAPANESE_RE)
    if (hits.length > 0) {
      japaneseFileCount++
      warn(`${file} (${hits.length} occurrence${hits.length > 1 ? 's' : ''})`)
      for (const h of hits.slice(0, 3)) {
        console.log(`         L${h.line}: ${h.text.substring(0, 80)}`)
      }
      if (hits.length > 3) {
        console.log(`         ... and ${hits.length - 3} more`)
      }
    }
  }

  if (japaneseFileCount === 0) {
    console.log('  \x1b[32mOK\x1b[0m    No Japanese characters found in source files')
  } else {
    console.log(`\n  Found Japanese characters in ${japaneseFileCount} file(s)`)
  }
}

function runPiiCheck(error) {
  console.log('\n\x1b[1m[2/7] Personal information detection\x1b[0m')

  const allTextFiles = getAllTrackedTextFiles()
  let piiFound = false

  for (const { label, regex } of PII_PATTERNS) {
    for (const file of allTextFiles) {
      if (file === 'tools/check-release-hygiene.mjs') continue
      const hits = scanFile(join(ROOT, file), regex)
      if (hits.length === 0) continue

      const expected = PII_EXPECTED_LITERALS.get(file)
      for (const hit of hits) {
        // For governance files, scrub the expected literal occurrences and
        // re-test; only flag if a real match survives the strip. Every other
        // file is reported as-is.
        if (expected) {
          let stripped = hit.text
          for (const literal of expected) {
            stripped = stripped.replace(literal, '')
          }
          if (!regex.test(stripped)) continue
        }
        piiFound = true
        error(`PII "${label}" found: ${file}:${hit.line}`)
      }
    }
  }

  if (!piiFound) {
    console.log('  \x1b[32mOK\x1b[0m    No personal information patterns found')
  }
}

function runSpecsDirCheck(error) {
  console.log('\n\x1b[1m[3/7] docs/specs/ directory check\x1b[0m')

  const specsDir = join(ROOT, 'docs', 'specs')
  if (existsSync(specsDir)) {
    error('docs/specs/ directory exists — should be removed (internal docs only)')
  } else {
    console.log('  \x1b[32mOK\x1b[0m    docs/specs/ does not exist')
  }
}

function runMetaCheck(warn, error) {
  console.log('\n\x1b[1m[4/7] Internal meta-note detection\x1b[0m')

  const metaFiles = getMetaScanFiles()
  let metaErrorCount = 0
  let metaWarnCount = 0

  for (const file of metaFiles) {
    if (file === 'tools/check-release-hygiene.mjs') continue
    const absPath = join(ROOT, file)

    for (const { label, regex } of META_ERROR_PATTERNS) {
      const hits = scanFile(absPath, regex)
      if (hits.length > 0) {
        metaErrorCount += hits.length
        for (const hit of hits) {
          error(`Meta-note "${label}" found: ${file}:${hit.line}`)
          console.log(`         L${hit.line}: ${hit.text.substring(0, 80)}`)
        }
      }
    }

    for (const { label, regex } of META_ERROR_MULTILINE) {
      const hits = scanFileMultiline(absPath, regex)
      if (hits.length > 0) {
        metaErrorCount += hits.length
        for (const hit of hits) {
          error(`Meta-note "${label}" found: ${file}:${hit.line}`)
          console.log(`         L${hit.line}: ${hit.text.substring(0, 80)}`)
        }
      }
    }

    for (const { label, regex } of META_WARN_PATTERNS) {
      const hits = scanFile(absPath, regex)
      if (hits.length > 0) {
        metaWarnCount += hits.length
        for (const hit of hits) {
          warn(`Meta-note "${label}" found: ${file}:${hit.line}`)
          console.log(`         L${hit.line}: ${hit.text.substring(0, 80)}`)
        }
      }
    }
  }

  if (metaErrorCount === 0 && metaWarnCount === 0) {
    console.log('  \x1b[32mOK\x1b[0m    No internal meta-note patterns found')
  } else {
    if (metaErrorCount > 0) {
      console.log(`\n  Found ${metaErrorCount} meta-note error(s) in scanned files`)
    }
    if (metaWarnCount > 0) {
      console.log(`  Found ${metaWarnCount} meta-note warning(s) in scanned files`)
    }
  }
}

function runLicenseCheck(error) {
  console.log('\n\x1b[1m[5/7] License consistency check\x1b[0m')

  const EXPECTED_LICENSE = 'AGPL-3.0-or-later'
  const EXPECTED_AUTHOR = 'Anode LLC'
  const EXPECTED_LICENSE_MARKER = 'GNU AFFERO GENERAL PUBLIC LICENSE'

  const pkgPath = join(ROOT, 'package.json')
  if (!existsSync(pkgPath)) {
    error('package.json not found at repo root')
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.license !== EXPECTED_LICENSE) {
        error(`package.json "license" must be "${EXPECTED_LICENSE}" (found: "${pkg.license}")`)
      } else {
        console.log(`  \x1b[32mOK\x1b[0m    package.json license = "${EXPECTED_LICENSE}"`)
      }
      if (pkg.author !== EXPECTED_AUTHOR) {
        error(`package.json "author" must be "${EXPECTED_AUTHOR}" (found: "${pkg.author ?? '(missing)'}")`)
      } else {
        console.log(`  \x1b[32mOK\x1b[0m    package.json author = "${EXPECTED_AUTHOR}"`)
      }
    } catch (e) {
      error(`Failed to parse package.json: ${e.message}`)
    }
  }

  const licensePath = join(ROOT, 'LICENSE')
  if (!existsSync(licensePath)) {
    error('LICENSE file not found at repo root')
  } else {
    const licenseContent = readFileSync(licensePath, 'utf-8')
    if (!licenseContent.includes(EXPECTED_LICENSE_MARKER)) {
      error(`LICENSE file does not contain expected marker "${EXPECTED_LICENSE_MARKER}"`)
    } else {
      console.log('  \x1b[32mOK\x1b[0m    LICENSE file contains AGPL v3 text')
    }
  }

  const HEADER_TARGET_EXTS = ['.ts', '.tsx', '.mjs', '.js']
  const HEADER_EXCLUDE_PREFIXES = ['tests/fixtures/projects/']
  const headerTargets = getTrackedSourceFiles(HEADER_TARGET_EXTS).filter(
    (f) => !HEADER_EXCLUDE_PREFIXES.some((p) => f.startsWith(p)),
  )
  const missingHeader = []
  for (const file of headerTargets) {
    const abs = join(ROOT, file)
    if (!existsSync(abs)) continue
    const head = readFileSync(abs, 'utf-8').slice(0, 512)
    if (!head.includes('SPDX-License-Identifier')) {
      missingHeader.push(file)
    }
  }
  if (missingHeader.length === 0) {
    console.log(`  \x1b[32mOK\x1b[0m    All ${headerTargets.length} source files have AGPL header`)
  } else {
    error(`${missingHeader.length} source file(s) missing AGPL header (run \`node scripts/add-license-header.mjs\` to fix):`)
    for (const f of missingHeader.slice(0, 10)) {
      console.log(`         ${f}`)
    }
    if (missingHeader.length > 10) {
      console.log(`         ... and ${missingHeader.length - 10} more`)
    }
  }
}

function runInternalIdCheck(report, mode) {
  console.log('\n\x1b[1m[6/7] Internal-ID detection\x1b[0m')
  console.log(`  Mode: ${mode}`)

  const targetFiles = getInternalIdScanFiles()

  let totalErrors = 0
  let totalWarns = 0
  let skippedBySizeCap = 0
  let skippedByReadError = 0
  let skippedBySpecialFile = 0
  /** @type {Map<string, number>} */
  const perPatternCounts = new Map()

  for (const file of targetFiles) {
    const isAgentTemplate = isInternalIdTemplateAgentFile(file)
    const patternsForFile = isAgentTemplate
      ? INTERNAL_ID_PATTERNS.filter(
          (p) => !INTERNAL_ID_TEMPLATE_AGENT_SKIPPED_PATTERN_IDS.has(p.id),
        )
      : INTERNAL_ID_PATTERNS
    const scan = scanFileForPatterns(join(ROOT, file), patternsForFile, {
      sizeCap: INTERNAL_ID_FILE_SIZE_CAP,
    })
    if (scan.skipped) {
      // Skip reasons are ALWAYS reported as errors, regardless of mode.
      //
      // The warn-only promise applies to pattern matches: those are
      // intentionally non-fatal while the cleanup is in progress. A skipped
      // file is different — the scan could not run at all, so we do not
      // know what is inside, and a contributor could otherwise hide internal
      // IDs behind a symlink, an oversized blob, or an unreadable path. The
      // only way to keep the gate honest is to fail CI on every skip.
      if (scan.reason === 'special-file') {
        skippedBySpecialFile++
        report(
          'error',
          `${file} not scanned for internal-IDs (symlink or non-regular file)`,
          1,
        )
        totalErrors++
      } else if (scan.reason === 'size-cap') {
        skippedBySizeCap++
        report(
          'error',
          `${file} not scanned for internal-IDs (${scan.size} bytes exceeds ${INTERNAL_ID_FILE_SIZE_CAP} cap)`,
          1,
        )
        totalErrors++
      } else if (scan.reason === 'read-error') {
        skippedByReadError++
        report(
          'error',
          `${file} could not be read for internal-ID scan (broken symlink or permission issue?)`,
          1,
        )
        totalErrors++
      }
      continue
    }
    for (const { pattern, hits } of scan.results) {
      if (hits.length === 0) continue
      // Sum actual regex occurrences per line — a line may contain multiple
      // matches (e.g. a comment listing several question IDs at once) and
      // the cleanup metric tracks every one.
      let occurrenceCount = 0
      for (const h of hits) {
        occurrenceCount += countMatchesInText(h.text, pattern.regex)
      }
      // Defensive fallback: every matching line should yield at least 1.
      if (occurrenceCount < hits.length) occurrenceCount = hits.length
      const severity = severityForPattern(pattern, mode)
      perPatternCounts.set(
        pattern.id,
        (perPatternCounts.get(pattern.id) ?? 0) + occurrenceCount,
      )
      // Line numbers only — never echo the matching line content. CI logs
      // for the OSS repository are public, and printing the matched text
      // would aggregate the very internal IDs the gate is meant to keep out.
      // Locations are enough to grep with.
      const lineNumbers = hits.slice(0, 10).map((h) => `L${h.line}`)
      const lineSuffix =
        hits.length > 10 ? ` (+${hits.length - 10} more)` : ''
      report(
        severity,
        `${file} [${pattern.id} ${pattern.label}] (${occurrenceCount} occurrence${occurrenceCount > 1 ? 's' : ''} on ${hits.length} line${hits.length > 1 ? 's' : ''}): ${lineNumbers.join(', ')}${lineSuffix}`,
        occurrenceCount,
      )
      if (severity === 'error') totalErrors += occurrenceCount
      else totalWarns += occurrenceCount
    }
  }

  if (totalErrors === 0 && totalWarns === 0) {
    console.log('  \x1b[32mOK\x1b[0m    No internal-ID patterns found')
    if (skippedBySizeCap > 0) {
      console.log(`         (${skippedBySizeCap} file(s) skipped over the size cap)`)
    }
    if (skippedByReadError > 0) {
      console.log(`         (${skippedByReadError} file(s) skipped due to read error)`)
    }
    if (skippedBySpecialFile > 0) {
      console.log(`         (${skippedBySpecialFile} file(s) skipped as non-regular file)`)
    }
    return
  }

  console.log('')
  if (totalErrors > 0) console.log(`  Found ${totalErrors} internal-ID error(s)`)
  if (totalWarns > 0) console.log(`  Found ${totalWarns} internal-ID warning(s)`)
  if (skippedBySizeCap > 0) {
    console.log(`         (${skippedBySizeCap} file(s) skipped over the size cap)`)
  }
  if (skippedByReadError > 0) {
    console.log(`         (${skippedByReadError} file(s) skipped due to read error)`)
  }
  if (skippedBySpecialFile > 0) {
    console.log(`         (${skippedBySpecialFile} file(s) skipped as non-regular file)`)
  }
  for (const pattern of INTERNAL_ID_PATTERNS) {
    const c = perPatternCounts.get(pattern.id)
    if (c) {
      console.log(`         ${pattern.id} (${pattern.label}): ${c}`)
    }
  }
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// [7/7] Direct console.* detection
// ---------------------------------------------------------------------------
//
// Logger discipline (logging-baseline.md §5.1) requires every log line to
// flow through pino so home-path masking + structured-component routing are
// in effect. A direct `console.error` / `console.warn` / `console.log` (or
// `info` / `debug` / `trace`) call bypasses both — the message lands on raw
// stdout / stderr instead of `.kovitoboard/logs/server.*.log`, which leaks
// `/home/<user>/...` paths and kills GitHub Issue triage.
//
// This section catches accidental regressions during Phase 1 of the
// console-to-logger migration. A future Phase 2 will eventually also add an
// ESLint / Biome `no-console` rule; the hygiene-side check is intentionally
// kept after that as a release-time gate so the two surfaces double-check
// each other.
//
// Scope:
//   - Files under `src/server/` and `src/renderer/` only.
//   - The logger implementations themselves (`src/server/logger.ts`,
//     `src/renderer/lib/logger.ts`) and `log-config.ts` (which runs *before*
//     the logger pipeline is built) are excluded by path; tests / tools /
//     scripts are out of scope by directory.
//   - A single in-source escape hatch is honoured: a line with the trailing
//     comment `// hygiene-allow: console-bootstrap` opts that line out, for
//     the bootstrap-fallback case where the logger is not yet initialised.
//     The reason string is fixed; freeform reasons are not accepted so the
//     scope of the exception cannot creep over time.

const CONSOLE_DIRECT_RE = /\bconsole\.(error|warn|log|info|debug|trace)\b/
const CONSOLE_SCAN_PREFIXES = ['src/server/', 'src/renderer/']
// Only the logger implementations are file-excluded — both files are
// `console.*` by intent (server: ConsoleFallbackLogger, renderer: the
// DevTools-fallback path). `log-config.ts` is *not* in this set: its
// single intentional `console.warn` is gated by the line-tagged
// opt-out (`// hygiene-allow: console-bootstrap`) so any future
// accidental `console.*` line elsewhere in the file would still be
// caught.
const CONSOLE_EXCLUDE_FILES = new Set([
  'src/server/logger.ts',
  'src/renderer/lib/logger.ts',
])
// Anchored on the trailing `// hygiene-allow: console-bootstrap`
// comment so the opt-out cannot be smuggled in via a string literal
// or an unrelated comment that happens to contain the same words.
const CONSOLE_OPT_OUT_RE = /\/\/\s*hygiene-allow:\s*console-bootstrap\s*$/

/**
 * Strip text that does not represent executable code on a single
 * line: full-line `//` comments and double-/single-/back-tick
 * quoted string contents. Block comments that span multiple lines
 * are tracked across calls via the closure state in `runConsoleCheck`.
 *
 * Intentionally simple: this is not a real tokenizer, just enough
 * to keep the regex from flagging mentions of `console.log` inside
 * strings or comments. False positives caused by exotic syntax
 * (template tags, regex literals containing the word, etc.) can be
 * silenced with the line-tag opt-out above.
 */
function stripStringsAndLineComments(line, state) {
  let out = ''
  let i = 0
  let inBlockComment = state.inBlockComment
  while (i < line.length) {
    if (inBlockComment) {
      const end = line.indexOf('*/', i)
      if (end === -1) {
        i = line.length
      } else {
        i = end + 2
        inBlockComment = false
      }
      continue
    }
    const two = line.slice(i, i + 2)
    if (two === '//') break
    if (two === '/*') {
      inBlockComment = true
      i += 2
      continue
    }
    const c = line[i]
    if (c === '"' || c === "'") {
      const quote = c
      out += quote
      i++
      while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length) {
          i += 2
          continue
        }
        if (line[i] === quote) {
          out += quote
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '`') {
      // Template literal: drop the inert text but keep
      // `${...}` interpolations as code so a buried
      // `console.log(...)` inside an interpolation is still
      // visible to the regex below. Brace depth is tracked so
      // nested object literals inside the interpolation do not
      // close the `${ }` early.
      out += '`'
      i++
      while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length) {
          i += 2
          continue
        }
        if (line[i] === '`') {
          out += '`'
          i++
          break
        }
        if (line[i] === '$' && line[i + 1] === '{') {
          out += '${'
          i += 2
          let depth = 1
          while (i < line.length && depth > 0) {
            const ch = line[i]
            if (ch === '{') depth++
            if (ch === '}') {
              depth--
              if (depth === 0) {
                out += '}'
                i++
                break
              }
            }
            out += ch
            i++
          }
          continue
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  state.inBlockComment = inBlockComment
  return out
}

function runConsoleCheck(warn) {
  console.log('\n\x1b[1m[7/7] Direct console.* call detection\x1b[0m')

  // Match every JS / TS source extension used in src/{server,renderer},
  // not just `.ts` / `.tsx`. Coverage parity with the documented
  // scope: any future `.js` / `.jsx` / `.mjs` / `.cjs` source file
  // under those trees should hit the same gate.
  const sourceFiles = getTrackedSourceFiles([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
  ]).filter((file) => {
    if (!CONSOLE_SCAN_PREFIXES.some((p) => file.startsWith(p))) return false
    if (CONSOLE_EXCLUDE_FILES.has(file)) return false
    if (file.startsWith('tests/')) return false
    if (file.startsWith('tools/')) return false
    if (file.startsWith('scripts/')) return false
    return true
  })

  let totalHits = 0
  let fileCount = 0
  for (const file of sourceFiles) {
    let content
    try {
      content = readFileSync(join(ROOT, file), 'utf-8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    const state = { inBlockComment: false }
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      // Honour the line-tagged opt-out before scrubbing the line, so
      // the trailing `// hygiene-allow: console-bootstrap` comment
      // is the gate (not the substring).
      if (CONSOLE_OPT_OUT_RE.test(raw)) {
        // Still let the block-comment tracker advance through this
        // line in case the opt-out tag immediately precedes a
        // multi-line comment.
        stripStringsAndLineComments(raw, state)
        continue
      }
      const codeOnly = stripStringsAndLineComments(raw, state)
      if (CONSOLE_DIRECT_RE.test(codeOnly)) {
        hits.push({ line: i + 1, text: raw })
      }
    }
    if (hits.length === 0) continue
    fileCount++
    totalHits += hits.length
    warn(
      `${file} (${hits.length} occurrence${hits.length > 1 ? 's' : ''}) — use a child logger from src/server/logger.ts or src/renderer/lib/logger.ts`,
    )
    // Print line numbers only — no source snippets — so a hardcoded
    // secret that happens to live inside a flagged `console.*` call
    // is not echoed verbatim into CI / release logs by this gate.
    for (const h of hits.slice(0, 5)) {
      console.log(`         L${h.line}`)
    }
    if (hits.length > 5) {
      console.log(`         ... and ${hits.length - 5} more`)
    }
  }

  if (totalHits === 0) {
    console.log('  \x1b[32mOK\x1b[0m    No direct console.* calls in src/')
  } else {
    console.log(
      `\n  Found ${totalHits} direct console.* call(s) across ${fileCount} file(s). Route them through the pino-backed loggers instead. See logging-baseline.md §5.1.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Section [8]: Post-build hygiene (v0.2.0 / spec v1.7 §6.10.6.17 H-CR5-A)
// ---------------------------------------------------------------------------

/**
 * Source files in the host bootstrap chain. Top-level `await` is
 * forbidden in any of these files (H-CR2). Vite's
 * `dist/.vite/manifest.json` collapses several of these into the
 * single entry chunk so we cannot derive the list from the
 * manifest alone; we therefore enumerate the chain explicitly and
 * scan each source file directly. The list is short and stable —
 * recipe code does not extend it because recipe modules are loaded
 * via dynamic `import()`, not static imports from `main.tsx`.
 */
export const HYGIENE_BOOTSTRAP_ROOTS = [
  'src/renderer/main.tsx',
  'src/renderer/app-host/hostBootstrap.ts',
  'src/renderer/app-host/injectKb.ts',
  'src/renderer/app-host/RecipePageHost.tsx',
  'src/renderer/app-host/captureBridgeRegistry.ts',
  'src/renderer/app-host/installAmbientKbBridge.ts',
  'src/renderer/lib/captureBridge.ts',
  'src/renderer/lib/kbBridge.ts',
  'src/renderer/lib/kbFetch.ts',
  'src/renderer/lib/exposeContext.ts',
  'src/renderer/lib/logger.ts',
  'src/renderer/lib/global-errors.ts',
  'src/renderer/lib/locale-bootstrap.ts',
]

/**
 * Critical-section handler files whose handler bodies must execute
 * inside a single synchronous JS execution slice (H-CR4). The check
 * scans for `await` / `.then` / `setImmediate` / `process.nextTick`
 * inside each critical-section invocation marker
 * (`withCriticalSection('<scope>', () => { ... })`).
 */
export const HYGIENE_CRITICAL_SECTION_FILES = [
  'src/server/recipe-capture-sessions.ts',
  'src/server/recipe-capture-mount-sessions.ts',
  'src/server/routes/capture-mount-routes.ts',
  'src/server/routes/capture-token-routes.ts',
]

/**
 * Locate the Vite production manifest. Vite emits it at
 * `<outDir>/.vite/manifest.json` by default; older configurations
 * placed it directly under `outDir`. We probe both so the check
 * keeps working across Vite versions.
 */
export function findViteManifest(distDir) {
  const candidates = [
    join(distDir, '.vite', 'manifest.json'),
    join(distDir, 'manifest.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Schema validation for the Vite manifest. Returns the validated
 * object or throws — the caller treats either branch as fail-closed
 * (`H-CR5-A` SSOT).
 */
export function validateManifestSchema(manifest) {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('manifest schema validation failed: not an object')
  }
  for (const [key, entry] of Object.entries(manifest)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `manifest schema validation failed: entry "${key}" is not an object`,
      )
    }
    if (typeof entry.file !== 'string') {
      throw new Error(
        `manifest schema validation failed: entry "${key}" has no string "file"`,
      )
    }
    if (entry.imports !== undefined && !Array.isArray(entry.imports)) {
      throw new Error(
        `manifest schema validation failed: entry "${key}".imports is not an array`,
      )
    }
  }
}

/**
 * Walk the static-import graph starting from each `bootstrap root`
 * key. Returns the set of source paths the bootstrap chain reaches.
 *
 * The walk relies on Vite's `manifest.imports` array, which records
 * the manifest-key form of each transitively-imported module. We
 * deliberately do not follow `dynamicImports` — those are
 * recipe-side loads gated by `RecipePageHost`, so they live outside
 * the host bootstrap fence.
 */
export function walkBootstrapChain(manifest, roots) {
  const reachable = new Set()
  const stack = [...roots]
  while (stack.length > 0) {
    const key = stack.pop()
    if (reachable.has(key)) continue
    reachable.add(key)
    const entry = manifest[key]
    if (entry === undefined) continue
    if (Array.isArray(entry.imports)) {
      for (const next of entry.imports) {
        if (!reachable.has(next)) stack.push(next)
      }
    }
  }
  return reachable
}

/**
 * Strip line comments and string literals from a source line so the
 * regex scanners do not match documentation or string contents.
 */
function stripCommentsAndStrings(line) {
  // Drop // line comments first.
  const commentIdx = line.indexOf('//')
  let stripped = commentIdx >= 0 ? line.slice(0, commentIdx) : line
  // Drop string contents (single, double, template). Keeps quotes
  // so the regex still sees structurally-recognisable code.
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''")
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""')
  stripped = stripped.replace(/`(?:\\.|[^`\\])*`/g, '``')
  return stripped
}

/**
 * Heuristic top-level await detector. Returns the line numbers
 * where a module-scope `await` appears (1-indexed). Tracks brace /
 * paren / bracket depth + arrow-function bodies to skip awaits
 * inside function bodies.
 *
 * The check is intentionally conservative: a TS/TSX file mixes
 * declarations and statements at module scope, but `await` outside
 * any function body counts as top-level. We do not need a full AST
 * — the bootstrap chain is small and well-controlled.
 */
export function detectTopLevelAwait(source) {
  const hits = []
  const lines = source.split(/\r?\n/)
  let braceDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let inBlockComment = false
  let inLineComment = false
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]
    let j = 0
    let lineSawAwaitAtTop = false
    while (j < line.length) {
      const c = line[j]
      const next2 = line.slice(j, j + 2)
      if (inLineComment) {
        break
      }
      if (inBlockComment) {
        if (next2 === '*/') {
          inBlockComment = false
          j += 2
          continue
        }
        j += 1
        continue
      }
      if (next2 === '//') {
        inLineComment = true
        break
      }
      if (next2 === '/*') {
        inBlockComment = true
        j += 2
        continue
      }
      // String literal handling — collapse to a single char.
      if (c === '"' || c === "'" || c === '`') {
        const quote = c
        j += 1
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2
            continue
          }
          if (line[j] === quote) {
            j += 1
            break
          }
          j += 1
        }
        continue
      }
      if (c === '{') braceDepth += 1
      else if (c === '}') braceDepth = Math.max(0, braceDepth - 1)
      else if (c === '(') parenDepth += 1
      else if (c === ')') parenDepth = Math.max(0, parenDepth - 1)
      else if (c === '[') bracketDepth += 1
      else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (
        braceDepth === 0 &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        line.slice(j, j + 5) === 'await' &&
        /[\s(]/.test(line[j + 5] ?? ' ')
      ) {
        // Quick filter: skip `async function ... { await ... }` —
        // we already know braceDepth is 0 here, but the previous
        // tokens on the same line might be e.g. `=> await ...`. We
        // accept that as a top-level statement because in practice
        // the bootstrap chain does not contain top-level arrow IIFE
        // expressions with awaits; the regex catches the bare
        // module-level case which is the H-CR2 violation.
        lineSawAwaitAtTop = true
      }
      j += 1
    }
    if (inLineComment) {
      inLineComment = false
    }
    if (lineSawAwaitAtTop) {
      hits.push(i + 1)
    }
  }
  return hits
}

/**
 * Atomicity lint (H-CR4). Scans the source for
 * `withCriticalSection('<scope>', () => { ... })` blocks and
 * refuses any of the forbidden constructs inside the arrow body:
 *
 *   - `await`
 *   - `.then(`, `.catch(`, `.finally(`
 *   - `setImmediate(`
 *   - `process.nextTick(`
 *
 * Returns an array of `{ line, hit }` records (line is 1-indexed).
 * The scope name is parsed for richer error messages.
 */
export function detectAtomicityViolations(source) {
  const hits = []
  const lines = source.split(/\r?\n/)
  // Locate the start of every `withCriticalSection('<scope>',` block.
  const re = /withCriticalSection\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\(\)\s*=>\s*\{/g
  // Easier: walk text + find matches with offsets.
  const text = source
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const scope = m[1]
    const startIdx = m.index + m[0].length
    // Brace-balance walk from startIdx (we are now just past `{`).
    let depth = 1
    let i = startIdx
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      // String literal handling.
      else if (c === '"' || c === "'" || c === '`') {
        i += 1
        while (i < text.length) {
          if (text[i] === '\\') {
            i += 2
            continue
          }
          if (text[i] === c) {
            i += 1
            break
          }
          i += 1
        }
        continue
      }
      i += 1
    }
    const blockText = text.slice(startIdx, Math.max(startIdx, i - 1))
    // Re-derive starting line so the hit line numbers are useful.
    const startLine = text.slice(0, startIdx).split(/\r?\n/).length
    const blockLines = blockText.split(/\r?\n/)
    for (let l = 0; l < blockLines.length; l += 1) {
      const stripped = stripCommentsAndStrings(blockLines[l])
      if (/\bawait\b/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: 'await',
          excerpt: blockLines[l].trim(),
        })
      } else if (/\.then\s*\(/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: '.then(',
          excerpt: blockLines[l].trim(),
        })
      } else if (/\.catch\s*\(/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: '.catch(',
          excerpt: blockLines[l].trim(),
        })
      } else if (/\.finally\s*\(/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: '.finally(',
          excerpt: blockLines[l].trim(),
        })
      } else if (/\bsetImmediate\s*\(/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: 'setImmediate(',
          excerpt: blockLines[l].trim(),
        })
      } else if (/process\.nextTick\s*\(/.test(stripped)) {
        hits.push({
          scope,
          line: startLine + l,
          construct: 'process.nextTick(',
          excerpt: blockLines[l].trim(),
        })
      }
    }
    // Discard the regex's internal lastIndex back to just before the
    // matched `withCriticalSection(` so nested calls inside the
    // outer scope are also scanned. (`re.exec` already advances past
    // the regex match.)
    re.lastIndex = m.index + 1
  }
  return hits
}

/**
 * Run the post-build hygiene gate (H-CR5-A). Fail-closed on:
 *   - dist build artifacts missing
 *   - manifest absent / schema mismatch
 *   - top-level await detected anywhere in the bootstrap chain
 *   - atomicity violations in any of the four critical-section
 *     handler files
 *
 * @param {(label: string, file: string) => void} error - aggregator
 */
function runPostBuildHygieneCheck(error) {
  console.log('\n\x1b[1m[8/8]\x1b[0m Post-build hygiene (H-CR5-A)...')
  const distDir = join(ROOT, 'dist')
  if (!existsSync(distDir)) {
    error('post-build: dist/ missing — run `npm run build` first', 'dist/')
    return
  }
  const manifestPath = findViteManifest(distDir)
  if (manifestPath === null) {
    error(
      'post-build: Vite manifest missing (looked for dist/.vite/manifest.json and dist/manifest.json) — set `build.manifest: true` in vite.config.ts',
      distDir,
    )
    return
  }
  let manifest
  try {
    const raw = readFileSync(manifestPath, 'utf-8')
    manifest = JSON.parse(raw)
  } catch (e) {
    error(
      `post-build: manifest parse error — ${e instanceof Error ? e.message : String(e)}`,
      manifestPath,
    )
    return
  }
  try {
    validateManifestSchema(manifest)
  } catch (e) {
    error(
      `post-build: ${e instanceof Error ? e.message : String(e)}`,
      manifestPath,
    )
    return
  }

  // Scan each declared bootstrap source for top-level await
  // (H-CR2). The manifest above is consumed only as a build-output
  // sanity check; the actual source scan walks the well-known chain
  // directly because Vite collapses several of these into a single
  // entry chunk and the resulting manifest entry no longer carries
  // the per-source path.
  for (const key of HYGIENE_BOOTSTRAP_ROOTS) {
    const fullPath = join(ROOT, key)
    if (!existsSync(fullPath)) {
      // Source dropped from the chain (refactor moved it). Skip
      // rather than fail-closed — the file list is curated and we
      // do not want CI to break on a benign rename. New entries
      // should be added to HYGIENE_BOOTSTRAP_ROOTS explicitly.
      continue
    }
    let source
    try {
      source = readFileSync(fullPath, 'utf-8')
    } catch (e) {
      error(
        `post-build: failed to read bootstrap source — ${e instanceof Error ? e.message : String(e)}`,
        key,
      )
      continue
    }
    const hits = detectTopLevelAwait(source)
    for (const lineNo of hits) {
      error(`post-build: H-CR2-VIOLATION top-level await detected at line ${lineNo}`, key)
    }
  }

  // Atomicity lint on the four critical-section handler files.
  for (const relPath of HYGIENE_CRITICAL_SECTION_FILES) {
    const fullPath = join(ROOT, relPath)
    if (!existsSync(fullPath)) {
      // Missing source = build configuration drift; flag it but do
      // not crash so other files still get scanned.
      error(`post-build: H-CR4 source file missing`, relPath)
      continue
    }
    let source
    try {
      source = readFileSync(fullPath, 'utf-8')
    } catch (e) {
      error(
        `post-build: H-CR4 source read failed — ${e instanceof Error ? e.message : String(e)}`,
        relPath,
      )
      continue
    }
    const violations = detectAtomicityViolations(source)
    for (const v of violations) {
      error(
        `post-build: H-CR4-VIOLATION inside withCriticalSection('${v.scope}') — found ${v.construct} at line ${v.line}: ${v.excerpt}`,
        relPath,
      )
    }
  }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv)
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }

  const counters = new Counters()
  const warn = makeWarn(counters, opts.strict)
  const error = makeError(counters)
  const internalIdReport = makeInternalIdReport(counters)

  if (opts.runAll || opts.japaneseOnly) runJapaneseCheck(warn)
  if (opts.runAll || opts.piiOnly) runPiiCheck(error)
  if (opts.runAll) runSpecsDirCheck(error)
  if (opts.runAll || opts.metaOnly) runMetaCheck(warn, error)
  if (opts.runAll) runLicenseCheck(error)
  if (opts.runAll || opts.internalIdOnly) runInternalIdCheck(internalIdReport, opts.internalIdMode)
  if (opts.runAll) runConsoleCheck(warn)
  // Post-build hygiene runs only when explicitly requested (via
  // `--post-build-only` or as part of the `runAll` after a build).
  // The `runAll` path additionally tolerates a missing `dist/` so
  // pre-build checks (lint-style runs, IDE hooks) do not fail just
  // because the build artifacts have not been produced yet.
  if (opts.postBuildOnly) {
    runPostBuildHygieneCheck(error)
  } else if (opts.runAll && existsSync(join(ROOT, 'dist'))) {
    runPostBuildHygieneCheck(error)
  }

  console.log('\n\x1b[1m--- Summary ---\x1b[0m')
  if (counters.errors > 0) {
    console.log(`  \x1b[31m${counters.errors} error(s)\x1b[0m, ${counters.warnings} warning(s)`)
    console.log('  Release hygiene check \x1b[31mFAILED\x1b[0m\n')
    process.exit(1)
  } else if (counters.warnings > 0) {
    console.log(`  ${counters.warnings} warning(s), 0 errors`)
    console.log('  Release hygiene check \x1b[33mPASSED with warnings\x1b[0m\n')
    process.exit(0)
  } else {
    console.log('  All checks passed')
    console.log('  Release hygiene check \x1b[32mPASSED\x1b[0m\n')
    process.exit(0)
  }
}

if (process.argv[1] === __filename) {
  main()
}
