/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe exporter — scan a single app's directory and generate a
 * Markdown recipe ready for distribution.
 *
 * Reworked for `v0.1.0-recipe-export-rework` (DEC-024 #5):
 *   - Scope is `app/<appId>/`, not the entire `app/` tree
 *   - `app/<appId>/api/*.ts` is part of the artifacts (was excluded)
 *   - `recipe.yaml` carries the manifest's `api:` section verbatim
 *     when the app was installed from a recipe (manifest available)
 *   - `recipeId` is required and must be supplied by the caller; the
 *     exporter no longer silently accepts an empty value
 *
 * Follow-up (post-v0.1.0-recipe-export-rework, 2026-05-04 directive):
 *   - Directory format and explicit `outputPath` are removed. The API
 *     route generates the Markdown in memory and streams it as a
 *     download response, so the server no longer writes anywhere on
 *     disk during export. `exportAsMarkdown` is now a pure function
 *     that returns the document as a string.
 */
import { join, extname, relative, sep } from 'path'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'
import { parseMenuTsForApp } from './services/menu-extractor'
import type {
  ArtifactType,
  RecipeMetadata,
  RecipeMenuEntry,
  RecipeApiSection,
  AppScanResult,
} from '../shared/recipe-types'

/**
 * Infer artifact type from a relative path under `app/<appId>/`.
 *
 * Note: `api/*.ts` files are NOT mapped here. They are filtered out
 * of `artifacts` by `scanAppDirectory` and surfaced separately via
 * `customBeFiles`. Backend route handlers live outside the recipe
 * safety boundary (recipe-inspector path-prefix restriction rejects
 * `api/` at install time anyway), so the exporter refuses to package
 * them; callers map this back to a 400 with guidance on how to
 * distribute the BE half separately.
 */
export function inferArtifactType(relativePath: string): ArtifactType {
  if (relativePath.startsWith('pages/')) return 'page'
  if (relativePath.startsWith('styles/')) return 'style'
  if (relativePath.startsWith('hooks/')) return 'hook'
  if (relativePath.startsWith('utils/')) return 'util'
  return 'lib' // fallback
}

/**
 * Scan `app/<appId>/` and collect artifacts + the matching menu entries.
 *
 * @returns artifact list (paths relative to `app/<appId>/`, with the
 *          `<appId>/` prefix stripped), the menu entries that belong
 *          to `appId`, and the cumulative byte size for UI display.
 *          Returns an empty result when the app directory does not
 *          exist — the API layer treats that as a 400.
 */
export function scanAppDirectory(fs: FileAccessLayer, appId: string): AppScanResult {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')
  const appRoot = join(appDir, appId)

  if (!fs.existsSync(appRoot)) {
    return {
      artifacts: [],
      menu: [],
      totalSize: 0,
      customBeFiles: [],
      customBeFilesCount: 0,
    }
  }

  const artifacts: AppScanResult['artifacts'] = []
  const customBeFiles: AppScanResult['customBeFiles'] = []
  /**
   * Sample size for `customBeFiles`. The full count is tracked in
   * `customBeFilesCount`; this only bounds how many path strings we
   * keep in memory + send back to the UI. Large `api/` trees should
   * not be able to drive an unbounded allocation here.
   */
  const CUSTOM_BE_FILES_SAMPLE_CAP = 50
  let customBeFilesCount = 0
  let totalSize = 0

  // Recursive walk rooted at `app/<appId>/`. We deliberately keep
  // `node_modules` and dotfiles out — recipes ship source, not
  // bundled output. Any file under `api/` (regardless of extension)
  // is collected into `customBeFiles` instead of `artifacts`: the
  // recipe install path rejects every `api/`-prefixed artifact via
  // recipe-inspector's path-prefix restriction, so packaging anything
  // under `api/` was unsound. Callers should treat a non-zero
  // `customBeFilesCount` as "refuse the export" and surface the
  // guidance message at the API boundary.
  function scanDir(dir: string): void {
    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const relativePath = relative(appRoot, fullPath)

      if (entry.startsWith('.') || entry === 'node_modules') continue

      // Detect directory by trying readdirSync (FileStat has no isDirectory)
      let isDir = false
      try {
        fs.readdirSync(fullPath)
        isDir = true
      } catch { /* not a directory */ }

      if (isDir) {
        scanDir(fullPath)
      } else {
        const stat = fs.statSync(fullPath)
        const sizeBytes = stat.size
        // Collect `api/<file>` (and any nested `api/<sub>/<file>`)
        // into the BE side-channel instead of artifacts. Only the
        // prefix forms can match here — directories are dispatched
        // through the `isDir` branch above before we reach this
        // file-handling block, so `relativePath === 'api'` is not
        // reachable for files. Any extension under `api/` qualifies:
        // recipe-inspector rejects the whole prefix at install time
        // (not just `.ts`), so the same goes for `.json` / `.md` /
        // fixtures / etc.
        if (
          relativePath.startsWith(`api${sep}`) ||
          relativePath.startsWith('api/')
        ) {
          customBeFilesCount += 1
          // Bound the in-memory sample. Past the cap we still keep
          // counting (so the response can show an accurate total)
          // but stop allocating per-file metadata, closing the
          // resource-exhaustion path on a pathological `api/` tree.
          if (customBeFiles.length < CUSTOM_BE_FILES_SAMPLE_CAP) {
            customBeFiles.push({ relativePath, sizeBytes })
          }
          continue
        }
        artifacts.push({
          path: relativePath,
          type: inferArtifactType(relativePath),
          sizeBytes,
        })
        totalSize += sizeBytes
      }
    }
  }

  scanDir(appRoot)

  // `app/menu.ts` is a project-wide file; filter to this app's
  // entries. `parseMenuTsForApp` returns `MenuEntryWithPage` (with the
  // extra `pageAbsolutePath` the disk-aware reader populates), so we
  // narrow it to the recipe-shaped subset before persisting.
  let menu: RecipeMenuEntry[] = []
  const menuPath = join(appDir, 'menu.ts')
  if (fs.existsSync(menuPath)) {
    try {
      const menuContent = fs.readFileSync(menuPath, 'utf-8')
      menu = parseMenuTsForApp(menuContent, appId).map((entry) => ({
        id: entry.id,
        label: entry.label,
        icon: entry.icon,
        page: entry.page,
      }))
    } catch (err) {
      console.warn('[recipe-exporter] Failed to parse app/menu.ts:', err)
    }
  }

  return { artifacts, menu, totalSize, customBeFiles, customBeFilesCount }
}

/**
 * Build a single Markdown recipe document for `app/<appId>/`.
 *
 * The function is pure: it reads source files through the
 * `FileAccessLayer` but never writes. The caller (`POST
 * /api/recipes/export`) streams the returned string as a download
 * response so no on-disk artifacts remain on the server side.
 */
export function exportAsMarkdown(
  fs: FileAccessLayer,
  appId: string,
  scan: AppScanResult,
  metadata: RecipeMetadata,
  api: RecipeApiSection | null,
): string {
  assertRecipeIdProvided(metadata)
  const projectRoot = resolveProjectRoot(fs)
  const appRoot = join(projectRoot, 'app', appId)

  const sections: string[] = []

  // YAML frontmatter — the recipe consumer parses this block to recover
  // metadata, artifacts, optional menu and optional `api:` section.
  sections.push('---')
  sections.push(`recipeId: "${escapeYamlString(metadata.recipeId)}"`)
  sections.push(`name: "${escapeYamlString(metadata.name)}"`)
  sections.push(`description: "${escapeYamlString(metadata.description)}"`)
  sections.push(`version: "${escapeYamlString(metadata.version)}"`)
  if (metadata.author) sections.push(`author: "${escapeYamlString(metadata.author)}"`)
  if (metadata.kovitoboard) sections.push(`kovitoboard: "${escapeYamlString(metadata.kovitoboard)}"`)
  if (metadata.tags && metadata.tags.length > 0) {
    sections.push(`tags: [${metadata.tags.map((t) => `"${escapeYamlString(t)}"`).join(', ')}]`)
  }

  // artifacts field
  sections.push('artifacts:')
  for (const artifact of scan.artifacts) {
    sections.push(`  - path: "${escapeYamlString(artifact.path)}"`)
    sections.push(`    type: "${artifact.type}"`)
  }

  // menu field
  if (scan.menu.length > 0) {
    sections.push('menu:')
    for (const entry of scan.menu) {
      sections.push(`  - id: "${escapeYamlString(entry.id)}"`)
      sections.push(`    label: "${escapeYamlString(entry.label)}"`)
      sections.push(`    icon: "${escapeYamlString(entry.icon)}"`)
      sections.push(`    page: "${escapeYamlString(entry.page)}"`)
    }
  }

  // api: section — emit only when the source app was installed from a
  // recipe (manifest available). User-authored apps without a manifest
  // ship without this section; the receiving install flow surfaces the
  // missing-handlers warning and the agent fills it in (DEC-006 v2.0
  // §6).
  if (api !== null) {
    appendApiSectionToYamlLines(sections, api)
  }

  sections.push('---')
  sections.push('')
  sections.push(`# ${metadata.name}`)
  sections.push('')
  sections.push(metadata.description)
  sections.push('')

  // Artifact sections — one fenced block per source file, prefixed by
  // an `## artifacts/<path>` heading the recipe parser reuses.
  for (const artifact of scan.artifacts) {
    const srcPath = join(appRoot, artifact.path)
    const content = fs.readFileSync(srcPath, 'utf-8')
    const lang = getLanguageId(artifact.path)

    sections.push(`## artifacts/${artifact.path}`)
    sections.push('')
    sections.push('```' + lang)
    sections.push(content)
    sections.push('```')
    sections.push('')
  }

  return sections.join('\n')
}

// --- Helpers ---

/**
 * Throw when the caller supplied an empty `recipeId`. Called on entry
 * to `exportAsMarkdown` so a future caller that bypasses the API
 * route (which validates the format up front) still hits a hard fail
 * rather than silently producing a recipe without the field.
 */
function assertRecipeIdProvided(metadata: RecipeMetadata): void {
  if (!metadata.recipeId || metadata.recipeId.length === 0) {
    throw new Error('recipe-exporter: metadata.recipeId is required')
  }
}

/**
 * Append `api: { scopes, calls }` to a YAML line buffer.
 *
 * Format mirrors `recipe-applicator.ts:formatApiSection` so a recipe
 * the exporter writes is byte-identical (modulo whitespace) to a
 * recipe an install handover would have produced. JSON-quoting each
 * `args` value is intentional — the values include `${input.xxx}`
 * placeholders that must survive a YAML round-trip without being
 * mistaken for tags or anchors.
 */
function appendApiSectionToYamlLines(lines: string[], api: RecipeApiSection): void {
  lines.push('api:')
  lines.push('  scopes:')
  for (const scope of api.scopes) {
    lines.push(`    - ${scope}`)
  }
  lines.push('  calls:')
  for (const call of api.calls) {
    lines.push(`    - id: "${escapeYamlString(call.id)}"`)
    lines.push(`      handler: "${escapeYamlString(call.handler)}"`)
    if (call.args && Object.keys(call.args).length > 0) {
      lines.push('      args:')
      for (const [k, v] of Object.entries(call.args)) {
        lines.push(`        ${k}: ${JSON.stringify(v)}`)
      }
    }
  }
}

/**
 * Escape a string for inclusion in a YAML double-quoted scalar.
 * Covers the cases the exporter actually emits — backslash, double
 * quote, control characters — and leaves the rest verbatim. Good
 * enough for the recipe metadata we generate; not a general YAML
 * escaper.
 */
function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function getLanguageId(filePath: string): string {
  const ext = extname(filePath)
  switch (ext) {
    case '.tsx': return 'tsx'
    case '.ts': return 'typescript'
    case '.css': return 'css'
    case '.json': return 'json'
    case '.md': return 'markdown'
    default: return ''
  }
}
