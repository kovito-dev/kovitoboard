/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Path Resolver — resolves base paths per scope and normalizes paths.
 *
 * Safely normalizes path arguments received by handlers and ensures they
 * remain within the scope's allowed region. Includes symlink resolution
 * and path traversal prevention.
 *
 * @see recipe-system.md §12-3 (scope definitions)
 * @see recipe-backend-critical-reviews.md §2 (Q-B1 finalized approach)
 * @stable v0.1.0
 */

import * as path from 'path'
import * as fs from 'fs'
import type { Scope } from './handlers/types.js'

/**
 * Return the base path (absolute) for a given scope.
 *
 * @param scope - The scope to resolve
 * @param projectRoot - Root path of the target project
 * @param appId - KB-local app identifier (used for own-data path)
 * @param kovitoboardRoot - KovitoBoard installation path (used for kb-data-read)
 *
 * @see recipe-system.md §12-3
 */
export function resolveScopeRoot(
  scope: Scope,
  projectRoot: string,
  appId: string,
  kovitoboardRoot?: string,
): string {
  switch (scope) {
    case 'project-read':
    case 'project-write':
      return projectRoot
    case 'agents-read':
      return path.join(projectRoot, '.claude', 'agents')
    case 'skills-read':
      return path.join(projectRoot, '.claude', 'skills')
    case 'claude-md-read':
      return projectRoot // CLAUDE.md is directly under the project root
    case 'kb-data-read':
      return path.join(kovitoboardRoot || projectRoot, 'data')
    case 'own-data':
      return path.join(projectRoot, 'app', 'data', appId)
    default: {
      const _exhaustive: never = scope
      throw new Error(`Unknown scope: ${_exhaustive}`)
    }
  }
}

/**
 * Normalize a path (3-stage normalization flow).
 *
 * Step 1: Convert to absolute path (join scopeRoot and rawPath)
 * Step 2: Normalize ../ sequences (logical resolution)
 * Step 3: Resolve symlinks via fs.realpathSync (physical resolution)
 *
 * @see recipe-backend-critical-reviews.md §2-2
 */
export function normalizePath(rawPath: string, scopeRoot: string): string {
  // Step 1: Convert to absolute path
  const joined = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(scopeRoot, rawPath)

  // Step 2: Normalize ../ sequences (logical resolution)
  const normalized = path.normalize(joined)

  // Step 3: Resolve symlinks (physical resolution)
  const physical = realpathUpToExisting(normalized)

  return physical
}

/**
 * Resolve via realpath up to the nearest existing path, then logically join the rest.
 *
 * For write-file to non-existent paths, realpath would throw ENOENT,
 * so we resolve up to the nearest existing parent directory and join
 * the remaining segments.
 *
 * @see recipe-backend-critical-reviews.md §2-2
 */
export function realpathUpToExisting(p: string): string {
  let current = p
  const segments: string[] = []

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break // Reached filesystem root
    segments.unshift(path.basename(current))
    current = parent
  }

  try {
    const resolvedBase = fs.realpathSync(current)
    return segments.length > 0
      ? path.join(resolvedBase, ...segments)
      : resolvedBase
  } catch (err: unknown) {
    // ELOOP (symlink loop) etc.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new PathResolutionError('SYMLINK_LOOP', `Symlink loop detected: ${current}`)
    }
    throw new PathResolutionError('REALPATH_FAILED', `Failed to resolve path: ${current} (${code})`)
  }
}

/**
 * Determine whether absPath is under scopeRoot.
 *
 * Both paths are assumed to be already normalized.
 */
export function isWithin(absPath: string, scopeRoot: string): boolean {
  // Append a separator and use prefix matching to prevent
  // false positives (e.g. scopeRoot="/foo/bar", absPath="/foo/barBaz")
  const root = scopeRoot.endsWith(path.sep) ? scopeRoot : scopeRoot + path.sep
  return absPath === scopeRoot || absPath.startsWith(root)
}

/**
 * Special check for the `claude-md-read` scope.
 *
 * v1.8 (recipe-system.md §6.5.4): allows any `<any>/CLAUDE.md` or
 * `<any>/CLAUDE.local.md` under the project root. Case-insensitive
 * basename match so the predicate aligns with the case-folded
 * exclusion key produced by `normalizeForExclusionMatch` step 6 —
 * `CLAUDE.MD`, `Claude.md`, etc. are all considered the same logical
 * file the recipe can read but not write.
 */
export function isClaudeMdPath(absPath: string, projectRoot: string): boolean {
  if (!isWithin(absPath, projectRoot)) return false
  const basename = path.basename(absPath).toLowerCase()
  return basename === 'claude.md' || basename === 'claude.local.md'
}

// --- Error type ---

export class PathResolutionError extends Error {
  constructor(
    public readonly kind: 'SYMLINK_LOOP' | 'REALPATH_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'PathResolutionError'
  }
}
