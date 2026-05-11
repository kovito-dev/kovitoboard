/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App-id collision detection — implements the logic behind
 * `POST /api/apps/check-id-availability`.
 *
 * The endpoint is the gate that prevents two apps in the same
 * KovitoBoard project from accidentally sharing an `appId`. An
 * `appId` collision causes data corruption (multiple apps writing
 * into the same `app/data/<appId>/`), menu duplication, and
 * dispatcher confusion, so the contract is:
 *
 *   - The agent proposes an `appId` candidate (e.g. derived from a
 *     recipe's `menu[0].id`, or a user-typed name).
 *   - The server checks four namespaces in parallel: existing
 *     `app/menu.ts` entries, `app/<id>/` directories, `app/data/<id>/`
 *     directories, and `recipes-installed/<id>/` history (so a
 *     previously uninstalled recipe still occupies its appId per
 *     the spec's once installed, considered installed forever rule).
 *   - When a collision is found, we suggest a `<base>-2` /
 *     `<base>-3` / ... candidate, retrying up to 100 times before
 *     giving up.
 *
 * The four namespaces share a single source of truth here so the
 * uninstall / reinstall / app-create flows all see the same answer.
 *
 * Spec: docs/specs/v0.1.0-app-id-and-manifest.md §3.1
 */
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { parseMenuTs } from './menu-extractor'
import { MAX_APP_ID_LENGTH } from '../../shared/security-limits'

/**
 * Format constraint matching the spec §3.1 regex. The total length
 * cap derives from the shared `MAX_APP_ID_LENGTH` SSOT in
 * `src/shared/security-limits.ts` so both this collision-checker
 * and `markInstalledValidator.ts` stay in lockstep with L-R6 when
 * the ceiling moves.
 *   - one mandatory leading lowercase letter
 *   - up to `MAX_APP_ID_LENGTH - 1` trailing `[a-z0-9-]` characters
 */
export const APP_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$`,
)

/**
 * Maximum number of suffix-numbered candidates to try before giving
 * up. Anything beyond this likely indicates either a bug or a
 * project that has been cycled through hundreds of installs of the
 * same recipe — neither case should be silently papered over by
 * generating an even longer suffix.
 */
export const SUFFIX_MAX_INDEX = 100

/**
 * Validation outcome for an inbound `proposedId`. Separate from the
 * "available?" answer because a 400 (format error) and a
 * `available: false` (collision) need to be distinguishable to the
 * caller.
 */
export type IdFormatResult =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string }

/**
 * Validate that `proposedId` matches the spec format. Returns a
 * structured result rather than throwing so the API handler can
 * map it to a 400 response.
 */
export function validateProposedAppId(value: unknown): IdFormatResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { kind: 'invalid', reason: 'proposedId must be a non-empty string' }
  }
  if (!APP_ID_PATTERN.test(value)) {
    return {
      kind: 'invalid',
      reason:
        'proposedId must match /^[a-z][a-z0-9-]{0,63}$/ ' +
        '(lowercase letters / digits / hyphens, starting with a letter, ≤64 chars)',
    }
  }
  return { kind: 'valid' }
}

/**
 * Outcome of `findAvailableAppId`. Mirrors the wire shape of
 * `CheckIdAvailabilityResponse` (spec §3.1) so the API handler can
 * forward it almost verbatim.
 */
export type AvailabilityResult =
  | { available: true }
  | { available: false; suggested: string; reason: string }
  | { available: false; suggested: null; reason: string }

/**
 * Check whether `proposedId` is available; if not, return the first
 * `<base>-N` suffix variant that is.
 *
 * The four namespaces examined:
 *   - `app/menu.ts` `menuEntries[].id` — surface menu identity
 *   - `app/<id>/`                       — UI / artifact directory
 *   - `app/data/<id>/`                  — own-data root
 *   - `recipes-installed/<id>/`         — past install history
 *
 * Caller is expected to have run `validateProposedAppId` first; if
 * not, the function still won't exceed `SUFFIX_MAX_INDEX` but the
 * suggested string may not satisfy the format regex (e.g. an empty
 * `proposedId` would produce `-2`, which is rejected at the API
 * boundary).
 */
export function findAvailableAppId(
  fs: FileAccessLayer,
  projectRoot: string,
  proposedId: string,
): AvailabilityResult {
  // Build the "taken" set lazily — we want this scan to happen at
  // most once per request, not once per candidate.
  const taken = collectTakenAppIds(fs, projectRoot)

  if (!taken.has(proposedId)) {
    return { available: true }
  }

  // Walk the suffix sequence looking for an opening.
  for (let i = 2; i <= SUFFIX_MAX_INDEX; i++) {
    const suffix = `-${i}`
    // Trim the base id so the result still fits in the shared
    // `MAX_APP_ID_LENGTH` ceiling. The constant is the SSOT for
    // L-R6, so changing it in `security-limits.ts` automatically
    // updates the suffix-trim logic here.
    const base =
      proposedId.length + suffix.length > MAX_APP_ID_LENGTH
        ? proposedId.slice(0, MAX_APP_ID_LENGTH - suffix.length)
        : proposedId
    const candidate = `${base}${suffix}`
    // Defensive: if the trim landed us on a hyphen tail, skip.
    if (candidate.endsWith('--')) continue
    if (!APP_ID_PATTERN.test(candidate)) continue
    if (!taken.has(candidate)) {
      return {
        available: false,
        suggested: candidate,
        reason: `"${proposedId}" is already taken; suggesting "${candidate}".`,
      }
    }
  }

  return {
    available: false,
    suggested: null,
    reason:
      `"${proposedId}" is taken and no free suffix-numbered ` +
      `candidate was found within ${SUFFIX_MAX_INDEX} tries.`,
  }
}

/**
 * Build the union of "already-taken" app ids in the project.
 *
 * Exported for unit-testability — production callers should use
 * `findAvailableAppId` instead, which composes this with the
 * suffix search.
 */
export function collectTakenAppIds(
  fs: FileAccessLayer,
  projectRoot: string,
): Set<string> {
  const taken = new Set<string>()

  // Source 1: app/menu.ts entries.
  //
  // We deliberately read the file via the passed-in `projectRoot`
  // rather than calling `readUserMenuEntries(fs)` (which resolves
  // its own project root via `config.ts`). Plumbing the project
  // root through everywhere keeps this function pure / testable.
  const menuPath = join(projectRoot, 'app', 'menu.ts')
  if (fs.existsSync(menuPath)) {
    try {
      const content = fs.readFileSync(menuPath, 'utf-8')
      for (const entry of parseMenuTs(content)) {
        taken.add(entry.id)
      }
    } catch {
      /* ignore unreadable menu.ts — other sources still apply */
    }
  }

  // Source 2: app/<id>/ directories. Read the immediate children
  // of `app/`; ignore non-directory entries (the menu-extractor
  // covers files like `menu.ts`).
  const appDir = join(projectRoot, 'app')
  if (fs.existsSync(appDir)) {
    try {
      for (const name of fs.readdirSync(appDir)) {
        // Skip the well-known non-app entries that live alongside
        // app/<id>/ subdirs but are not themselves app ids.
        if (name === 'menu.ts' || name === 'data' || name === 'styles') continue
        const childPath = join(appDir, name)
        try {
          const stat = fs.statSync(childPath)
          // We treat anything with a non-zero size as "consider taken"
          // even if it isn't a directory — better safe than sorry, and
          // a regular file in app/ named e.g. `notes` should not be
          // collision-overwritten.
          if (stat) taken.add(name)
        } catch {
          /* ignore stat failures */
        }
      }
    } catch {
      /* readdir failed — leave this source out, others still apply */
    }
  }

  // Source 3: app/data/<id>/ — own-data roots. Each one is a
  // first-class taken id even if no menu entry references it
  // (e.g. a half-installed recipe that crashed before menu.ts
  // was edited).
  const dataDir = join(appDir, 'data')
  if (fs.existsSync(dataDir)) {
    try {
      for (const name of fs.readdirSync(dataDir)) {
        taken.add(name)
      }
    } catch {
      /* same as above */
    }
  }

  // Source 4: recipes-installed/<id>/ — every past install,
  // including ones that have been uninstalled (the directory may
  // linger in some recovery states, and the spec treats history
  // as definitive: once installed, considered installed forever).
  // Same rationale as Source 1: resolve the path from the passed
  // `projectRoot` rather than calling `getKovitoboardDir(fs)`.
  const installedDir = join(projectRoot, '.kovitoboard', 'recipes-installed')
  if (fs.existsSync(installedDir)) {
    try {
      for (const name of fs.readdirSync(installedDir)) {
        taken.add(name)
      }
    } catch {
      /* same as above */
    }
  }

  return taken
}
