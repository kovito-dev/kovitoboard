/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Stable API: Recipe system type definitions.
 * Shared between server and renderer — no React/DOM dependencies.
 *
 * Stability classification:
 *   @stable  — ArtifactType, ArtifactEntry, RecipeMenuEntry
 *   @stable  — RecipeMetadata, ParsedRecipe (shape)
 *   @stable  — InspectionVerdict, InspectionResult (shape)
 *   @stable  — RecipeHistoryEntry (shape)
 *   @stable  — API request/response types
 *   @internal — Finding (individual fields may change)
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 */

// --- Artifact types ---

/**
 * Allowed artifact types (v0.1.0: FE-only, 'api' is forbidden).
 * API extensions are declared via the api: section in recipe.yaml.
 */
export type ArtifactType = 'page' | 'style' | 'lib' | 'hook' | 'util'

/** Artifact entry from recipe YAML (path + type only) */
export interface ArtifactEntry {
  path: string
  type: ArtifactType
}

/** Artifact with full content (after parsing) */
export interface ArtifactWithContent extends ArtifactEntry {
  content: string
  sizeBytes: number
}

// --- Recipe metadata ---

export interface RecipeMetadata {
  /**
   * The recipe author's chosen immutable identifier. Required as of
   * v0.1.0 (DEC-024 D-8). Constraints:
   *   - matches `/^[A-Za-z0-9_\-./@]+$/`
   *   - 1〜64 characters (security-limits.md v1.1 L-R5; tightened
   *     from the legacy 256-char ceiling in v0.2.x)
   * Forms accepted: `"document-viewer"`, `"kovito-dev/document-viewer"`,
   * `"org-foo/recipe-bar@1.0.0"`. Full hex hashes (`sha256-…`) need
   * to fit within 64 chars; the previously documented `sha256:…`
   * literal example no longer fits and is dropped.
   *
   * v0.1.x backward compatibility: when a `recipe.yaml` does not
   * declare `recipeId`, `recipe-parser.ts` synthesizes one via
   * `kebab-case(name)` and emits a `parser` warning. The fallback
   * will be removed in v0.2.0 (parse error). New recipes MUST
   * declare this field explicitly.
   */
  recipeId: string
  name: string
  description: string
  version: string
  author?: string
  kovitoboard?: string
  tags?: string[]
  /**
   * Optional locale-specific overrides for the human-readable
   * `name` / `description`. The renderer picks the entry matching
   * the active UI locale and falls back to the top-level fields
   * when the active locale is missing or the map is absent.
   *
   * Authors who only ship one locale do not need to populate this.
   * Bundled sample recipes that need both Japanese and English
   * declare e.g.
   *   i18n:
   *     en:
   *       name: "Document Viewer"
   *       description: "..."
   * alongside the Japanese top-level fields.
   */
  i18n?: Record<string, { name?: string; description?: string }>
}

/** Menu entry defined in recipe YAML */
export interface RecipeMenuEntry {
  id: string
  label: string
  icon: string
  page: string // relative path under app/, no extension
}

// --- Parsed recipe ---

export interface ParsedRecipe {
  metadata: RecipeMetadata
  artifacts: ArtifactWithContent[]
  menu: RecipeMenuEntry[]
  instruction?: string
  /**
   * Declarative handler API section.
   * Only set for recipes that include an api: section in recipe.yaml.
   * @see recipe-system.md §12-2, §12-3
   */
  api?: RecipeApiSection
  hash: string
  sourceFormat: 'directory' | 'markdown'
  sourcePath: string
}

/**
 * The api: section of recipe.yaml (shared type).
 * Identical in shape to the server-side ApiSection, but redefined here
 * to avoid importing server-specific dependencies.
 *
 * @see recipe-system.md §12-2, §12-3
 */
export interface RecipeApiSection {
  scopes: string[]
  calls: RecipeApiCall[]
}

export interface RecipeApiCall {
  id: string
  handler: string
  args?: Record<string, unknown>
}

// --- Security inspection ---

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'info'
export type InspectionVerdict = 'blocked' | 'warning' | 'caution' | 'safe'

export interface Finding {
  severity: FindingSeverity
  file: string
  line?: number
  description: string
  context?: string
}

export interface InspectionResult {
  verdict: InspectionVerdict
  findings: Finding[]
  remoteCheckSkipped?: boolean
  note?: string
  /**
   * True when no patterns indicating non-declarative implementation
   * (Express Router, direct fetch/axios, child_process, etc.) are
   * detected in the recipe artifacts. Used by the install UI to
   * decide whether to surface the warning dialog before handing off
   * to the agent.
   *
   * @see DEC-006 v2.0 § 6 (declarative handler model — runtime
   *      enforcement layer separation)
   * @see docs/specs/v0.1.0-recipe-install-handover.md F5
   */
  pureDeclarative: boolean
  /**
   * Names of non-declarative patterns matched during inspection
   * (e.g. `'express-router'`, `'direct-fetch'`). Empty when
   * `pureDeclarative` is true. The renderer maps these to localized
   * labels for the warning dialog.
   *
   * @see docs/specs/v0.1.0-recipe-install-handover.md §3.5
   */
  detectedNonDeclarativePatterns: string[]
}

// --- History ---

export interface RecipeHistoryEntry {
  id: string
  /**
   * Lifecycle action this entry represents. Optional only for
   * backward compatibility with `recipe-history.jsonl` files written
   * before the field was introduced — readers MUST treat a missing
   * `action` as `'install'` so historical entries continue to count
   * as installs. New entries should always include this field
   * explicitly.
   */
  action?: 'install' | 'uninstall'
  name: string
  version: string
  author?: string
  source: string
  hash: string
  appliedAt: string
  artifacts: string[]
  menu: string[]
  /**
   * For `action: 'uninstall'` entries: the recipeId of the manifest
   * that was removed. Captured so an uninstall can be matched back
   * to the install that produced it without re-deriving the id from
   * `name`/`hash`.
   */
  recipeId?: string
  /**
   * KB-local app identifier (the directory name under `app/<appId>/`
   * the agent picked at install time). Optional only for backward
   * compatibility with `recipe-history.jsonl` files written before
   * the field was promoted to a first-class member; install entries
   * written from v0.2.0 onward always include it. Readers that need
   * to associate a history entry with a specific app instance should
   * prefer `appId`, then fall back to the legacy `menu[0]` heuristic
   * for older entries.
   *
   * Distinct from `recipeId` — multiple apps may share a `recipeId`
   * (the recipe author's lineage id) when the same recipe is
   * installed under different `appId`s via the collision-avoidance
   * flow at install time.
   */
  appId?: string
  /**
   * For `action: 'uninstall'` entries: whether the user opted to
   * delete the recipe's `app/data/<appId>/` directory along with
   * the artifacts. Default behavior is to preserve user data.
   */
  ownDataDeleted?: boolean
}

// --- API request/response types ---

export interface RecipeParseRequest {
  source: string
}

export interface RecipeParseResponse {
  recipe: ParsedRecipe
  inspection: InspectionResult
}

/**
 * RC-3: payload for the file-picker upload variant. The browser cannot
 * give us a server-resolvable absolute path, so we ship the contents
 * inline. Each entry is a UTF-8 string keyed by its in-recipe relative
 * path (`recipe.yaml`, `pages/Index.tsx`, etc.). The server materializes
 * a transient directory, hands it to the existing `parseRecipe`, and
 * cleans the directory up afterwards.
 *
 * - Single-file recipes upload one entry with a `.md` / `.markdown` path.
 * - Directory recipes upload every file the user picked via a
 *   `<input type="file" webkitdirectory>` element.
 *
 * Binary artifacts are out of scope for v0.1.0; recipe artifacts are
 * already constrained to a UTF-8 safe extension set by the parser.
 */
export interface RecipeUploadFile {
  /** In-recipe relative path. Forward slashes only. No leading slash, no `..`. */
  relPath: string
  /** UTF-8 contents of the file. */
  content: string
}

export interface RecipeParseUploadRequest {
  files: RecipeUploadFile[]
}

// `RecipeApplyRequest` / `RecipeApplyResponse` were retired in v0.2.x
// when `POST /api/recipes/apply` was removed alongside the recipe
// install temporary disable (recipe-system.md §10.6 /
// http-api-contract.md §4.3.8.A). The v0.3.0 install flow will run
// through `InstallRecipeRequest` / `MarkInstalledRequest` only.

/**
 * Request body for `POST /api/recipes/install` (v2.0 — agent-handover flow).
 *
 * The legacy v1.x request used `approvedScopes` populated from the
 * scope-approval modal; that modal is retired in v2.0 and the agent
 * collects user approval interactively before reporting back via
 * `mark-installed`.
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.2
 */
export interface RecipeInstallRequest {
  /** Parsed recipe (from `POST /api/recipes/parse`). */
  recipe: ParsedRecipe
  /** Inspection result (from `POST /api/recipes/parse`). */
  inspection: InspectionResult
  /** Agent id chosen in the agent picker. */
  agentId: string
  /** Origin of the recipe. */
  recipeSource: 'sample' | 'import' | 'url'
}

/**
 * Response body for `POST /api/recipes/install` (v2.0 — agent-handover flow).
 */
export interface RecipeInstallResponse {
  ok: true
  /** Session id the renderer should navigate to. */
  sessionId: string
}

/**
 * Request body for `POST /api/recipes/:recipeId/mark-installed`.
 *
 * Sent by the agent (via curl) after artifacts have been placed and
 * the `app/<appId>/manifest.json` has been written. KB then persists
 * the recipe-side manifest and appends an install entry to history.
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.3
 */
export interface MarkInstalledRequest {
  /** KB-local app id chosen via the collision-avoidance API. */
  appId: string
  /**
   * Scopes the user approved during the agent dialog. Must be a
   * subset of the recipe's declared `api.scopes`.
   */
  approvedScopes: string[]
  /** Recipe version at install time. */
  recipeVersion: string
  /** Origin of the recipe (mirrored from the install request). */
  recipeSource: 'sample' | 'import' | 'url'
  /** SHA-256 hash of the recipe content (`recipe.hash`). */
  recipeHash: string
  /**
   * Full recipe `api:` section. Stored verbatim in the
   * `recipes-installed/<appId>/manifest.json` so the dispatcher can
   * resolve handler calls without rereading recipe.yaml. Optional
   * because recipes without an api section are valid.
   */
  api?: RecipeApiSection
}

/** Response body for `POST /api/recipes/:recipeId/mark-installed`. */
export interface MarkInstalledResponse {
  ok: true
}

export interface RecipeExportRequest {
  /**
   * KB-local app identifier. The exporter scans `app/<appId>/` and
   * builds a single Markdown recipe. Required as of
   * `v0.1.0-recipe-export-rework` (DEC-024 #5) — exporting "everything
   * under app/" is no longer supported, since multiple apps share the
   * directory.
   *
   * Follow-up (post-rework, 2026-05-04): `format` and `outputPath`
   * have been removed. The server returns the Markdown body directly
   * so the browser can save it via a normal download response; nothing
   * is written to the host filesystem during export.
   */
  appId: string
  metadata: RecipeMetadata
}

/**
 * Error response body for `POST /api/recipes/export`.
 *
 * The success path returns `text/markdown` directly (a download
 * response with `Content-Disposition: attachment`), so the only
 * structured payload the route emits is this error envelope. Kept as
 * an interface so handlers and tests can share the shape.
 */
export interface RecipeExportErrorResponse {
  error: string
}

/**
 * Result of `scanAppDirectory(fs, appId)`.
 *
 * **Completeness contract:** when `customBeFiles` is empty (and
 * therefore `customBeFilesCount === 0`), every other field is the
 * accurate result of a full walk and the export can proceed.
 * When `customBeFiles` is non-empty, the caller MUST refuse the
 * export — anything under `api/` is rejected by recipe-inspector at
 * install time, so packaging it would produce an uninstallable
 * recipe. In that refusal-path case, `artifacts`, `menu`, and
 * `totalSize` may be partial: the scanner short-circuits as soon as
 * the refusal is certain, so it does not waste CPU / IO walking the
 * rest of the tree on a request that is guaranteed to fail. The
 * refusal does not consume those fields, so the partiality is
 * harmless in practice; new callers that DO want full
 * artifacts / menu / totalSize should first verify
 * `customBeFilesCount === 0`.
 */
export interface AppScanResult {
  artifacts: Array<{ path: string; type: ArtifactType; sizeBytes: number }>
  menu: RecipeMenuEntry[]
  totalSize: number
  /**
   * Sample of files under `app/<appId>/api/` that the exporter
   * detected. The list is bounded so a pathological tree cannot
   * drive an unbounded allocation — use `customBeFilesCount` for
   * the count and `customBeFilesCountApproximate` to know whether
   * that count is exact.
   */
  customBeFiles: Array<{ relativePath: string; sizeBytes: number }>
  /**
   * Number of files the scanner observed under `app/<appId>/api/`
   * before it stopped walking. Equal to `customBeFiles.length`
   * when the cap was not hit; a best-effort lower bound otherwise
   * (see `customBeFilesCountApproximate`).
   */
  customBeFilesCount: number
  /**
   * True when the scanner short-circuited after collecting enough
   * `api/` matches to drive the refusal. In that case
   * `customBeFilesCount` is the lower bound it reached before it
   * stopped, not the true number of files in `app/<appId>/api/`,
   * and the rest of the result (artifacts / menu / totalSize) is
   * also partial — see the interface-level note above.
   */
  customBeFilesCountApproximate: boolean
}
