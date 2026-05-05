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

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const PII_ONLY = args.includes('--pii-only')
const JAPANESE_ONLY = args.includes('--japanese-only')
const META_ONLY = args.includes('--meta-only')
const STRICT = args.includes('--strict')  // Treat warnings (Japanese) as errors
const RUN_ALL = !PII_ONLY && !JAPANESE_ONLY && !META_ONLY

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.css']

// Relative paths excluded from Japanese character checks.
// These files legitimately contain Japanese for:
//   - i18n dictionaries (ja.ts, initial-prompts.ts, upgrade-prompts.ts)
//   - CLAUDE.md parsing regex (settings-reader.ts, agent-reader.ts)
//   - Security inspection patterns (recipe-inspector.ts)
//   - Agent prompt templates (app-creation-prompt.ts, recipe-applicator.ts)
const JAPANESE_EXCLUDE = new Set([
  'src/renderer/i18n/ja.ts',
  'src/renderer/i18n/en.ts',       // language endonyms are intentional
  'src/server/services/initial-prompts.ts',
  'src/server/services/upgrade-prompts.ts',
  'src/shared/app-creation-prompt.ts',  // agent prompt template (ja-fixed for v0.1.0)
  'src/shared/app-removal-prompt.ts',   // agent prompt template (ja-fixed for v0.1.0; DEC-024 #3 app removal)
  'src/server/recipe-applicator.ts',    // agent prompt template (ja-fixed for v0.1.0; v2.0 install handover)
  'src/server/settings-reader.ts',
  'src/server/agent-reader.ts',
  'src/server/recipe-inspector.ts',
  'tools/check-release-hygiene.mjs', // contains Japanese patterns for meta-note detection
])

// Path prefixes excluded from Japanese character checks.
// tests/ is developer-facing test code that does not impact OSS end-user UX,
// so Japanese describe/it identifiers are allowed there.
const JAPANESE_EXCLUDE_PREFIXES = [
  'templates/agents/',
  'tests/',
]

// Personal information patterns (always error)
const PII_PATTERNS = [
  { label: 'irikura', regex: /irikura/i },
  { label: '@Zenbook', regex: /@Zenbook/i },
  { label: 'REDACTED', regex: /REDACTED/i },
  { label: '@gmail.com', regex: /@gmail\.com/i },
  { label: '/home/user', regex: /\/home\/irikura/i },
]

// Japanese character ranges (Hiragana + Katakana + CJK Unified Ideographs)
const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/


// Internal meta-note patterns that should not appear in OSS release content.
// ERROR-level patterns cause CI failure (scanned per line).
const META_ERROR_PATTERNS = [
  { label: '叩き台 (draft/scaffold)', regex: /叩き台/ },
  { label: '(draft)', regex: /\(draft\)/i },
  { label: '改訂履歴 (revision history)', regex: /改訂履歴/ },
]

// ERROR-level pattern that requires multi-line context (scanned against full content).
// Matches "Revision history" as a heading followed within a few lines by a table header.
const META_ERROR_MULTILINE = [
  { label: 'Revision history table', regex: /Revision\s+history[^\n]*\n(?:[^\n]*\n){0,3}\s*\|/i },
]

// WARNING-level patterns are logged but do not fail the check.
const META_WARN_PATTERNS = [
  { label: 'TODO/FIXME/XXX/TBD', regex: /(^|\s)(?:TODO:|FIXME:|XXX:|TBD\b)/ },
  { label: 'biz-dev (internal team)', regex: /biz-dev/i },
  { label: 'kovito-hq (internal repo)', regex: /kovito-hq/i },
]

// Directories and files scanned for internal meta-note patterns.
const META_SCAN_TARGETS = [
  'templates/',
  'docs/agent-ref/',
  'app.example/',
  'recipes/',
  'README.md',
  'CONTRIBUTING.md',
]

// Paths excluded from meta-note scanning.
const META_EXCLUDE_PREFIXES = [
  'tests/',
  'docs/specs/',
  'node_modules/',
  'dist/',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get git-tracked files matching given extensions.
 * @param {string[]} extensions - file extensions to match (e.g. ['.ts', '.tsx'])
 * @returns {string[]} list of relative file paths
 */
function getTrackedSourceFiles(extensions) {
  try {
    const output = execSync('git ls-files', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output
      .trim()
      .split('\n')
      .filter(f => f && extensions.some(ext => f.endsWith(ext)))
  } catch {
    return []
  }
}

/**
 * Get all git-tracked text files (excludes known binary extensions).
 * @returns {string[]}
 */
function getAllTrackedTextFiles() {
  const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'])
  try {
    const output = execSync('git ls-files', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output
      .trim()
      .split('\n')
      .filter(f => {
        if (!f) return false
        const ext = f.substring(f.lastIndexOf('.'))
        return !BINARY_EXTS.has(ext)
      })
  } catch {
    return []
  }
}

/**
 * Check if a file path is excluded from Japanese checks.
 * @param {string} relPath
 * @returns {boolean}
 */
function isJapaneseExcluded(relPath) {
  if (JAPANESE_EXCLUDE.has(relPath)) return true
  return JAPANESE_EXCLUDE_PREFIXES.some(prefix => relPath.startsWith(prefix))
}

/**
 * Scan a file for regex matches, returning line-level hits.
 * @param {string} filePath - absolute path
 * @param {RegExp} pattern
 * @returns {{ line: number, text: string }[]}
 */
function scanFile(filePath, pattern) {
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
 * Returns the line number of the first character of each match.
 * @param {string} filePath - absolute path
 * @param {RegExp} pattern - regex to match (should NOT have 'g' flag; a copy with 'g' is used)
 * @returns {{ line: number, text: string }[]}
 */
function scanFileMultiline(filePath, pattern) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    const hits = []
    let match
    while ((match = globalPattern.exec(content)) !== null) {
      // Count newlines before the match to determine line number
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
 * @returns {string[]} list of relative file paths
 */
function getMetaScanFiles() {
  const allFiles = getAllTrackedTextFiles()
  return allFiles.filter(f => {
    // Must be inside one of the target directories or match a target file
    const isTarget = META_SCAN_TARGETS.some(t =>
      t.endsWith('/') ? f.startsWith(t) : f === t
    )
    if (!isTarget) return false
    // Must not be in an excluded prefix
    const isExcluded = META_EXCLUDE_PREFIXES.some(prefix => f.startsWith(prefix))
    return !isExcluded
  })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let warnings = 0
let errors = 0

function warn(msg) {
  if (STRICT) {
    // In strict mode (CI), warnings become errors
    console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
    errors++
  } else {
    console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`)
    warnings++
  }
}

function error(msg) {
  console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
  errors++
}

// --- Check 1: Japanese characters in source files ---
if (RUN_ALL || JAPANESE_ONLY) {
  console.log('\n\x1b[1m[1/5] Japanese character detection\x1b[0m')

  const sourceFiles = getTrackedSourceFiles(SOURCE_EXTENSIONS)
    .filter(f => !isJapaneseExcluded(f))

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

// --- Check 2: Personal information patterns ---
if (RUN_ALL || PII_ONLY) {
  console.log('\n\x1b[1m[2/5] Personal information detection\x1b[0m')

  const allTextFiles = getAllTrackedTextFiles()
  let piiFound = false

  for (const { label, regex } of PII_PATTERNS) {
    for (const file of allTextFiles) {
      // Skip this hygiene script itself
      if (file === 'tools/check-release-hygiene.mjs') continue
      const hits = scanFile(join(ROOT, file), regex)
      if (hits.length > 0) {
        piiFound = true
        for (const hit of hits) {
          error(`PII "${label}" found: ${file}:${hit.line}`)
        }
      }
    }
  }

  if (!piiFound) {
    console.log('  \x1b[32mOK\x1b[0m    No personal information patterns found')
  }
}

// --- Check 3: docs/specs/ directory ---
if (RUN_ALL) {
  console.log('\n\x1b[1m[3/5] docs/specs/ directory check\x1b[0m')

  const specsDir = join(ROOT, 'docs', 'specs')
  if (existsSync(specsDir)) {
    error('docs/specs/ directory exists — should be removed (internal docs only)')
  } else {
    console.log('  \x1b[32mOK\x1b[0m    docs/specs/ does not exist')
  }
}

// --- Check 4: Internal meta-note patterns ---
if (RUN_ALL || META_ONLY) {
  console.log('\n\x1b[1m[4/5] Internal meta-note detection\x1b[0m')

  const metaFiles = getMetaScanFiles()
  let metaErrorCount = 0
  let metaWarnCount = 0

  for (const file of metaFiles) {
    // Skip this hygiene script itself (it defines the patterns)
    if (file === 'tools/check-release-hygiene.mjs') continue

    const absPath = join(ROOT, file)

    // Check ERROR-level patterns (per-line)
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

    // Check ERROR-level patterns (multi-line context)
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

    // Check WARNING-level patterns
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

// --- Check 5: License consistency ---
if (RUN_ALL) {
  console.log('\n\x1b[1m[5/5] License consistency check\x1b[0m')

  const EXPECTED_LICENSE = 'AGPL-3.0-or-later'
  const EXPECTED_AUTHOR = 'Anode LLC'
  const EXPECTED_LICENSE_MARKER = 'GNU AFFERO GENERAL PUBLIC LICENSE'

  // Check package.json license / author fields
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

  // Check LICENSE file existence and AGPL marker
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

  // Check source file headers (SPDX-License-Identifier) for all eligible files.
  // Auto-fix path: lefthook pre-commit `license-header` hook + scripts/add-license-header.mjs
  // Detection path: this check (also runs in CI as a safety net)
  const HEADER_TARGET_EXTS = ['.ts', '.tsx', '.mjs', '.js']
  // Paths excluded from header check.
  // - tests/fixtures/projects/: synthetic project fixtures emulating user repos;
  //   these files represent end-user content, not KovitoBoard source.
  const HEADER_EXCLUDE_PREFIXES = [
    'tests/fixtures/projects/',
  ]
  const headerTargets = getTrackedSourceFiles(HEADER_TARGET_EXTS).filter(
    (f) => !HEADER_EXCLUDE_PREFIXES.some((p) => f.startsWith(p))
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n\x1b[1m--- Summary ---\x1b[0m')
if (errors > 0) {
  console.log(`  \x1b[31m${errors} error(s)\x1b[0m, ${warnings} warning(s)`)
  console.log('  Release hygiene check \x1b[31mFAILED\x1b[0m\n')
  process.exit(1)
} else if (warnings > 0) {
  console.log(`  ${warnings} warning(s), 0 errors`)
  console.log('  Release hygiene check \x1b[33mPASSED with warnings\x1b[0m\n')
  process.exit(0)
} else {
  console.log('  All checks passed')
  console.log('  Release hygiene check \x1b[32mPASSED\x1b[0m\n')
  process.exit(0)
}
