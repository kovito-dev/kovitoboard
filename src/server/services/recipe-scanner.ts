/**
 * Recipe scanner — scan `recipes/` directory at startup and cache bundled recipe metadata.
 *
 * Used by Phase G to provide `GET /api/recipes/bundled` with pre-scanned recipe info.
 * Gracefully handles missing directories and parse failures (logs warning, skips).
 */
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from '../fs-layer'
import { parseRecipe } from '../recipe-parser'
import { readRecipeHistory } from '../recipe-history'
import type { RecipeMetadata, RecipeHistoryEntry } from '../../shared/recipe-types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Lightweight metadata for a bundled recipe (no full artifact content). */
export interface BundledRecipeInfo {
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

/** In-memory cache of scanned bundled recipes. */
let bundledRecipeCache: BundledRecipeInfo[] = []

/**
 * Scan the `recipes/` directory under the KovitoBoard installation root
 * and cache the results. Safe to call at startup — never throws.
 */
export function scanBundledRecipes(fs: FileAccessLayer): BundledRecipeInfo[] {
  const kbRoot = resolveKovitoboardRoot(fs)
  const recipesDir = join(kbRoot, 'recipes')

  if (!fs.existsSync(recipesDir)) {
    console.log('[recipe-scanner] recipes/ directory not found — returning empty list')
    bundledRecipeCache = []
    return bundledRecipeCache
  }

  const history = readRecipeHistory(fs)
  const entries: BundledRecipeInfo[] = []

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
          const historyEntry = findHistoryMatch(history, parsed.metadata.name, parsed.hash)
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
          const historyEntry = findHistoryMatch(history, parsed.metadata.name, parsed.hash)
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

  bundledRecipeCache = entries
  console.log(`[recipe-scanner] Scanned ${entries.length} bundled recipe(s)`)
  return bundledRecipeCache
}

/** Get the cached bundled recipe list (call scanBundledRecipes first). */
export function getBundledRecipes(): BundledRecipeInfo[] {
  return bundledRecipeCache
}

/**
 * Refresh the install status of cached recipes against current history.
 * Useful after a recipe is installed/uninstalled without a full rescan.
 */
export function refreshInstallStatus(fs: FileAccessLayer): void {
  const history = readRecipeHistory(fs)
  for (const recipe of bundledRecipeCache) {
    const historyEntry = findHistoryMatch(history, recipe.metadata.name, recipe.hash)
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
 * Find a matching history entry by recipe name and hash.
 * Matches by name first, then optionally by hash for version tracking.
 */
function findHistoryMatch(
  history: RecipeHistoryEntry[],
  name: string,
  hash: string,
): RecipeHistoryEntry | undefined {
  // Exact match by name and hash (same version)
  const exact = history.find((h) => h.name === name && h.hash === hash)
  if (exact) return exact

  // Name-only match (different version was installed)
  return history.find((h) => h.name === name)
}
