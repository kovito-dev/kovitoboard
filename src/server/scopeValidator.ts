/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Scope Validator — maps scope to path and enforces exclusion lists.
 *
 * Called from the handler dispatcher to ensure, before handler execution,
 * that the path is within an approved scope's region and is not on the
 * exclusion list.
 *
 * The exclusion list is managed in **this one place only**.
 * Individual handlers must not perform their own exclusion checks.
 *
 * @see recipe-system.md §12-3 (scope definitions)
 * @see recipe-system.md §12-3-1 (hardcoded exclusion list)
 * @see recipe-backend-implementation-plan.md §8-2 principle 3
 * @stable v0.1.0
 */

import * as path from 'path'
import type { Scope, HandlerErrorCode } from './handlers/types.js'
import {
  normalizePath,
  resolveScopeRoot,
  isWithin,
  isClaudeMdPath,
  PathResolutionError,
  realpathUpToExisting,
} from './pathResolver.js'

// =========================================
// Exclusion patterns
// =========================================

/**
 * Hardcoded exclusion patterns (common across all scopes).
 *
 * Matched against the relative portion of the path (relative to project root).
 * @see recipe-system.md §12-3-1
 */
const EXCLUSION_MATCHERS: Array<(relativePath: string) => boolean> = [
  // .env (exact match)
  (rel) => rel === '.env',
  // .env.* (.env.production, .env.local, etc.)
  (rel) => rel.startsWith('.env.'),
  // Nested .env* files (e.g. subdir/.env)
  (rel) => {
    const basename = path.basename(rel)
    return basename === '.env' || basename.startsWith('.env.')
  },
  // Everything under .git/
  (rel) => rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\'),
  // Everything under node_modules/
  (rel) => rel === 'node_modules' || rel.startsWith('node_modules/') || rel.startsWith('node_modules\\'),
  // .claude/credentials*
  (rel) => {
    const normalized = rel.replace(/\\/g, '/')
    return normalized === '.claude/credentials' || normalized.startsWith('.claude/credentials')
  },
]

/**
 * Determine whether an absolute path matches the exclusion list.
 *
 * @param absPath - Normalized absolute path
 * @param projectRoot - Project root path
 * @returns true if the path is forbidden
 */
export function isForbidden(absPath: string, projectRoot: string): boolean {
  // Compute relative path from project root
  const rel = path.relative(projectRoot, absPath)

  // Paths outside the project (starting with ../) do not need exclusion checks
  // (they will be rejected by the scope region check)
  if (rel.startsWith('..')) return false

  return EXCLUSION_MATCHERS.some((matcher) => matcher(rel))
}

/**
 * Remove excluded paths from list-files result entries.
 *
 * Entries matching excluded paths are silently omitted from results
 * (treated as "non-existent" rather than errors) to prevent metadata
 * leakage through side channels.
 *
 * @see recipe-system.md §12-3-1 list-files exclusion behavior
 * @see recipe-system.md §12-2-1 list-files exclusion list handling
 */
export function filterExcludedEntries<T extends { path: string }>(
  entries: T[],
  projectRoot: string,
): T[] {
  return entries.filter((entry) => {
    const absPath = path.isAbsolute(entry.path)
      ? entry.path
      : path.join(projectRoot, entry.path)
    return !isForbidden(absPath, projectRoot)
  })
}

// =========================================
// Scope validation
// =========================================

export interface ScopeValidationResult {
  ok: boolean
  failedCode?: HandlerErrorCode
}

/**
 * Validate that a path argument is within an approved scope's region
 * and does not match the exclusion list.
 *
 * @param rawPath - Path argument received by the handler (relative or absolute)
 * @param approvedScopes - Scopes approved by the user at install time
 * @param requiredScopes - Scopes required by this handler (any one approved is sufficient)
 * @param appId - KB-local app identifier (drives the `own-data` scope root)
 * @param projectRoot - Root path of the target project
 * @param kovitoboardRoot - KovitoBoard installation path (used for kb-data-read, optional)
 *
 * @see recipe-backend-critical-reviews.md §2-3
 */
export function validatePathForScope(
  rawPath: string,
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
  appId: string,
  projectRoot: string,
  kovitoboardRoot?: string,
): ScopeValidationResult {
  // Find the intersection of approved scopes and required scopes
  const matchingScopes = requiredScopes.filter((s) =>
    approvedScopes.includes(s),
  )

  if (matchingScopes.length === 0) {
    return { ok: false, failedCode: 'ScopeViolation' }
  }

  // Resolve symlinks in the supplied roots up front so the prefix
  // comparison below sees the same physical path that
  // `normalizePath(rawPath, scopeRoot)` returns. Without this,
  // deployments where projectRoot is itself a symlink (e.g. the
  // kb-test runner's `~/test/kb-latest -> kb-blank-<ts>` link)
  // emit `PathOutOfScope` for every relative path because the
  // resolved `physical` and the unresolved `scopeRoot` never share
  // a prefix.
  const projectRootResolved = realpathUpToExisting(projectRoot)
  const kovitoboardRootResolved = kovitoboardRoot
    ? realpathUpToExisting(kovitoboardRoot)
    : undefined

  // Try path validation against each matching scope
  // Any one passing is sufficient
  for (const scope of matchingScopes) {
    const scopeRoot = realpathUpToExisting(
      resolveScopeRoot(
        scope,
        projectRootResolved,
        appId,
        kovitoboardRootResolved,
      ),
    )
    let physical: string

    try {
      physical = normalizePath(rawPath, scopeRoot)
    } catch (err) {
      if (err instanceof PathResolutionError) {
        return { ok: false, failedCode: 'Internal' }
      }
      throw err
    }

    // claude-md-read has special handling (only CLAUDE.md is allowed)
    if (scope === 'claude-md-read') {
      if (isClaudeMdPath(physical, projectRootResolved)) {
        // Exclusion list check (CLAUDE.md normally won't match, but as a safety measure)
        if (isForbidden(physical, projectRootResolved)) {
          continue // Try next scope
        }
        return { ok: true }
      }
      continue // Not CLAUDE.md, try next scope
    }

    // Check if path is within scope region
    if (!isWithin(physical, scopeRoot)) {
      continue // Try next scope
    }

    // Exclusion list check (always enforced regardless of scope declaration)
    if (isForbidden(physical, projectRootResolved)) {
      return { ok: false, failedCode: 'PathForbidden' }
    }

    return { ok: true }
  }

  // No scope passed the region check
  return { ok: false, failedCode: 'PathOutOfScope' }
}

/**
 * Scope-only validation (for handlers without path arguments).
 * Used by own-data-bound handlers such as kv-*.
 */
export function validateScopeOnly(
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
): ScopeValidationResult {
  const hasMatch = requiredScopes.length === 0 ||
    requiredScopes.some((s) => approvedScopes.includes(s))
  return hasMatch
    ? { ok: true }
    : { ok: false, failedCode: 'ScopeViolation' }
}
