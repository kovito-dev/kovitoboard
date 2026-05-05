/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * github-releases-client — fetch the latest KovitoBoard release from
 * the GitHub Releases API, with on-disk TTL caching and fail-silent
 * error handling (`v0.1.0-version-display.md` §4.4).
 *
 * Design notes:
 *   - Spec §3.6 categorizes this call as telemetry-policy stage 1
 *     (indirect signal). The User-Agent is mandatory both for GitHub
 *     compliance (anonymous fetches without one are 403'd) and for
 *     stage-2 forward compatibility.
 *   - Cache lives at `<projectRoot>/.kovitoboard/version-cache.json`
 *     and survives restarts. TTL is the user-configurable
 *     `versionCheck.ttlHours` (default 24 h), so a single user can
 *     opt into more frequent checks without code changes.
 *   - 429 / 403 / network / parse errors all collapse to fail-silent:
 *     the cache file is updated with `{ fetchSucceeded: false }` so
 *     readers can show the "couldn't reach upstream" affordance
 *     rather than a hard error UI.
 *   - `KOVITO_NO_VERSION_CHECK=1` short-circuits before any network
 *     call. The cache is never read or written in that mode either,
 *     to match telemetry-policy "no external network at all" intent.
 */
import { join } from 'path'
import { platform } from 'os'
import type { FileAccessLayer } from './fs-layer'
import { getKovitoboardDir } from './paths'
import { resolveDisabledBy, resolveTtlHours } from './version-info'
import { lazyChildLogger } from './logger'

const log = lazyChildLogger('github-releases-client')

const RELEASES_URL = 'https://api.github.com/repos/kovito-dev/kovitoboard/releases/latest'
const CACHE_FILENAME = 'version-cache.json'
const FETCH_TIMEOUT_MS = 5_000

export interface ReleaseCacheEntry {
  /** ISO 8601 timestamp the fetch was attempted. */
  checkedAt: string
  /** GitHub `tag_name` field (e.g. "v0.1.1"). null when fetch failed. */
  latestTag: string | null
  /** True when the upstream fetch returned 200 + parseable JSON. */
  fetchSucceeded: boolean
  /** Source identifier for spec §4.6 forward compatibility (v0.1.x
   *  may switch to "kovito-api" without rewriting the cache shape). */
  source: 'github-releases'
}

/** Build the User-Agent mandated by spec §3.5. Kept pure so unit tests
 *  can verify the format without monkey-patching `os.platform`. */
export function buildUserAgent(kbVersion: string, opts?: {
  platform?: string
  nodeVersion?: string
}): string {
  const plat = opts?.platform ?? platform()
  const nodeVer = opts?.nodeVersion ?? process.versions.node
  const [major = '0', minor = '0'] = nodeVer.split('.')
  return `KovitoBoard/${kbVersion} (${plat}; node-${major}.${minor})`
}

/** Resolve the on-disk cache path. Exposed for tests. */
export function getCachePath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), CACHE_FILENAME)
}

/**
 * Read the cached release entry. Returns null when the file does not
 * exist or is malformed.
 */
export function readCache(fs: FileAccessLayer): ReleaseCacheEntry | null {
  const path = getCachePath(fs)
  if (!fs.existsSync(path)) return null
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as Partial<ReleaseCacheEntry>
    if (typeof data.checkedAt !== 'string') return null
    if (typeof data.fetchSucceeded !== 'boolean') return null
    if (data.source !== 'github-releases') return null
    if (data.latestTag !== null && typeof data.latestTag !== 'string') return null
    return data as ReleaseCacheEntry
  } catch {
    return null
  }
}

function writeCache(fs: FileAccessLayer, entry: ReleaseCacheEntry): void {
  const dir = getKovitoboardDir(fs)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getCachePath(fs), JSON.stringify(entry, null, 2) + '\n', 'utf-8')
}

/** True when the cache entry is younger than the configured TTL. */
export function isCacheFresh(entry: ReleaseCacheEntry, ttlHours: number): boolean {
  const checked = Date.parse(entry.checkedAt)
  if (Number.isNaN(checked)) return false
  const ageMs = Date.now() - checked
  return ageMs < ttlHours * 60 * 60 * 1000
}

interface FetchOptions {
  /** Bypass the cache (used by `POST /api/version/recheck`). */
  force?: boolean
  /** KB version, threaded into the User-Agent. */
  kbVersion: string
  /** Override fetch (test injection). */
  fetchImpl?: typeof fetch
}

/**
 * Public entry: return the latest release info, using the cache when
 * fresh and the configured-disabled flag wins everything.
 *
 * Returns `null` when version checking is disabled — callers surface
 * this as `disabledBy: "env"|"config"` separately.
 */
export async function getLatestRelease(
  fs: FileAccessLayer,
  options: FetchOptions,
): Promise<ReleaseCacheEntry | null> {
  if (resolveDisabledBy(fs) !== null) return null

  if (!options.force) {
    const cached = readCache(fs)
    const ttl = resolveTtlHours(fs)
    if (cached && isCacheFresh(cached, ttl)) return cached
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const userAgent = buildUserAgent(options.kbVersion)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let entry: ReleaseCacheEntry
  try {
    const res = await fetchImpl(RELEASES_URL, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/vnd.github+json',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      // 429 / 403 / 5xx → fail-silent (spec §3.4)
      log.warn(
        { status: res.status, statusText: res.statusText },
        'GitHub Releases fetch returned non-2xx; falling back silently',
      )
      entry = makeFailureEntry()
    } else {
      const json = (await res.json()) as { tag_name?: string }
      const tag = typeof json.tag_name === 'string' ? json.tag_name : null
      entry = {
        checkedAt: new Date().toISOString(),
        latestTag: tag,
        fetchSucceeded: tag !== null,
        source: 'github-releases',
      }
      if (!tag) {
        log.warn({ json }, 'GitHub Releases response missing tag_name')
      }
    }
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'GitHub Releases fetch failed; falling back silently')
    entry = makeFailureEntry()
  } finally {
    clearTimeout(timer)
  }

  // Persist even on failure so the UI can render "couldn't reach upstream"
  // instead of suggesting an "in-progress" state forever.
  try {
    writeCache(fs, entry)
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'Failed to write version-cache.json (non-fatal)')
  }
  return entry
}

function makeFailureEntry(): ReleaseCacheEntry {
  return {
    checkedAt: new Date().toISOString(),
    latestTag: null,
    fetchSucceeded: false,
    source: 'github-releases',
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// -----------------------------------------------------------------------------
// SemVer comparison helpers
// -----------------------------------------------------------------------------

/**
 * Compare two SemVer strings. Returns:
 *   -1 if `a < b`,  0 if `a === b`,  +1 if `a > b`.
 *
 * Strips a leading `v` so "v0.1.1" and "0.1.1" compare equal.
 * Pre-release tags (e.g. "0.1.1-rc.0") are compared lexicographically
 * after the numeric core; for the version-display use case this is
 * good enough — we only need "is the upstream tag newer than us".
 *
 * A node-semver dependency would be heavier than this 30-line
 * function and we don't need range matching here.
 */
export function compareSemver(a: string, b: string): number {
  const stripV = (s: string): string => (s.startsWith('v') ? s.slice(1) : s)
  const aClean = stripV(a)
  const bClean = stripV(b)

  const [aCore, ...aPre] = aClean.split('-')
  const [bCore, ...bPre] = bClean.split('-')

  const aParts = aCore.split('.').map((n) => Number.parseInt(n, 10))
  const bParts = bCore.split('.').map((n) => Number.parseInt(n, 10))

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ai = aParts[i] ?? 0
    const bi = bParts[i] ?? 0
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      // Malformed core → fall back to string compare for safety
      return aCore.localeCompare(bCore)
    }
    if (ai !== bi) return ai < bi ? -1 : 1
  }

  // Equal cores: any pre-release tag means "older" than the bare release.
  const aHasPre = aPre.length > 0
  const bHasPre = bPre.length > 0
  if (aHasPre && !bHasPre) return -1
  if (!aHasPre && bHasPre) return 1
  if (!aHasPre && !bHasPre) return 0
  return aPre.join('-').localeCompare(bPre.join('-'))
}

/** True when `latest` is newer than `current`. */
export function isOutdated(current: string, latestTag: string | null): boolean {
  if (!latestTag) return false
  return compareSemver(current, latestTag) < 0
}
