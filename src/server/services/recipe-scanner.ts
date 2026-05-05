/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe scanner — scan `recipes/` directory at startup and cache sample recipe metadata.
 *
 * Used by Phase G to provide `GET /api/recipes/sample` with pre-scanned recipe info.
 * Gracefully handles missing directories and parse failures (logs warning, skips).
 */
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from '../fs-layer'
import { parseRecipe, deriveRecipeIdFromName } from '../recipe-parser'
import { readRecipeHistory } from '../recipe-history'
import type { RecipeMetadata, RecipeHistoryEntry } from '../../shared/recipe-types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Lightweight metadata for a sample recipe (no full artifact content). */
export interface SampleRecipeInfo {
  /** Directory name under recipes/ (e.g. "document-viewer") */
  id: string
  /** Recipe metadata (name, description, version, etc.) */
  metadata: RecipeMetadata
  /** Absolute path to the recipe source */
  sourcePath: string
  /** Source format detected by the parser */
  sourceFormat: 'directory' | 'markdown'
  /** Recipe content hash */
  hash: string
  /** Whether this recipe has been installed (matched against recipe-history.jsonl) */
  installed: boolean
  /** History entry if installed */
  historyEntry?: RecipeHistoryEntry
}

/** In-memory cache of scanned sample recipes. */
let sampleRecipeCache: SampleRecipeInfo[] = []

/**
 * Scan the `recipes/` directory under the KovitoBoard installation root
 * and cache the results. Safe to call at startup — never throws.
 */
export function scanSampleRecipes(fs: FileAccessLayer): SampleRecipeInfo[] {
  const kbRoot = resolveKovitoboardRoot(fs)
  const recipesDir = join(kbRoot, 'recipes')

  if (!fs.existsSync(recipesDir)) {
    console.log('[recipe-scanner] recipes/ directory not found — returning empty list')
    sampleRecipeCache = []
    return sampleRecipeCache
  }

  const history = readRecipeHistory(fs)
  const entries: SampleRecipeInfo[] = []

  try {
    const items = fs.readdirSync(recipesDir)

    for (const item of items) {
      // Skip hidden files and non-recipe items
      if (item.startsWith('.')) continue

      const itemPath = join(recipesDir, item)

      try {
        // Check for directory format: recipes/<name>/recipe.yaml
        const yamlPath = join(itemPath, 'recipe.yaml')
        if (fs.existsSync(yamlPath)) {
          const parsed = parseRecipe(itemPath, fs)
          const historyEntry = findHistoryMatch(history, parsed.metadata.recipeId, parsed.hash)
          entries.push({
            id: item,
            metadata: parsed.metadata,
            sourcePath: itemPath,
            sourceFormat: parsed.sourceFormat,
            hash: parsed.hash,
            installed: historyEntry !== undefined,
            historyEntry,
          })
        } else if (item.endsWith('.md') || item.endsWith('.markdown')) {
          // Single-file Markdown format
          const parsed = parseRecipe(itemPath, fs)
          const id = item.replace(/\.(md|markdown)$/, '')
          const historyEntry = findHistoryMatch(history, parsed.metadata.recipeId, parsed.hash)
          entries.push({
            id,
            metadata: parsed.metadata,
            sourcePath: itemPath,
            sourceFormat: parsed.sourceFormat,
            hash: parsed.hash,
            installed: historyEntry !== undefined,
            historyEntry,
          })
        }
        // Other items are silently skipped
      } catch (err) {
        console.warn(`[recipe-scanner] Failed to parse recipe "${item}":`, err instanceof Error ? err.message : err)
        // Skip this recipe, continue scanning others
      }
    }
  } catch (err) {
    console.error('[recipe-scanner] Failed to read recipes/ directory:', err)
  }

  sampleRecipeCache = entries
  console.log(`[recipe-scanner] Scanned ${entries.length} sample recipe(s)`)
  return sampleRecipeCache
}

/** Get the cached sample recipe list (call scanSampleRecipes first). */
export function getSampleRecipes(): SampleRecipeInfo[] {
  return sampleRecipeCache
}

/**
 * Refresh the install status of cached recipes against current history.
 * Useful after a recipe is installed/uninstalled without a full rescan.
 */
export function refreshInstallStatus(fs: FileAccessLayer): void {
  const history = readRecipeHistory(fs)
  for (const recipe of sampleRecipeCache) {
    const historyEntry = findHistoryMatch(history, recipe.metadata.recipeId, recipe.hash)
    recipe.installed = historyEntry !== undefined
    recipe.historyEntry = historyEntry
  }
}

/**
 * Resolve the KovitoBoard installation root.
 * This is the directory where KovitoBoard itself is installed (containing recipes/, src/, etc.),
 * NOT the user's project root (which contains CLAUDE.md).
 *
 * Source:  src/server/services/ → 3 levels up
 * Build:  dist/server/services/ → 3 levels up (same)
 */
function resolveKovitoboardRoot(fs: FileAccessLayer): string {
  const candidates = [
    resolve(__dirname, '..', '..', '..'),  // src/server/services/ or dist/server/services/ → root
    resolve(__dirname, '..', '..'),         // fallback
  ]
  // Look for package.json as the indicator of KB root
  return candidates.find((p) => fs.existsSync(join(p, 'package.json'))) || candidates[0]
}

/**
 * Find the install entry that currently represents the given recipe
 * in the history, *if any*. Returns `undefined` only when no install
 * record for the `recipeId` has ever been written.
 *
 * v2.0 lookup contract (DEC-024 D-4-b, recipe-system.md v2.0 §13-1):
 *
 *   1. Walk the history in reverse so the most recent install wins.
 *   2. The lookup key is the recipe author's `recipeId` (not the
 *      legacy `name` field). The recipe parser surfaces this via
 *      `parsed.metadata.recipeId`. For history entries written by
 *      builds that predate the recipeId field, fall back to
 *      `kebab-case(entry.name)` so they keep matching the recipes
 *      they originally represented.
 *   3. **`uninstall` entries are now ignored**: a recipe that was
 *      ever installed stays in the "installed" lane forever — even
 *      after uninstall — so the user can reinstall via the same
 *      sample card. App removal is tracked separately via
 *      `app/<appId>/manifest.json`, not via the recipe history.
 *   4. Prefer an exact `recipeId + hash` install match; fall back to
 *      a `recipeId`-only install (different version was installed
 *      previously).
 *
 * `action` is `undefined` for entries written by pre-uninstall
 * builds — those are treated as `install` to preserve backward
 * compatibility (see `RecipeHistoryEntry.action` JSDoc).
 *
 * @param recipeId - the recipe author's immutable identifier
 *   (`recipe.yaml`'s `recipeId`). For legacy history entries this is
 *   matched against `kebab-case(entry.name)` as a fallback.
 */
export function findHistoryMatch(
  history: RecipeHistoryEntry[],
  recipeId: string,
  hash: string,
): RecipeHistoryEntry | undefined {
  // Pass 1: prefer recipeId + hash; the most recent install wins.
  const exactInstall = findLatestMatch(
    history,
    (h) => entryMatchesRecipeId(h, recipeId) && h.hash === hash && isInstallAction(h),
  )
  if (exactInstall) return exactInstall

  // Pass 2: fall back to recipeId-only install (older version).
  return findLatestMatch(
    history,
    (h) => entryMatchesRecipeId(h, recipeId) && isInstallAction(h),
  )
}

/**
 * Match a history entry against a target recipeId. New entries
 * carry an explicit `recipeId`; legacy ones are matched via the
 * kebab-cased recipe name so a v0.1.x history file keeps surfacing
 * the right recipe after the upgrade.
 */
function entryMatchesRecipeId(entry: RecipeHistoryEntry, recipeId: string): boolean {
  if (typeof entry.recipeId === 'string' && entry.recipeId.length > 0) {
    return entry.recipeId === recipeId
  }
  return deriveRecipeIdFromName(entry.name) === recipeId
}

/**
 * Treat history entries with no `action` field as installs to keep
 * pre-uninstall-era history readable.
 */
function isInstallAction(entry: RecipeHistoryEntry): boolean {
  return entry.action === undefined || entry.action === 'install'
}

function findLatestMatch(
  history: RecipeHistoryEntry[],
  predicate: (h: RecipeHistoryEntry) => boolean,
): RecipeHistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (predicate(history[i])) return history[i]
  }
  return undefined
}
