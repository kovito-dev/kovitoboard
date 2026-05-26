/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe scanner — scan `recipes/` directory at startup and cache sample recipe metadata.
 *
 * Used to back `GET /api/recipes/sample` with pre-scanned recipe info.
 * Gracefully handles missing directories and parse failures (logs warning, skips).
 *
 * v0.2.x: The install trigger paths are disabled (`/api/recipes/install`
 * returns 410 Gone, the UI install buttons are gone — recipe-system.md
 * §10.6). The scanner itself keeps parsing + caching so the sample
 * cards stay browseable and grandfather install lineage (the
 * `installed` flag + `historyEntry` join) keeps rendering. The
 * scanner is not the right place to gate install — gating happens
 * at the install endpoint and at the UI level.
 */
import { recipeLogger } from '../logger'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from '../fs-layer'
import { parseRecipe, deriveRecipeIdFromName } from '../recipe-parser'
import { readRecipeHistory } from '../recipe-history'
import type { RecipeMetadata, RecipeHistoryEntry } from '../../shared/recipe-types'
import type { RecipeManifestStore } from '../recipeManifestStore'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Derived source label for a bundled-eligible sample (v0.2.1).
 *
 * - `'bundled'`: the manifest at `recipes-installed/<appId>/manifest.json`
 *   was written by the v0.2.1 bundled enable flow (`source: 'bundled'`).
 * - `'sample (grandfather)'`: a v0.2.0 sample-install manifest still on
 *   disk (`source: 'sample'`). The bundled disable endpoint accepts it,
 *   but the persisted `source` field stays `'sample'` (BS-L2 grandfather
 *   idempotent merge, recipe-system v1.10 §10.9.5).
 *
 * UI displays this verbatim ("Bundled" / "Sample (grandfather)") via the
 * scanner contract (`app-directory-extension.md` v1.6 §6.7.2). The
 * persisted manifest schema remains the four-value set
 * (`'sample' | 'bundled' | 'import' | 'url'`) — `'self-made'` and the
 * grandfather alias are derivation-only labels (BS-L9).
 */
export type SampleRecipeSourceLabel = 'bundled' | 'sample (grandfather)'

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
  /**
   * Legacy install-history flag (pre-v0.2.1). True iff the recipe has
   * an install-action record in `recipe-history.jsonl` (regardless of
   * later uninstall). Kept for backward compatibility with the v0.2.0
   * sample-card UI; new code should consult {@link enabled} instead.
   */
  installed: boolean
  /** History entry if installed */
  historyEntry?: RecipeHistoryEntry
  /**
   * v0.2.1 enable-state flag — true iff a coherent
   * `recipes-installed/<appId>/manifest.json` is currently present for
   * this recipe id (bundled enable transaction completed and no
   * disable has taken effect). Computed via
   * `bundled-installer.isEnabledAndManifestCoherent` after each scan.
   *
   * Distinct from {@link installed}: a grandfather sample whose
   * v0.2.0 install record is still in history is `installed: true`,
   * but it is `enabled` only as long as the manifest is on disk.
   *
   * @see recipe-system.md v1.10 §10.9.5 BS-L2'
   */
  enabled: boolean
  /**
   * Derived source label for the currently-enabled manifest, or
   * `undefined` when {@link enabled} is false. The bundled-enable
   * flow writes `'bundled'`; a v0.2.0 grandfather manifest surfaces
   * as `'sample (grandfather)'` (the persisted `source` stays
   * `'sample'`).
   *
   * @see recipe-system.md v1.10 §10.9 / §10.9.5 BS-L2
   * @see app-directory-extension.md v1.6 §6.7.2
   */
  source?: SampleRecipeSourceLabel
}

/** In-memory cache of scanned sample recipes. */
let sampleRecipeCache: SampleRecipeInfo[] = []

/**
 * Scan the `recipes/` directory under the KovitoBoard installation root
 * and cache the results. Safe to call at startup — never throws.
 *
 * The optional `manifestStore` is consulted to derive the per-recipe
 * `enabled` + `source` fields (v0.2.1). Callers that scan before the
 * manifest store has loaded (or that do not need the enable-state)
 * may pass `undefined` and refresh the fields later via
 * {@link refreshInstallStatus}.
 */
export function scanSampleRecipes(
  fs: FileAccessLayer,
  manifestStore?: RecipeManifestStore,
): SampleRecipeInfo[] {
  const kbRoot = resolveKovitoboardRoot(fs)
  const recipesDir = join(kbRoot, 'recipes')

  if (!fs.existsSync(recipesDir)) {
    recipeLogger.info('[recipe-scanner] recipes/ directory not found — returning empty list')
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
        let parsed: ReturnType<typeof parseRecipe> | null = null
        let entryId = item
        if (fs.existsSync(yamlPath)) {
          parsed = parseRecipe(itemPath, fs)
        } else if (item.endsWith('.md') || item.endsWith('.markdown')) {
          // Single-file Markdown format
          parsed = parseRecipe(itemPath, fs)
          entryId = item.replace(/\.(md|markdown)$/, '')
        } else {
          continue
        }
        const historyEntry = findHistoryMatch(history, parsed.metadata.recipeId, parsed.hash)
        const { enabled, source } = deriveEnableState({
          manifestStore,
          recipeId: parsed.metadata.recipeId,
        })
        entries.push({
          id: entryId,
          metadata: parsed.metadata,
          sourcePath: itemPath,
          sourceFormat: parsed.sourceFormat,
          hash: parsed.hash,
          installed: historyEntry !== undefined,
          historyEntry,
          enabled,
          source,
        })
      } catch (err) {
        recipeLogger.warn({ err }, `[recipe-scanner] Failed to parse recipe "${item}"`)
        // Skip this recipe, continue scanning others
      }
    }
  } catch (err) {
    recipeLogger.error({ err }, '[recipe-scanner] Failed to read recipes/ directory:')
  }

  sampleRecipeCache = entries
  recipeLogger.info(`[recipe-scanner] Scanned ${entries.length} sample recipe(s)`)
  return sampleRecipeCache
}

/** Get the cached sample recipe list (call scanSampleRecipes first). */
export function getSampleRecipes(): SampleRecipeInfo[] {
  return sampleRecipeCache
}

/**
 * Refresh the install status of cached recipes against current history.
 * Useful after a recipe is installed/uninstalled without a full rescan.
 *
 * Also re-derives the v0.2.1 `enabled` + `source` fields from the
 * manifest store when one is provided. Call this after every bundled
 * enable / disable transaction so the sample-card UI reflects the new
 * state without a full rescan.
 */
export function refreshInstallStatus(
  fs: FileAccessLayer,
  manifestStore?: RecipeManifestStore,
): void {
  const history = readRecipeHistory(fs)
  for (const recipe of sampleRecipeCache) {
    const historyEntry = findHistoryMatch(history, recipe.metadata.recipeId, recipe.hash)
    recipe.installed = historyEntry !== undefined
    recipe.historyEntry = historyEntry
    const { enabled, source } = deriveEnableState({
      manifestStore,
      recipeId: recipe.metadata.recipeId,
    })
    recipe.enabled = enabled
    recipe.source = source
  }
}

/**
 * Compute the v0.2.1 `enabled` + `source` pair for a single recipe id.
 *
 * Returns `{ enabled: false, source: undefined }` when no manifest
 * store is available or when no bundled/sample manifest exists for
 * the recipe id. The grandfather alias (`'sample (grandfather)'`)
 * is derived here based on the persisted `source` field.
 */
function deriveEnableState(args: {
  manifestStore?: RecipeManifestStore
  recipeId: string
}): { enabled: boolean; source: SampleRecipeSourceLabel | undefined } {
  const { manifestStore, recipeId } = args
  if (!manifestStore) {
    return { enabled: false, source: undefined }
  }
  for (const manifest of manifestStore.list()) {
    if (manifest.recipeId !== recipeId) continue
    const persisted = manifest.source
    if (persisted === 'bundled') return { enabled: true, source: 'bundled' }
    if (persisted === 'sample') return { enabled: true, source: 'sample (grandfather)' }
  }
  return { enabled: false, source: undefined }
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
