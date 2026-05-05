/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * version-info — collect and expose KB / Claude Code version metadata
 * for the version-display feature (`v0.1.0-version-display.md`).
 *
 * Aggregates three sources:
 *   - KB version  → `package.json#version` (DEC-019). Read once at
 *                   startup; in-memory thereafter.
 *   - Claude Code → `claude --version` shell-out (existing R3-3 path,
 *                   `v0.1.0-trust-prompt-resilience.md`). Cached in
 *                   memory after first detection.
 *   - Tier        → primary / best-effort / out-of-range computed
 *                   against trust-patterns.json (DEC-015).
 *
 * Disabled-by resolution per spec §3.3:
 *   - `KOVITO_NO_VERSION_CHECK=1` → "env" (highest priority)
 *   - setting.json `versionCheck.enabled === false` → "config"
 *   - otherwise → null (enabled)
 *
 * The module is deliberately framework-agnostic — the API router and
 * the GitHub Releases client compose on top of the read functions
 * here.
 */
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { FileAccessLayer } from './fs-layer'
import { readSetting } from './setting-manager'
import { lazyChildLogger } from './logger'

const log = lazyChildLogger('version-info')

export type ClaudeCodeTier = 'primary' | 'best-effort' | 'out-of-range' | 'unknown'

export interface ClaudeCodeVersionInfo {
  /** Detected version string, e.g. "2.1.117". `null` when detection failed. */
  detected: string | null
  /** Tested version declared in trust-patterns.json (DEC-015). */
  primaryTested: string
  /** Resolved tier. `unknown` when detection failed. */
  tier: ClaudeCodeTier
}

export interface VersionInfoSnapshot {
  kb: { current: string }
  claudeCode: ClaudeCodeVersionInfo
}

export type DisabledBy = 'env' | 'config' | null

/** ENV switch — checked at every read so unsetting + reload reflects. */
const ENV_FLAG = 'KOVITO_NO_VERSION_CHECK'

// -----------------------------------------------------------------------------
// KB version (read once at startup)
// -----------------------------------------------------------------------------

let cachedKbVersion: string | null = null

/**
 * Read the KB version from KovitoBoard's own `package.json`. The path is
 * resolved relative to this module's own file location (via
 * `import.meta.url`), walking two levels up:
 *   - `src/server/version-info.ts`  → `<kbRoot>` (npm run dev)
 *   - `dist/server/version-info.js` → `<kbRoot>` (built)
 *
 * The end-user project root is intentionally NOT used here — that
 * directory does not contain KovitoBoard's package.json. Falls back to
 * "unknown" on read failure rather than throwing — version-display is
 * non-essential.
 */
export function loadKbVersion(fs: FileAccessLayer): string {
  if (cachedKbVersion) return cachedKbVersion
  try {
    const here = fileURLToPath(import.meta.url)
    const kbRoot = join(dirname(here), '..', '..')
    const pkgPath = join(kbRoot, 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    cachedKbVersion = pkg.version ?? 'unknown'
  } catch (err) {
    log.warn({ err }, 'Failed to read KB version from package.json')
    cachedKbVersion = 'unknown'
  }
  return cachedKbVersion
}

/** Reset cached KB version (test-only). */
export function _resetKbVersionCacheForTests(): void {
  cachedKbVersion = null
}

// -----------------------------------------------------------------------------
// Claude Code version (cached after first detection)
// -----------------------------------------------------------------------------

let cachedClaudeCode: ClaudeCodeVersionInfo | null = null

/**
 * Detect Claude Code version + tier. Memoizes the result for the
 * lifetime of the process (matches existing R3-3 behavior — `claude
 * --version` is invoked once at startup and considered stable).
 *
 * Compatibility note: this replaces the side-effect-only
 * `checkClaudeCodeVersion` from index.ts. The console-warn output is
 * preserved for backward compatibility (L3 manual tests + ops grep
 * existing log lines). Callers may choose to suppress logging by
 * passing { silent: true } when only the value is needed.
 */
export function detectClaudeCodeVersion(
  primaryTested: string,
  bestEffortVersions: string[],
  options: { silent?: boolean } = {},
): ClaudeCodeVersionInfo {
  if (cachedClaudeCode) return cachedClaudeCode

  let raw: string
  try {
    raw = execFileSync('claude', ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    if (!options.silent) {
      log.warn(
        'Could not detect Claude Code version (binary not found or --version failed). KovitoBoard will continue, but trust-prompt detection may behave unexpectedly.',
      )
    }
    cachedClaudeCode = { detected: null, primaryTested, tier: 'unknown' }
    return cachedClaudeCode
  }

  const match = raw.match(/(\d+\.\d+\.\d+)/)
  if (!match) {
    if (!options.silent) {
      log.warn({ raw }, 'Could not parse Claude Code version output.')
    }
    cachedClaudeCode = { detected: null, primaryTested, tier: 'unknown' }
    return cachedClaudeCode
  }

  const detected = match[1]
  const tier = resolveClaudeCodeTier(detected, primaryTested, bestEffortVersions)

  if (!options.silent) {
    if (tier === 'primary') {
      log.info({ installed: detected }, 'Claude Code detected (primary tested version).')
    } else if (tier === 'best-effort') {
      log.info(
        { installed: detected, primaryTested },
        'Claude Code is in best-effort range (not the primary tested version).',
      )
    } else {
      log.warn(
        { installed: detected, primaryTested },
        'Claude Code version is outside the supported range. Trust-prompt detection may not work correctly.',
      )
    }
  }

  cachedClaudeCode = { detected, primaryTested, tier }
  return cachedClaudeCode
}

/** Reset cached Claude Code detection (test-only). */
export function _resetClaudeCodeCacheForTests(): void {
  cachedClaudeCode = null
}

/**
 * Tier resolution per DEC-015 / spec §4.3.
 *
 * `bestEffortVersions` entries are interpreted as `<major>.<minor>.x`
 * shorthands (the only form trust-patterns.json currently uses). A
 * full semver-range parser would be overkill — and adding `node-semver`
 * just for this would inflate the dependency footprint.
 */
export function resolveClaudeCodeTier(
  detected: string,
  primaryTested: string,
  bestEffortVersions: string[],
): ClaudeCodeTier {
  if (detected === primaryTested) return 'primary'
  for (const range of bestEffortVersions) {
    if (matchesMajorMinorX(detected, range)) return 'best-effort'
  }
  return 'out-of-range'
}

/** True when `version` matches a `major.minor.x` shorthand (e.g.
 *  "2.1.117" matches "2.1.x"). Returns false for ranges that aren't
 *  in the major.minor.x form. */
export function matchesMajorMinorX(version: string, range: string): boolean {
  if (!range.endsWith('.x')) return false
  const prefix = range.slice(0, -1)  // "2.1.x" → "2.1."
  // Guard: prefix must be `<num>.<num>.`
  if (!/^\d+\.\d+\.$/.test(prefix)) return false
  return version.startsWith(prefix)
}

// -----------------------------------------------------------------------------
// Disabled-by resolution
// -----------------------------------------------------------------------------

/**
 * Resolve whether version checking is disabled, and by which mechanism.
 * Spec §3.3 priority: env > config > default-on.
 */
export function resolveDisabledBy(fs: FileAccessLayer): DisabledBy {
  if (process.env[ENV_FLAG] === '1') return 'env'
  const setting = readSetting(fs)
  if (setting?.versionCheck?.enabled === false) return 'config'
  return null
}

/**
 * Return the effective TTL in hours from setting.json, falling back to
 * the spec-default 24 hours.
 */
export function resolveTtlHours(fs: FileAccessLayer): number {
  const setting = readSetting(fs)
  const ttl = setting?.versionCheck?.ttlHours
  if (typeof ttl === 'number' && ttl >= 1 && ttl <= 168) return ttl
  return 24
}

// -----------------------------------------------------------------------------
// Aggregator (used by the API router)
// -----------------------------------------------------------------------------

/**
 * Build a fresh snapshot of {KB, Claude Code} versions. Pure read —
 * does not perform external network calls. The GitHub Releases data
 * is layered on top by the API router using
 * `github-releases-client.getCachedRelease()`.
 */
export function getVersionInfoSnapshot(
  fs: FileAccessLayer,
  trustPatterns: { primaryTestedVersion: string; bestEffortVersions: string[] },
): VersionInfoSnapshot {
  return {
    kb: { current: loadKbVersion(fs) },
    claudeCode: detectClaudeCodeVersion(
      trustPatterns.primaryTestedVersion,
      trustPatterns.bestEffortVersions,
      { silent: true },  // initial detection already logged at startup
    ),
  }
}
