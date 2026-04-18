#!/usr/bin/env node

// Release hygiene checker for KovitoBoard OSS repository.
// Validates that the repo is clean for public release:
//   1. No Japanese characters in source files (except i18n/ja.ts)
//   2. No personal information patterns
//   3. No docs/specs/ directory

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.css']

// Relative paths excluded from Japanese character checks.
// These files legitimately contain Japanese for:
//   - i18n dictionaries (ja.ts, initial-prompts.ts)
//   - CLAUDE.md parsing regex (settings-reader.ts, agent-reader.ts)
//   - Security inspection patterns (recipe-inspector.ts)
const JAPANESE_EXCLUDE = new Set([
  'src/renderer/i18n/ja.ts',
  'src/server/services/initial-prompts.ts',
  'src/server/settings-reader.ts',
  'src/server/agent-reader.ts',
  'src/server/recipe-inspector.ts',
])

// Path prefixes excluded from Japanese character checks
const JAPANESE_EXCLUDE_PREFIXES = [
  'templates/agents/',
]

// Personal information patterns (always error)
const PII_PATTERNS = [
  { label: 'irikura', regex: /irikura/i },
  { label: '@Zenbook', regex: /@Zenbook/i },
  { label: 'orolira', regex: /orolira/i },
  { label: '@gmail.com', regex: /@gmail\.com/i },
  { label: '/home/irikura', regex: /\/home\/irikura/i },
]

// Japanese character ranges (Hiragana + Katakana + CJK Unified Ideographs)
const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/

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

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let warnings = 0
let errors = 0

function warn(msg) {
  console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`)
  warnings++
}

function error(msg) {
  console.log(`  \x1b[31mERROR\x1b[0m ${msg}`)
  errors++
}

// --- Check 1: Japanese characters in source files ---
console.log('\n\x1b[1m[1/3] Japanese character detection\x1b[0m')

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

// --- Check 2: Personal information patterns ---
console.log('\n\x1b[1m[2/3] Personal information detection\x1b[0m')

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

// --- Check 3: docs/specs/ directory ---
console.log('\n\x1b[1m[3/3] docs/specs/ directory check\x1b[0m')

const specsDir = join(ROOT, 'docs', 'specs')
if (existsSync(specsDir)) {
  error('docs/specs/ directory exists — should be removed (internal docs only)')
} else {
  console.log('  \x1b[32mOK\x1b[0m    docs/specs/ does not exist')
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
