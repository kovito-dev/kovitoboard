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
import { recipeLogger } from './logger'
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
 * Pattern that an `appId` must satisfy to be accepted by the export /
 * app-scan boundary.
 *
 * Mirrors the `app-name` contract from
 * `docs/specs/app-directory-extension.md`: lowercase letter to start,
 * lowercase alphanumerics or hyphens after that, max 64 characters.
 * Anything outside this set is rejected before the scanner builds a
 * filesystem path.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Reserved directory names directly under `app/` that recipe install
 * never creates as `app/<appId>/`. Sourced from
 * `docs/specs/app-directory-extension.md` (RESERVED_DIRS) so that an
 * attacker cannot use them as `appId` to navigate into shared trees
 * (`app/api/`, `app/data/`, `app/pages/`, `app/styles/`).
 */
export const APP_ID_RESERVED_DIRS = Object.freeze([
  'api',
  'pages',
  'styles',
  'data',
] as const)

/**
 * Boundary error raised by `validateAppId` / `scanAppDirectory` when
 * the supplied `appId` would let the scanner step outside `app/`.
 *
 * The route layer maps any `AppIdBoundaryError` thrown from the
 * exporter into a 400 `InvalidAppId` response. A dedicated error type
 * (rather than a plain `Error`) keeps the route's `catch` block from
 * having to pattern-match on the message string and prevents future
 * scanner exceptions from being silently downgraded into 400s.
 *
 * Two messages are carried separately so the HTTP boundary can keep
 * the response body free of internal detail while operators retain
 * the diagnostic context in server logs:
 *
 * - `message` — verbose, includes the offending `appId`, the regex
 *   the input failed, or the canonical realpath that escaped `app/`.
 *   This is what gets recorded in `apiLogger.warn` and the unit-test
 *   assertions look at.
 * - `clientMessage` — generic, safe to echo to the HTTP client. Never
 *   mentions filesystem paths, attacker-controlled `appId` values, or
 *   the regex literal. The route layer renders this into the 400
 *   `InvalidAppId` body.
 */
export class AppIdBoundaryError extends Error {
  readonly clientMessage: string
  constructor(message: string, clientMessage: string) {
    super(message)
    this.name = 'AppIdBoundaryError'
    this.clientMessage = clientMessage
  }
}

/**
 * Generic client-safe message returned for any input-validation
 * failure (`validateAppId`). Crafted so a probe cannot use the response
 * body to infer whether the rejection came from the regex check or the
 * RESERVED_DIRS list, and never echoes the offending `appId` itself.
 */
const CLIENT_MESSAGE_INVALID_APP_ID = 'appId is invalid'

/**
 * Generic client-safe message returned by `scanAppDirectory` when the
 * realpath escape check fires. Communicates the boundary semantics
 * ("the resolved path left `app/`") without leaking the canonical
 * realpath strings that would otherwise disclose absolute filesystem
 * locations of the host project root or symlink targets.
 */
const CLIENT_MESSAGE_APP_ROOT_ESCAPE = 'appId resolves outside the app directory'

/**
 * Validate that `appId` is a string matching {@link APP_ID_PATTERN}
 * and is not one of the {@link APP_ID_RESERVED_DIRS}. Returns the
 * validated value verbatim (no trimming, no case folding) so callers
 * can rely on a verified single source of truth.
 *
 * Whitespace is *not* tolerated: a leading or trailing space would
 * fail the regex, which is intentional — the legacy `appId.trim()`
 * call sites used to paper over malformed inputs from the client and
 * we are now treating every non-conforming value as a 400.
 */
export function validateAppId(appId: unknown): string {
  if (typeof appId !== 'string') {
    throw new AppIdBoundaryError(
      'appId must be a string',
      CLIENT_MESSAGE_INVALID_APP_ID,
    )
  }
  if (!APP_ID_PATTERN.test(appId)) {
    throw new AppIdBoundaryError(
      `appId must match ${APP_ID_PATTERN.toString()}`,
      CLIENT_MESSAGE_INVALID_APP_ID,
    )
  }
  if ((APP_ID_RESERVED_DIRS as readonly string[]).includes(appId)) {
    throw new AppIdBoundaryError(
      `appId "${appId}" is reserved`,
      CLIENT_MESSAGE_INVALID_APP_ID,
    )
  }
  return appId
}

/**
 * Infer artifact type from a relative path under `app/<appId>/`.
 *
 * **Caller contract:** this function expects paths that have
 * already been vetted as exportable by `scanAppDirectory` — i.e.
 * not under `api/`. `api/`-prefixed paths still map to `'lib'`
 * through the fallback branch (kept for backward compatibility
 * with the existing `ArtifactType` union, which has no dedicated
 * "rejected" entry), but that mapping is **not** the public
 * meaning of this function: feeding such a path here would silently
 * reintroduce the pre-rework misclassification that the inspector
 * then rejects at install time.
 *
 * If you need to know whether a path is exportable at all, use
 * `scanAppDirectory` (which routes `api/` into `customBeFiles`)
 * rather than calling this directly.
 */
export function inferArtifactType(relativePath: string): ArtifactType {
  if (relativePath.startsWith('pages/')) return 'page'
  if (relativePath.startsWith('styles/')) return 'style'
  if (relativePath.startsWith('hooks/')) return 'hook'
  if (relativePath.startsWith('utils/')) return 'util'
  return 'lib' // fallback for vetted paths only — see contract note
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
  // Defence in depth: route handlers also validate `appId`, but this
  // call is reachable from internal helpers / unit tests that bypass
  // the HTTP boundary. Throwing `AppIdBoundaryError` keeps both paths
  // covered with a single source of truth (the route layer maps the
  // throw into a 400 `InvalidAppId`).
  const validated = validateAppId(appId)

  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')
  const appRoot = join(appDir, validated)

  if (!fs.existsSync(appRoot)) {
    return {
      artifacts: [],
      menu: [],
      totalSize: 0,
      customBeFiles: [],
      customBeFilesCount: 0,
      customBeFilesCountApproximate: false,
    }
  }

  // Symlink escape defence: even when `appId` is in the allowed
  // alphabet, a symlink planted at `app/<appId>/` could redirect the
  // scanner to a foreign tree. The realpath check pins `appRoot` to
  // its expected canonical position — `realpath(app/) + sep + appId`
  // — instead of merely confirming it sits "somewhere under
  // `realpath(app/)`". The looser "descendant of `appDirReal`"
  // variant we previously used would still accept e.g.
  // `app/foo -> app/api` (sibling RESERVED_DIRS subtree) or
  // `app/foo -> app/other-app` (cross-app access), bypassing both
  // the RESERVED_DIRS exclusion and the per-app isolation. By
  // requiring an exact match against the expected join, any symlink
  // that redirects `app/<appId>/` away from its own physical
  // location is refused — symlinks are only tolerated on `app/`
  // itself (legitimate "project root mounted via symlinked overlay"
  // case, where `realpath(app/<appId>) === join(realpath(app/), appId)`
  // still holds).
  const appDirReal = fs.realpathSync(appDir)
  const appRootReal = fs.realpathSync(appRoot)
  const expectedAppRootReal = join(appDirReal, validated)
  if (appRootReal !== expectedAppRootReal) {
    throw new AppIdBoundaryError(
      `appRoot "${appRootReal}" does not match expected canonical path "${expectedAppRootReal}"`,
      CLIENT_MESSAGE_APP_ROOT_ESCAPE,
    )
  }

  const artifacts: AppScanResult['artifacts'] = []
  const customBeFiles: AppScanResult['customBeFiles'] = []
  /**
   * Sample size for `customBeFiles`. The full count is tracked in
   * `customBeFilesCount`; this only bounds how many path strings we
   * keep in memory + send back to the UI. Large `api/` trees should
   * not be able to drive an unbounded allocation here.
   *
   * The scanner short-circuits once the count crosses this cap to
   * also bound CPU/IO: an adversarial `api/` tree must not turn
   * every guaranteed-failing export request into a deep filesystem
   * walk + a stat per file. The flag below propagates the
   * "approximate" state up to the response so callers know the
   * count may be a lower bound rather than the true total.
   */
  const CUSTOM_BE_FILES_SAMPLE_CAP = 50
  let customBeFilesCount = 0
  let aborted = false
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
    if (aborted) return
    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      if (aborted) return
      const fullPath = join(dir, entry)
      const relativePath = relative(appRoot, fullPath)

      if (entry.startsWith('.') || entry === 'node_modules') continue

      // Per-entry symlink defence: the entry-level boundary check at
      // the top of `scanAppDirectory` only canonicalises `appRoot`
      // itself, so a planted symlink anywhere *inside* the app tree
      // (e.g. `app/<appId>/pages -> /etc` or
      // `app/<appId>/assets/link -> ../../api`) would still be
      // followed by `readdirSync` / `statSync` / `readFileSync`.
      // `lstatSync` (which does NOT follow symlinks) lets us see the
      // link verbatim and refuse the scan as a whole. The route
      // layer maps `AppIdBoundaryError` into the same 400
      // `InvalidAppId` body the other boundary failures use; the
      // operator log keeps the offending relative path for triage.
      // Refusing (rather than skipping) keeps the policy uniform
      // with the entry-level escape branch and avoids partial
      // exports whose semantics would depend on which symlinks were
      // present at scan time.
      const lstat = fs.lstatSync(fullPath)
      if (lstat.isSymbolicLink) {
        throw new AppIdBoundaryError(
          `app tree contains a symlink at "${relativePath}"`,
          CLIENT_MESSAGE_APP_ROOT_ESCAPE,
        )
      }

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
          if (customBeFiles.length < CUSTOM_BE_FILES_SAMPLE_CAP) {
            customBeFiles.push({ relativePath, sizeBytes })
          }
          // Past the cap we stop the entire walk — the export is
          // already guaranteed to be refused, so spending more CPU
          // / IO to make `customBeFilesCount` (and incidentally
          // `artifacts` / `menu` / `totalSize`) exact has no
          // consumer. The result becomes "partial but
          // refusal-certain"; the AppScanResult contract documents
          // that artifacts / menu / totalSize MAY be incomplete
          // when customBeFiles is non-empty, and
          // `customBeFilesCountApproximate` explicitly flags the
          // count itself as a lower bound.
          if (customBeFilesCount >= CUSTOM_BE_FILES_SAMPLE_CAP) {
            aborted = true
            return
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
      menu = parseMenuTsForApp(menuContent, validated).map((entry) => ({
        id: entry.id,
        label: entry.label,
        icon: entry.icon,
        page: entry.page,
      }))
    } catch (err) {
      recipeLogger.warn({ err }, '[recipe-exporter] Failed to parse app/menu.ts:')
    }
  }

  return {
    artifacts,
    menu,
    totalSize,
    customBeFiles,
    customBeFilesCount,
    customBeFilesCountApproximate: aborted,
  }
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
