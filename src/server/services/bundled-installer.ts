/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Bundled sample enable/disable transactions (v0.2.1).
 *
 * KovitoBoard ships two sample recipes (`document-viewer`, `todo`)
 * under `recipes/`. Until v0.2.0 they were installed through the
 * generic recipe-install flow; in v0.2.x that flow is temporary-
 * disabled (`POST /api/recipes/install` returns 410 Gone). This
 * module replaces it with a dedicated, in-process transaction that:
 *
 *   - copies the bundled artifacts from `recipes/<recipeId>/` into
 *     the project's `app/<appId>/`,
 *   - writes a `RecipeManifest` with `source: 'bundled'` +
 *     `trustLevel: 'code-trusted (bundled)'`,
 *   - appends an install record to `recipe-history.jsonl`,
 *   - is idempotent (re-enable is a no-op when the manifest is
 *     already coherent),
 *   - rolls back on failure (all-or-nothing, BS-L1').
 *
 * Trust origin = KB itself (first-party, OSS PR-merge gated); the
 * 7-layer install dialog defense is intentionally bypassed because
 * the input space is closed to bundled-registry recipe ids.
 *
 * @see docs/specs/recipe-system.md v1.10 §10.9
 * @see docs/specs/http-api-contract.md v1.7.1 §6.3.8.B
 * @see docs/specs/data-persistence.md v1.4 §6.3 / §6.4
 * @stable v0.2.1
 */

import { join, resolve, sep } from 'path'
import { createHash } from 'crypto'
import type { FileAccessLayer } from '../fs-layer'
import { recipeLogger } from '../logger'
import { getKovitoboardDir } from '../paths'
import { isWithin } from '../pathResolver'
import {
  appendRecipeHistory,
  enforceHistorySizeGate,
  generateHistoryId,
  getRecipeHistoryPath,
  parseRecipeHistoryContent,
  readRecipeHistory,
} from '../recipe-history'
import { parseRecipe } from '../recipe-parser'
import type { RecipeManifestStore } from '../recipeManifestStore'
import type { ParsedRecipe, RecipeHistoryEntry } from '../../shared/recipe-types'
import type { ApiSection, RecipeManifest } from '../recipe/apiTypes'
import type { Scope } from '../handlers/types'
import {
  findHistoryMatch,
  getSampleRecipes,
  type SampleRecipeInfo,
  type SampleRecipeSourceLabel,
} from './recipe-scanner'

// =========================================
// Closed-world bundled registry allowlist
// =========================================

/**
 * Hardcoded closed-world allowlist of bundled-eligible recipe ids
 * (v0.2.1). The bundled-installer is the only enable path in v0.2.x
 * and is gated by OSS PR-merge — adding a recipe id to this list
 * therefore requires OSS PR review, which is the same gating
 * `recipes/` itself enjoys. The explicit allowlist is belt-and-
 * suspenders: even if a future `recipes/` reorganisation surfaces
 * additional directories, only the names below can pass through the
 * bundled-enable / bundled-disable endpoints.
 *
 * Add new bundled samples here in tandem with `recipes/<id>/`.
 *
 * @see docs/design/handoffs/v021-app-rebrand-and-bundled-enable-implementation-request.md
 *      §1.1 (bundled samples: `document-viewer`, `todo`)
 * @see docs/specs/recipe-system.md v1.10 §10.9.1 (bundled trust model)
 */
export const BUNDLED_ELIGIBLE_RECIPE_IDS: readonly string[] = [
  'document-viewer',
  'todo',
]

/** True iff the recipe id is a v0.2.1 bundled-eligible sample. */
export function isBundledEligibleRecipeId(recipeId: string): boolean {
  return BUNDLED_ELIGIBLE_RECIPE_IDS.includes(recipeId)
}

// =========================================
// appId path-traversal validation
// =========================================

/**
 * Strict appId format. Mirrors `validateProposedAppId` in
 * `app-id-collision.ts` (lowercase ASCII letters / digits / hyphens,
 * starting with a letter, ≤64 chars). Disallows path separators,
 * dot segments, NUL, and Unicode lookalikes by construction.
 */
const SAFE_APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Validate that `appId` is a safe filesystem slug before any
 * destructive path operation. The bundled-installer trusts the
 * manifest store and `recipe-history.jsonl` as the source of truth
 * for `appId`, but a tampered or corrupted record could carry a
 * value like `..` or `../escape` that would let the subsequent
 * `rmSync(..., { recursive: true, force: true })` walk outside
 * `<projectRoot>/app/`. Format validation rejects every form of
 * path-separator / traversal segment / NUL / Unicode lookalike by
 * construction.
 *
 * Also verifies that `path.resolve(projectRoot, 'app', appId)`
 * stays under `path.resolve(projectRoot, 'app')` as a belt-and-
 * suspenders guard against future regex regressions.
 *
 * @throws BundledInstallerError (`BundledAppIdInvalid` 500) on any
 *   format violation or escape attempt — fail-closed so a tampered
 *   record can never reach a destructive `rmSync` call.
 */
function assertSafeAppId(projectRoot: string, appId: string): void {
  if (typeof appId !== 'string' || !SAFE_APP_ID_PATTERN.test(appId)) {
    throw new BundledInstallerError(
      `appId "${appId}" does not match the v0.2.1 safe-slug format`,
      500,
      'BundledAppIdInvalid',
      { appId },
    )
  }
  const appRoot = resolve(projectRoot, 'app')
  const target = resolve(appRoot, appId)
  const appRootWithSep = appRoot.endsWith(sep) ? appRoot : appRoot + sep
  if (!target.startsWith(appRootWithSep)) {
    throw new BundledInstallerError(
      `appId "${appId}" resolved outside the app root`,
      500,
      'BundledAppIdInvalid',
      { appId },
    )
  }
}

// =========================================
// Error class hierarchy
// =========================================

/**
 * Base class for bundled-installer errors. Each subclass carries an
 * `httpStatus` and a stable `errorCode` so the HTTP route handler can
 * translate the failure into a wire-contract response without having
 * to inspect the message string.
 *
 * @see docs/specs/http-api-contract.md v1.7.1 §6.3.8.B (error table)
 */
export class BundledInstallerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errorCode: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BundledInstallerError'
  }
}

// =========================================
// Filesystem probe helpers (Phase 1 edge-case PR, BL-2026-176)
// =========================================

/**
 * Sibling-path prefixes treated as "leftover temp dir" anomalies by
 * the Step 3d (ii-e) probe. A failed atomic rename from a previous
 * enable transaction can leave a `<appId>.tmp*` / `<appId>.staging*`
 * directory next to the target `app/<appId>/`; spec recipe-system
 * v1.10 §10.9.3 Step 3d (ii-e) treats those as fail-closed before
 * any new write.
 */
const LEFTOVER_TEMP_DIR_PREFIXES: readonly string[] = ['.tmp', '.staging']

/**
 * One-shot snapshot of `recipe-history.jsonl` for a single request
 * path. Threading a snapshot through {@link classifyLocalResidue} and
 * {@link resolveBundledAppIdForDisable} avoids redundant O(n) sync
 * reads + parses per disable HTTP call (PR #56 codex attempt 2
 * Finding "resource exhaustion"). Always go through
 * {@link loadRecipeHistorySnapshot} to obtain one — direct
 * construction would skip the readability probe that drives the
 * fail-closed 503 (`BundledLocalStateUnavailable`).
 */
export interface RecipeHistorySnapshot {
  readonly entries: readonly RecipeHistoryEntry[]
}

/**
 * Probe readability + parse `recipe-history.jsonl` for a single
 * request path. Performs exactly one `readFileSync` (plus the
 * cheap `existsSync` + `statSync` metadata calls the read needs
 * anyway) and feeds the loaded content directly to
 * {@link parseRecipeHistoryContent} so the parsed entries are
 * available without a second disk read (PR #56 codex attempt 4
 * Finding "sync I/O amplification" — the previous implementation
 * called `probeRecipeHistoryReadability` for a full `readFileSync`
 * and then `readRecipeHistory` did a second `readFileSync`).
 *
 * Distinct from `readRecipeHistory` only in the IO-error contract:
 * a genuine read failure surfaces as `BundledLocalStateUnavailable`
 * 503 (spec recipe-system v1.10 §10.9.4 Step 1 fail-closed) instead
 * of being swallowed into an empty-array fallback. The parse +
 * rotation logic is shared (single SSOT in
 * `parseRecipeHistoryContent`).
 *
 * @throws BundledInstallerError (`BundledLocalStateUnavailable` 503)
 *   on `EACCES` / `EPERM` / `EIO` / `EBUSY` etc. while reading the
 *   history file.
 */
export function loadRecipeHistorySnapshot(fs: FileAccessLayer): RecipeHistorySnapshot {
  const path = getRecipeHistoryPath(fs)
  // statSync as the first probe — do NOT preflight with existsSync.
  // existsSync silently collapses EACCES / EPERM / EIO into false on
  // some platforms, which would let an unreadable history file fall
  // through to the empty-snapshot branch and defeat the fail-closed
  // contract this helper exists for (PR #56 codex attempt 5 Finding
  // "fail-closed regression"). ENOENT is the only errno that maps to
  // an empty snapshot; every other errno surfaces as 503
  // BundledLocalStateUnavailable.
  let size = 0
  try {
    size = fs.statSync(path).size
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') return { entries: [] }
    throw new BundledInstallerError(
      `Failed to stat recipe-history.jsonl for residue probe`,
      503,
      'BundledLocalStateUnavailable',
      {
        fileName: 'recipe-history.jsonl',
        errno: code,
        detail: err instanceof Error ? err.message : String(err),
      },
    )
  }
  // Size gate (SSOT: enforceHistorySizeGate in recipe-history.ts).
  // Both snapshot + best-effort readers share the same MAX_HISTORY_BYTES
  // cap so the DoS guard applies uniformly to every entry point on
  // the request path (PR #56 codex attempt 5 Finding "resource
  // exhaustion" — the snapshot loader previously skipped the gate
  // after the attempt 4 refactor collapsed probe + parse into one
  // function). When the file is rotated for being over-cap, the
  // active history is effectively empty until the next append, so
  // return an empty snapshot rather than throwing — the cap is a
  // defensive ceiling, not a correctness invariant.
  if (enforceHistorySizeGate(fs, path, size)) {
    return { entries: [] }
  }
  let content: string
  try {
    // Single full read of the file for this request. parseRecipeHistoryContent
    // shares the corruption-rotate logic with readRecipeHistory.
    content = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    throw new BundledInstallerError(
      `Failed to read recipe-history.jsonl for residue probe`,
      503,
      'BundledLocalStateUnavailable',
      {
        fileName: 'recipe-history.jsonl',
        errno: code,
        detail: err instanceof Error ? err.message : String(err),
      },
    )
  }
  return { entries: parseRecipeHistoryContent(fs, content) }
}

/**
 * Outcome of {@link probeManifestOnDisk}.
 *
 * - `'cached'` — the manifest is in the manifestStore cache; treat as
 *   present and use the cached value for downstream coherence checks.
 * - `'absent'` — `recipes-installed/<appId>/manifest.json` does not
 *   exist on disk. Step 3d (ii) probe takes over for appDir anomaly.
 * - `'present-io-failure'` — file exists but read failed at the
 *   filesystem level (EACCES / EIO / EPERM etc.). Surfaces as
 *   `BundledLocalStateUnavailable` 503 on the disable path; the
 *   enable path treats the same failure mode as the same code
 *   (the enable error table reuses `BundledManifestUnreadable` 500
 *   for parse-only failures, but a deeper IO failure is identical
 *   to the disable-side LocalStateUnavailable failure domain).
 * - `'present-parse-failure'` — file exists but JSON.parse failed.
 *   Surfaces as `BundledManifestUnreadable` 500 on both enable
 *   (Step 3d (iv)) and disable (Step 1) paths.
 */
type ManifestProbeOutcome =
  | { state: 'cached'; manifest: RecipeManifest }
  | { state: 'absent' }
  | { state: 'present-io-failure'; errno?: string; detail: string }
  | { state: 'present-parse-failure'; detail: string }

/**
 * Probe `recipes-installed/<appId>/manifest.json` for read/parse
 * health. Required because the manifestStore cache silently drops
 * unparseable manifests at load time (warn log only), so a cache
 * miss is not enough to distinguish "file absent" from "file present
 * but corrupt". Both bundled-installer endpoints need that distinction
 * to surface the correct error code (`BundledManifestUnreadable` 500
 * vs `BundledLocalStateUnavailable` 503) per spec recipe-system
 * v1.10 §10.9.3 Step 3d (iv) / §10.9.4 Step 1.
 *
 * Cache short-circuit invariant: `manifestStore.get(appId)` is the
 * single source of truth for manifest presence at runtime. Boot-time
 * `loadAll()` validates every on-disk manifest before it lands in the
 * cache (schema + I-CR1), and runtime mutations go exclusively
 * through `manifestStore.save` / `manifestStore.delete`, which keep
 * the cache and disk synchronised inside the per-appId lock. External
 * direct disk mutations (e.g. an operator `rm`-ing the manifest file
 * out-of-band) are out of scope for the v0.2.x local trust model; if
 * they happen, the next destructive write under
 * `enableBundledRecipe` / `disableBundledRecipe` surfaces the
 * mismatch and the user-driven recovery path takes over (PR #56
 * codex attempt 4 Finding "fail-open filesystem probe" partial
 * rationale — the cache short-circuit is design intent, not a bug).
 *
 * Errno-based classification (cache-miss path only): permission /
 * IO failures from `statSync` map to `present-io-failure` rather
 * than the prior `existsSync`-based `absent` fall-through. The
 * latter silently downgraded `EACCES` / `EPERM` into "file does
 * not exist", which defeated the fail-closed posture (`existsSync`
 * returns `false` for any failure including permission errors).
 */
function probeManifestOnDisk(
  fs: FileAccessLayer,
  manifestStore: RecipeManifestStore,
  appId: string,
): ManifestProbeOutcome {
  const cached = manifestStore.get(appId)
  if (cached !== null) {
    return { state: 'cached', manifest: cached }
  }
  const baseDir = join(getKovitoboardDir(fs), 'recipes-installed', appId)
  const manifestPath = join(baseDir, 'manifest.json')
  // statSync over existsSync: existsSync silently maps any failure
  // (including EACCES / EPERM / EIO) to false on some platforms,
  // which would route a permission-denied file to the `'absent'`
  // branch and let enable / disable proceed as if no manifest were
  // there. Distinguish `ENOENT` (true absent) from other errnos
  // (`'present-io-failure'`) so the bundled-installer error table
  // emits the spec-normative `BundledLocalStateUnavailable` 503 on
  // the disable path / `BundledManifestUnreadable` 500 on the
  // enable path instead of a misleading `'absent'` short-circuit.
  try {
    fs.statSync(manifestPath)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') return { state: 'absent' }
    return {
      state: 'present-io-failure',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'present-io-failure',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    JSON.parse(raw)
  } catch (err) {
    return {
      state: 'present-parse-failure',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  // Read + parsed OK, but the manifestStore.loadAll() rejected it for
  // schema reasons (validateManifest / I-CR1 enforcement). Treat the
  // same as a parse failure for the bundled-installer error table —
  // either way the on-disk file cannot be promoted to an enabled
  // bundled manifest until the user cleans it up.
  return { state: 'present-parse-failure', detail: 'manifest failed schema validation' }
}

/**
 * Force a disk-level read/parse health probe on
 * `recipes-installed/<appId>/manifest.json` regardless of whether
 * the manifestStore has the appId cached. Used by callers (the
 * disable path / `classifyLocalResidue`) that need to detect
 * post-boot corruption or tampering of the manifest file — the
 * cache reflects boot-time validity, so a cache hit alone cannot
 * guarantee the disk is still healthy at the moment of the check
 * (PR #56 codex attempt 6 Finding "fail-closed check bypass").
 *
 * Distinct from {@link probeManifestOnDisk}: the enable path
 * still uses the cached short-circuit because its goal is to
 * decide whether a manifest *could* exist before deciding to write
 * a new one, not to detect runtime tampering. Splitting the
 * concern keeps the cache-trust invariant intact for the enable
 * path while giving the disable path the fail-closed guarantee
 * spec recipe-system §10.9.4 Step 1 expects.
 *
 * Returns the same `ManifestProbeOutcome` enum, with the
 * `'cached'` variant replaced by a synthetic `'cached'` shape
 * built from a successful disk read — callers that branched on
 * `'cached'` can keep using the manifest object surfaced in the
 * `manifest` field. Note: validateManifest schema enforcement is
 * delegated to manifestStore.loadAll at boot; this probe only
 * checks JSON parse health, identical to the enable-side semantics.
 */
function probeManifestFileOnDisk(
  fs: FileAccessLayer,
  manifestStore: RecipeManifestStore,
  appId: string,
): ManifestProbeOutcome {
  const baseDir = join(getKovitoboardDir(fs), 'recipes-installed', appId)
  const manifestPath = join(baseDir, 'manifest.json')
  try {
    fs.statSync(manifestPath)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') return { state: 'absent' }
    return {
      state: 'present-io-failure',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'present-io-failure',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    JSON.parse(raw)
  } catch (err) {
    return {
      state: 'present-parse-failure',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  // Disk-read succeeded and parsed cleanly. Use the cached manifest
  // as the canonical "present" object when one exists (so downstream
  // coherence checks have the same shape they had under the prior
  // cache-short-circuit semantics); otherwise fall back to treating
  // it as absent — manifestStore.loadAll would have rejected the
  // file on schema grounds at boot, and a manually-planted manifest
  // that bypasses the store is out of v0.2.x scope (same rationale
  // as the cache-trust invariant for the enable path).
  const cached = manifestStore.get(appId)
  if (cached !== null) {
    return { state: 'cached', manifest: cached }
  }
  return { state: 'present-parse-failure', detail: 'manifest present on disk but not registered in manifestStore (post-boot tamper or schema-rejected)' }
}

/**
 * Probe `recipes/<recipeId>/recipe.yaml` for filesystem-level read
 * health. Spec recipe-system v1.10 §10.9.3 Step 3a separates the
 * "asset unreadable" 503 (`BundledRecipeUnreadable`) from the parse
 * failure 503 (`BundledRecipeMalformed`) so the audit-logging /
 * monitoring layer can distinguish a disk fault from a corrupt asset.
 *
 * @throws BundledInstallerError (`BundledRecipeUnreadable` 503) on
 *   any read failure of `recipes/<recipeId>/recipe.yaml`.
 */
function probeBundledRecipeAssetReadable(
  fs: FileAccessLayer,
  kovitoboardRoot: string,
  recipeId: string,
): void {
  const recipeYamlPath = join(kovitoboardRoot, 'recipes', recipeId, 'recipe.yaml')
  try {
    // statSync to surface EACCES / EPERM / ENOTDIR before readFile.
    // We do not actually use the stat result — just the throw path.
    fs.statSync(recipeYamlPath)
    fs.readFileSync(recipeYamlPath, 'utf-8')
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    throw new BundledInstallerError(
      `Failed to read bundled recipe asset for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      503,
      'BundledRecipeUnreadable',
      {
        recipeId,
        errno: code,
        detail: err instanceof Error ? err.message : String(err),
      },
    )
  }
}

/**
 * Outcome of {@link probeAppDirAnomaly}.
 *
 * The five normative anomaly states from spec recipe-system v1.11
 * §10.9.3 Step 3d (ii) plus the two "OK" branches the caller routes
 * to either recovery (partial-residue → Step 4-7) or rejection
 * (self-made → 400 `BundledAppIdConflict`).
 *
 * v1.11 added `symlink-out-of-app-root` (ii-f) for live symlinks
 * whose target resolves outside `<projectRoot>/app/`. The probe
 * verifies path containment via `realpathSync` + `isWithin` before
 * the readdir follows the link, closing the path-escape attack
 * vector PR #56 codex review attempt 1 surfaced.
 */
type AppDirProbeOutcome =
  | { state: 'absent' }
  | { state: 'leftover-temp-dir'; leftoverPath: string }
  | { state: 'non-directory-entry' }
  | { state: 'broken-symlink' }
  | { state: 'symlink-out-of-app-root'; resolvedTarget: string }
  | { state: 'unreadable'; errno?: string; detail: string }
  | { state: 'partial-residue' }
  | { state: 'self-made' }

/**
 * Errno → probe state routing for the symlink resolution stages
 * (`statSync` step 3 and `realpathSync` step 3.5). Spec
 * recipe-system v1.11 §10.9.3 Step 3d (ii-c)/(ii-d) normative pin:
 *
 *   - `ENOENT` / `ELOOP` / `ENOTDIR` (structural resolution
 *     failures) → `broken-symlink` (500). Includes both broken
 *     dangling links and symlink chains that bottom out without a
 *     real target.
 *   - `EACCES` / `EPERM` / `EIO` / `EBUSY` (permission / I/O
 *     availability failures) → `unreadable` (503). Retry-after
 *     friendly because the target may still resolve once the
 *     transient condition clears.
 *   - Any other / missing errno value falls to `unreadable` (503)
 *     so an unfamiliar failure stays on the retry-friendly path
 *     rather than being mis-classified as a structural anomaly.
 */
function classifySymlinkResolveError(err: unknown): AppDirProbeOutcome {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined
  if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
    return { state: 'broken-symlink' }
  }
  return {
    state: 'unreadable',
    errno: code,
    detail: err instanceof Error ? err.message : String(err),
  }
}

/**
 * Probe `<projectRoot>/app/<appId>/` and its sibling paths to decide
 * how the enable transaction Step 3d (ii) should route. The probe
 * order is normative per spec recipe-system v1.11 §10.9.3 Step 3d
 * (ii) (v1.11 added step 2.5 path-boundary verification for live
 * symlinks):
 *
 *   1. Sibling-path leftover temp dir scan (`<appId>.tmp*` /
 *      `<appId>.staging*`) → `leftover-temp-dir` (500).
 *   2. `lstatSync` on the entry to discriminate non-directory and
 *      symbolic-link cases.
 *   3. `statSync` on the resolved target if (2) reported a symlink.
 *      Errno routing (spec v1.11):
 *        `ENOENT` / `ELOOP` / `ENOTDIR` → `broken-symlink` (500)
 *        `EACCES` / `EPERM` / `EIO` / `EBUSY` → `unreadable` (503)
 *   3.5. `realpathSync` + `isWithin(<projectRoot>/app)` containment
 *      check on any live symlink (added in spec v1.11, BL-2026-176).
 *      Same errno routing as step 3. Target outside `app/` →
 *      `symlink-out-of-app-root` (500) — closes the live symlink
 *      path-escape vector PR #56 codex attempt 1 Medium 1 surfaced.
 *   4. `readdirSync` on the resolved directory; failure → `unreadable`
 *      (503).
 *   5. recipe-history.jsonl bundled/sample install record match;
 *      most recent record action `install` → `partial-residue`
 *      (recovery), else → `self-made` (reject).
 *
 * @param fs — file access layer (`existsSync` / `lstatSync` /
 *   `statSync` / `realpathSync` / `readdirSync`).
 * @param projectRoot — the absolute path of the user's project root.
 *   The probe never walks outside `<projectRoot>/app/`; live symlinks
 *   whose target leaves that subtree are rejected by step 3.5.
 * @param appId — the safe-slug appId (already validated by
 *   {@link assertSafeAppId}).
 * @param recipeId — the bundled-eligible recipe id for the install
 *   record match in step 5.
 * @param history — pre-loaded recipe-history.jsonl entries (the
 *   caller already paid the read cost; we reuse it to avoid a second
 *   read).
 */
function probeAppDirAnomaly(
  fs: FileAccessLayer,
  projectRoot: string,
  appId: string,
  recipeId: string,
  history: readonly RecipeHistoryEntry[],
): AppDirProbeOutcome {
  const appBase = join(projectRoot, 'app')
  const appDir = join(appBase, appId)

  // Step 1: sibling-path leftover scan. The temp-dir suffix patterns
  // are owned by the atomic-rename layer of the enable transaction;
  // any sibling matching the prefixes below is a previous attempt
  // that did not finish, and fail-closed is safer than overwriting
  // whatever state it left behind. Skip the scan when `app/` itself
  // does not exist yet — that is a normal new-enable state, not an
  // anomaly. `appBase` will be created by Step 4 mkdirSync below.
  if (fs.existsSync(appBase)) {
    try {
      const siblings = fs.readdirSync(appBase)
      for (const name of siblings) {
        for (const prefix of LEFTOVER_TEMP_DIR_PREFIXES) {
          if (name.startsWith(appId + prefix)) {
            return { state: 'leftover-temp-dir', leftoverPath: join(appBase, name) }
          }
        }
      }
    } catch (err) {
      // `app/` itself unreadable is treated as a generic anomaly so
      // the caller still surfaces a 503; the underlying audit log
      // records the directory path for ops to investigate.
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined
      return {
        state: 'unreadable',
        errno: code,
        detail: `app base ${appBase}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Step 2: entry kind discrimination. `lstatSync` is the only way to
  // tell a symlink apart from its target — `existsSync` follows
  // symlinks and would mistreat a broken link as "absent".
  let lstat: { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }
  try {
    lstat = fs.lstatSync(appDir)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'ENOENT') {
      return { state: 'absent' }
    }
    return {
      state: 'unreadable',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  if (lstat.isSymbolicLink) {
    // Step 3: symlink target resolution. Spec recipe-system v1.11
    // §10.9.3 Step 3d (ii-c)/(ii-d) errno routing: structural
    // resolution failures (ENOENT/ELOOP/ENOTDIR) fall to (ii-c)
    // broken-symlink (500); permission / I/O availability failures
    // (EACCES/EPERM/EIO/EBUSY) fall to (ii-d) unreadable (503).
    // Other errno values default to (ii-d) so unfamiliar failures
    // stay on the retry-friendly 503 path instead of being
    // mis-classified as a structural anomaly.
    try {
      const target = fs.statSync(appDir)
      if (!target.isDirectory) {
        return { state: 'non-directory-entry' }
      }
      // Fallthrough to step 3.5 (realpath + path-boundary check).
    } catch (err) {
      return classifySymlinkResolveError(err)
    }
    // Step 3.5 (spec v1.11 BL-2026-176): live symlink path-boundary
    // verification. `realpathSync` resolves the symlink (and any
    // intermediate components) to an absolute canonical path; the
    // `isWithin` containment check rejects targets outside
    // `<projectRoot>/app/` before step 4's `readdirSync` follows the
    // link. Without this gate a crafted `app/<appId>` symlink would
    // let the probe list (and step 5 act on) an external directory,
    // defeating the spec §10.9.3 fail-closed posture. PR #56 codex
    // review attempt 1 Medium 1 surfaced this; spec v1.11 §10.9.3
    // (ii-f) pins the new state. Same errno routing as step 3.
    const appBoundary = join(projectRoot, 'app')
    let resolvedTarget: string
    try {
      resolvedTarget = fs.realpathSync(appDir)
    } catch (err) {
      return classifySymlinkResolveError(err)
    }
    if (!isWithin(resolvedTarget, appBoundary)) {
      return { state: 'symlink-out-of-app-root', resolvedTarget }
    }
    // Live symlink whose target stays under <projectRoot>/app/ →
    // fallthrough to step 4 (readdirSync via the symlink).
  } else if (!lstat.isDirectory) {
    return { state: 'non-directory-entry' }
  }

  // Step 4: readability probe.
  try {
    fs.readdirSync(appDir)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'unreadable',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  // Step 5: history match (bundled/sample install record most recent).
  // `findHistoryMatchForBundled` already enforces the sourceFilter
  // and the "uninstall cancels the lifecycle" rule.
  const installRecord = findHistoryMatchForBundled(history, recipeId)
  if (installRecord !== undefined) {
    return { state: 'partial-residue' }
  }
  return { state: 'self-made' }
}

/**
 * Bundled-registry presence states reported by
 * {@link probeBundledRegistryPresence}. Drives the disable Step 2
 * `metadata.note` choice per spec recipe-system v1.10 §10.9.4 Step 2.
 *
 * - `'present'` — registry enumerable and contains the recipe id.
 * - `'stale'` — registry enumerable but the recipe id is absent
 *   (typically because a future KB release renamed / removed the
 *   bundled sample). The disable transaction proceeds and the
 *   history append records `metadata.note: 'bundled-registry-stale'`.
 * - `'unavailable'` — registry itself is not enumerable (cache not
 *   initialised, disk error, etc.). Disable proceeds when local
 *   state is present; the history append records
 *   `metadata.note: 'bundled-registry-unavailable'`.
 */
type BundledRegistryPresence = 'present' | 'stale' | 'unavailable'

function probeBundledRegistryPresence(recipeId: string): BundledRegistryPresence {
  let samples: SampleRecipeInfo[]
  try {
    samples = getSampleRecipes()
  } catch {
    return 'unavailable'
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    // An empty cache cannot distinguish "scanned and found nothing"
    // from "scanner cache uninitialised". Treat as `unavailable` so
    // the disable path still proceeds (the metadata.note then records
    // the unavailable lineage for monitoring; a real
    // "no bundled samples at all" deployment is a corner case the
    // spec routes through the same metadata note value).
    return 'unavailable'
  }
  const found = samples.some(
    (s) => s.id === recipeId && s.metadata.recipeId === recipeId,
  )
  return found ? 'present' : 'stale'
}

/**
 * `metadata.note` closed enum for disable history records, per
 * `data-persistence.md` v1.4 §6.3 / spec recipe-system v1.10
 * §10.9.4 Step 2 SSOT.
 */
export type DisableMetadataNote =
  | 'manifest-already-absent'
  | 'bundled-registry-stale'
  | 'bundled-registry-unavailable'

// =========================================
// Local-state classification helpers
// =========================================

/**
 * Outcome of {@link classifyLocalResidue}.
 *
 * Three-value enum (recipe-system v1.10 §10.9.4 SSOT, post-
 * Attempt 13 reduction from the legacy four-value form):
 *
 * - `'none'` — no manifest and no install-action history entry for
 *   the recipe id. Disable should short-circuit with `already-
 *   disabled`.
 * - `'present'` — a manifest, an install record, or both are present
 *   (and coherent enough for the disable transaction to act on).
 * - `'corrupted'` — both a manifest and an install record exist but
 *   their `appId` fields disagree, so removing either side risks
 *   destroying the wrong target.
 */
export type LocalResidueState = 'none' | 'present' | 'corrupted'

interface ClassifyLocalResidueArgs {
  fs: FileAccessLayer
  manifestStore: RecipeManifestStore
  recipeId: string
  /**
   * Optional pre-loaded `recipe-history.jsonl` snapshot. When
   * provided, the function skips the internal probe + read pair and
   * uses the snapshot directly. Disable HTTP handlers thread a
   * single per-request snapshot through both
   * {@link classifyLocalResidue} and
   * {@link resolveBundledAppIdForDisable} to avoid redundant O(n)
   * sync reads of the history file per request (PR #56 codex
   * attempt 2 Finding "resource exhaustion").
   */
  historySnapshot?: RecipeHistorySnapshot
}

/**
 * Decide whether a bundled recipe id has any local install residue
 * worth acting on. Used by the disable endpoint as its Step 1 gate
 * (recipe-system v1.10 §10.9.4 SSOT).
 *
 * Coherence rule: when both a manifest and an install-action
 * history entry are found, their `appId` fields must match. A
 * mismatch is reported as `'corrupted'` so the caller surfaces a
 * 500 + manual-recovery prompt instead of silently deleting one of
 * the two diverging entries.
 *
 * Filesystem-level fail-closed gates (BL-2026-176, spec recipe-system
 * v1.10 §10.9.4 Step 1 fail-closed policy):
 *
 *   - `recipe-history.jsonl` read I/O failure (`EACCES` / `EIO` /
 *     `EPERM` etc.) throws `BundledLocalStateUnavailable` 503 so the
 *     disable endpoint never silently falls through to
 *     `already-disabled` 200 when the disk cannot be read.
 *   - `recipes-installed/<appId>/manifest.json` IO failure also
 *     surfaces as `BundledLocalStateUnavailable` 503; a successful
 *     read followed by a JSON parse failure surfaces as
 *     `BundledManifestUnreadable` 500 (shared with the enable Step
 *     3d (iv) error code).
 */
export function classifyLocalResidue(args: ClassifyLocalResidueArgs): LocalResidueState {
  const { fs, manifestStore, recipeId, historySnapshot } = args

  // Probe IO readability before the silent-skip swallowing in
  // `readRecipeHistory`. A genuine I/O failure must surface as a 503;
  // an empty / absent file is fine (the gate below treats it as
  // "no record"). When a caller-supplied snapshot is present, the
  // probe + parse have already run via `loadRecipeHistorySnapshot`,
  // so we reuse those entries instead of re-reading the file.
  const snapshot = historySnapshot ?? loadRecipeHistorySnapshot(fs)

  const manifest = findManifestByRecipeId(manifestStore, recipeId)
  if (manifest !== null) {
    // Cross-check the on-disk manifest: a cache-hit guarantees the
    // file parsed at boot time, but a corruption introduced after boot
    // (manual edit + signal) would still serve from cache while the
    // file is unreadable. Use the disk-forcing probe so the check
    // actually reaches the filesystem regardless of cache state
    // (PR #56 codex attempt 6 Finding "fail-closed check bypass" —
    // the previous `probeManifestOnDisk` short-circuited on any
    // cache hit, which on the disable path defeated the spec
    // recipe-system §10.9.4 Step 1 fail-closed posture).
    const probe = probeManifestFileOnDisk(fs, manifestStore, manifest.appId)
    if (probe.state === 'present-io-failure') {
      throw new BundledInstallerError(
        `Manifest IO failure for "${recipeId}" (appId="${manifest.appId}")`,
        503,
        'BundledLocalStateUnavailable',
        { fileName: 'manifest.json', appId: manifest.appId, errno: probe.errno, detail: probe.detail },
      )
    }
    if (probe.state === 'present-parse-failure') {
      throw new BundledInstallerError(
        `Manifest parse failure for "${recipeId}" (appId="${manifest.appId}"): ${probe.detail}`,
        500,
        'BundledManifestUnreadable',
        { appId: manifest.appId, detail: probe.detail },
      )
    }
  }

  const installRecord = findHistoryMatchForBundled(snapshot.entries, recipeId)

  const manifestPresent = manifest !== null
  const recordPresent = installRecord !== undefined

  if (!manifestPresent && !recordPresent) {
    return 'none'
  }

  if (manifestPresent && recordPresent) {
    const manifestAppId = manifest.appId
    const recordAppId = installRecord.appId ?? installRecord.recipeId ?? recipeId
    if (manifestAppId !== recordAppId) {
      return 'corrupted'
    }
  }

  return 'present'
}

// =========================================
// Public API: resolve disable target appId
// =========================================

/**
 * Result of {@link resolveBundledAppIdForDisable}. The `appId` is the
 * destructive-path target for the disable transaction; the `source`
 * is the persisted four-value enum subset (`'bundled' | 'sample'`,
 * never `'import'` / `'url'`) used for the ws-event broadcast
 * (`http-api-contract.md` v1.7.1 §6.3.8.B BS-L3-B round-trip);
 * `manifestAlreadyAbsent` flags the partial-residue path so the
 * disable transaction routes to Step 5-only history append + audit
 * log (spec recipe-system v1.10 §10.9.4 Step 2 partial residue).
 */
export interface ResolveBundledAppIdResult {
  appId: string
  source: 'bundled' | 'sample'
  manifestAlreadyAbsent: boolean
}

interface ResolveBundledAppIdArgs {
  fs: FileAccessLayer
  manifestStore: RecipeManifestStore
  recipeId: string
  /**
   * Optional pre-loaded `recipe-history.jsonl` snapshot. See
   * {@link ClassifyLocalResidueArgs.historySnapshot}. Threading a
   * caller-supplied snapshot collapses the worst-case 3× sync history
   * reads (handler classify + resolver classify + resolver fallback)
   * down to a single read shared across the whole request path.
   */
  historySnapshot?: RecipeHistorySnapshot
}

/**
 * Resolve the destructive-path `appId` + persisted `source` for the
 * disable endpoint **before** {@link acquireAppLock} is taken (BL-
 * 2026-176 (a) acquireAppLock integration).
 *
 * The HTTP handler MUST hold the per-appId dispatch lock around the
 * disable transaction so a concurrent `handlerDispatcher`-driven app
 * call cannot run inside an `app/<appId>/` directory that the disable
 * is in the middle of tearing down. The lock key is the appId, but
 * the appId only exists once we have resolved either a bundled/sample
 * manifest or a history install record. This helper performs the
 * minimum read necessary to obtain the appId and surfaces all
 * filesystem-level failures through `BundledInstallerError` so the
 * handler can `try/finally`-release the lock cleanly.
 *
 * Returns `undefined` when neither a manifest nor a bundled/sample
 * install record exists — the handler then short-circuits with
 * `already-disabled` 200 without taking the lock.
 *
 * @throws BundledInstallerError (`BundledLocalStateUnavailable` 503,
 *   `BundledManifestUnreadable` 500, or
 *   `BundledLocalStateCorrupted` 500 via
 *   {@link classifyLocalResidue}).
 */
export function resolveBundledAppIdForDisable(
  args: ResolveBundledAppIdArgs,
): ResolveBundledAppIdResult | undefined {
  const { fs, manifestStore, recipeId, historySnapshot } = args
  // Load (or reuse) the snapshot up-front so the residue classify
  // and the history-backed fallback below share a single read. The
  // worst case (non-bundled-eligible recipeId, no manifest, history-
  // only install record) previously paid 3× `readRecipeHistory`
  // (handler classify + resolver classify + resolver fallback) plus
  // 2× `readFileSync` probes; with the snapshot it pays exactly 1×
  // each (PR #56 codex attempt 2 Finding "resource exhaustion").
  const snapshot = historySnapshot ?? loadRecipeHistorySnapshot(fs)
  const residue = classifyLocalResidue({
    fs,
    manifestStore,
    recipeId,
    historySnapshot: snapshot,
  })
  if (residue === 'none') return undefined
  if (residue === 'corrupted') {
    throw new BundledInstallerError(
      `Local state for "${recipeId}" is corrupted (manifest / history appId mismatch)`,
      500,
      'BundledLocalStateCorrupted',
      { recipeId },
    )
  }
  const manifest = findManifestByRecipeId(manifestStore, recipeId)
  if (manifest !== null) {
    const persisted = narrowPersistedSource(manifest.source)
    const broadcastSource: 'bundled' | 'sample' = persisted === 'sample' ? 'sample' : 'bundled'
    return {
      appId: manifest.appId,
      source: broadcastSource,
      manifestAlreadyAbsent: false,
    }
  }
  const installRecord = findHistoryMatchForBundled(snapshot.entries, recipeId)
  if (installRecord !== undefined) {
    const persisted = narrowPersistedSource(installRecord.source)
    const broadcastSource: 'bundled' | 'sample' = persisted === 'sample' ? 'sample' : 'bundled'
    return {
      appId: installRecord.appId ?? installRecord.recipeId ?? recipeId,
      source: broadcastSource,
      manifestAlreadyAbsent: true,
    }
  }
  // residue === 'present' but neither side resolves — defensive
  // fallback identical to disableBundledRecipe's same-shape guard.
  return undefined
}

interface IsEnabledAndManifestCoherentArgs {
  fs: FileAccessLayer
  manifestStore: RecipeManifestStore
  recipeId: string
  projectRoot: string
}

/**
 * Is the bundled recipe currently enabled with a coherent manifest?
 *
 * Returns true iff a manifest with `source ∈ {'bundled', 'sample'}`
 * exists for the recipe id **and** the `app/<appId>/` directory is
 * present on disk. The latter guards against the
 * "manifest still on disk but artifacts swept by hand" case.
 *
 * Callers (enable endpoint Step 2) short-circuit on a true result
 * with `200 already-enabled` (idempotent no-op, BS-L2 / BS-L2').
 *
 * @see docs/specs/recipe-system.md v1.10 §10.9.5 BS-L2'
 */
export function isEnabledAndManifestCoherent(
  args: IsEnabledAndManifestCoherentArgs,
): boolean {
  const { fs, manifestStore, recipeId, projectRoot } = args
  const manifest = findManifestByRecipeId(manifestStore, recipeId)
  if (manifest === null) {
    return false
  }
  if (manifest.recipeId !== recipeId) {
    return false
  }
  const appDir = join(projectRoot, 'app', manifest.appId)
  return fs.existsSync(appDir)
}

// =========================================
// Public API: enable
// =========================================

export interface EnableBundledRecipeArgs {
  fs: FileAccessLayer
  manifestStore: RecipeManifestStore
  projectRoot: string
  /** KovitoBoard installation root — the source of `recipes/<recipeId>/`. */
  kovitoboardRoot: string
  recipeId: string
  /** Sample registry entry resolved by the caller (pre-validated). */
  sample: SampleRecipeInfo
}

export interface EnableBundledRecipeResult {
  status: 'enabled' | 'already-enabled'
  source: SampleRecipeSourceLabel
  appId: string
}

/**
 * Enable a bundled sample recipe (v0.2.1).
 *
 * Sequential steps (see recipe-system v1.10 §10.9.3):
 *
 *   1. `parseRecipe` the bundled artifacts on disk.
 *   2. Reject if `api.scopes` carries `agents-write` / `skills-write`
 *      (BS-L5, defence in depth — the parser already rejects them).
 *   3. Detect coherent enable → return `already-enabled` (idempotent).
 *   4. Copy artifacts atomically into `app/<appId>/`.
 *   5. Write the manifest (`source: 'bundled'`,
 *      `trustLevel: 'code-trusted (bundled)'`, capture auto-approve).
 *   6. Ensure `app/data/<appId>/` exists.
 *   7. Append install record to `recipe-history.jsonl`.
 *
 * Rollback (BS-L1'): on any post-Step 4 failure we recursively
 * delete the freshly-written `app/<appId>/` and the manifest,
 * leaving `app/data/<appId>/` untouched (BS-L3-A).
 */
export function enableBundledRecipe(
  args: EnableBundledRecipeArgs,
): EnableBundledRecipeResult {
  const { fs, manifestStore, projectRoot, kovitoboardRoot, recipeId, sample } = args

  // Step 2: idempotent gate (BS-L2 / BS-L2').
  if (isEnabledAndManifestCoherent({ fs, manifestStore, recipeId, projectRoot })) {
    const manifest = findManifestByRecipeId(manifestStore, recipeId)
    if (manifest !== null) {
      return {
        status: 'already-enabled',
        source: deriveSourceLabel(manifest),
        appId: manifest.appId,
      }
    }
  }

  // Step 3a (a): probe the bundled recipe asset for IO readability
  // before invoking the parser. spec recipe-system v1.10 §10.9.3
  // Step 3a separates `BundledRecipeUnreadable` 503 (file IO failure)
  // from `BundledRecipeMalformed` 503 (parse failure) so the audit-
  // logging / monitoring layer can distinguish a disk fault from a
  // corrupt asset. Both are server-side faults (KB OSS-distributed
  // assets), but the operational response is different — a disk fault
  // suggests retry / capacity, a malformed asset suggests a bad
  // release build.
  probeBundledRecipeAssetReadable(fs, kovitoboardRoot, recipeId)

  // Step 3a (b): parse the bundled recipe on disk.
  const sourcePath = join(kovitoboardRoot, 'recipes', sample.id)
  let parsed: ParsedRecipe
  try {
    parsed = parseRecipe(sourcePath, fs)
  } catch (err) {
    throw new BundledInstallerError(
      `Failed to parse bundled recipe "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      503,
      'BundledRecipeMalformed',
      { recipeId, detail: err instanceof Error ? err.message : String(err) },
    )
  }

  // Live cache-coherence check. The scanner cache was the basis
  // for the allowlist match (the route handler verified
  // `sample.id === recipeId && sample.metadata.recipeId === recipeId`
  // upstream), but the bundled recipe on disk could have been
  // edited between scan and enable. If `parsed.metadata.recipeId`
  // no longer matches the requested allowlisted `recipeId`, the
  // bundled directory has drifted away from the allowlist
  // contract — refuse to mint a `code-trusted (bundled)` manifest
  // for it and ask the caller to rescan.
  if (parsed.metadata.recipeId !== recipeId) {
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" parsed metadata.recipeId "${parsed.metadata.recipeId}" no longer matches the allowlist`,
      503,
      'BundledRegistryStaleCache',
      { recipeId, parsedRecipeId: parsed.metadata.recipeId },
    )
  }

  // Step 3b: scope validation (BS-L5). The parser already rejects
  // unknown scopes, but we re-check here so the bundled-installer
  // contract stands on its own (recipe-system v1.10 §10.9.5).
  const forbidden = (parsed.api?.scopes ?? []).filter(
    (scope) => scope === 'agents-write' || scope === 'skills-write',
  )
  if (forbidden.length > 0) {
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" declares forbidden scopes: ${forbidden.join(', ')}`,
      400,
      'BundledScopeForbidden',
      { recipeId, forbiddenScopes: forbidden },
    )
  }

  // appId picks the bundled-registry id by default (BS-L9). The
  // collision check is **source-scoped** (recipe-system v1.10
  // §10.9.3 Step 3d (i)): a non-bundled / non-sample manifest at
  // the target appId is a hard conflict regardless of whether its
  // `recipeId` happens to match, because the bundled-installer
  // must not overwrite an `'import'` / `'url'` install. Within the
  // bundled/sample source-scoped subset a `recipeId` mismatch is
  // still a conflict (two different bundled recipes claiming the
  // same appId); only a same-`recipeId` bundled/sample residue is
  // allowed to fall through to the Step 5 overwrite recovery.
  const appId = sample.id
  // Defence-in-depth: validate the appId format + resolution
  // boundary before any subsequent path operation. The
  // bundled-registry enforces the format upstream, but a future
  // refactor that loosens the registry-side check should not be
  // able to silently weaken the destructive-path boundary here.
  assertSafeAppId(projectRoot, appId)

  // RecipeId-keyed residue check (recipe-system v1.10 §10.9.3
  // Step 3d (iii) SSOT). The Step 2 coherence gate short-circuits
  // the coherent case; reaching here means any bundled/sample
  // manifest already on disk for this recipeId is non-coherent
  // residue. If the residue lives under a *different* appId from
  // the bundled-registry id, silently writing a second manifest
  // would brick later enable/disable calls with
  // BundledManifestUniquenessViolation. Detect the cross-appId
  // residue and reject with a dedicated conflict so the user can
  // clean up by hand — automatic reconciliation across appId
  // boundaries belongs to the Phase 1 edge-case PR.
  const recipeIdScopedResidue = findManifestByRecipeId(manifestStore, recipeId)
  if (
    recipeIdScopedResidue !== null &&
    recipeIdScopedResidue.appId !== appId
  ) {
    throw new BundledInstallerError(
      `Existing ${recipeIdScopedResidue.source ?? 'bundled/sample'} manifest for recipeId "${recipeId}" lives under a different appId "${recipeIdScopedResidue.appId}"`,
      400,
      'BundledAppIdConflict',
      {
        recipeId,
        targetAppId: appId,
        existingAppId: recipeIdScopedResidue.appId,
        conflictSource: 'cross-appid-residue',
      },
    )
  }

  // Probe the manifest on disk: spec recipe-system v1.10 §10.9.3
  // Step 3d (iv) routes a read-success-but-parse-failure to a 500
  // `BundledManifestUnreadable`. The manifestStore cache silently
  // skips malformed manifests at load time, so a cache miss is not
  // enough to distinguish "absent" from "present-but-corrupt".
  const manifestProbe = probeManifestOnDisk(fs, manifestStore, appId)
  if (manifestProbe.state === 'present-io-failure') {
    throw new BundledInstallerError(
      `Existing manifest IO failure for appId "${appId}"`,
      503,
      'BundledLocalStateUnavailable',
      { fileName: 'manifest.json', appId, errno: manifestProbe.errno, detail: manifestProbe.detail },
    )
  }
  if (manifestProbe.state === 'present-parse-failure') {
    throw new BundledInstallerError(
      `Existing manifest parse failure for appId "${appId}": ${manifestProbe.detail}`,
      500,
      'BundledManifestUnreadable',
      { appId, detail: manifestProbe.detail },
    )
  }
  const existingManifest = manifestProbe.state === 'cached' ? manifestProbe.manifest : null
  if (existingManifest !== null) {
    const existingSource = existingManifest.source
    if (existingSource !== 'bundled' && existingSource !== 'sample') {
      throw new BundledInstallerError(
        `appId "${appId}" is already taken by a ${existingSource ?? 'pre-v0.2.1'} install`,
        400,
        'BundledAppIdConflict',
        { appId, conflictSource: existingSource ?? 'pre-v0.2.1' },
      )
    }
    if (existingManifest.recipeId !== recipeId) {
      throw new BundledInstallerError(
        `appId "${appId}" is already taken by recipe "${existingManifest.recipeId}"`,
        400,
        'BundledAppIdConflict',
        { appId, conflictSource: 'recipe-id-mismatch' },
      )
    }
    // Same recipeId + bundled/sample source → fall through to
    // overwrite (Step 5). The Step 2 coherence gate above already
    // short-circuits the *coherent* case, so reaching here means
    // the existing manifest is non-coherent and worth re-establishing.
  }

  // Step 4: artifacts copy. The bundled-installer must own the
  // entire `app/<appId>/` directory contents — anything left behind
  // from a previous incarnation would otherwise be promoted to
  // `code-trusted (bundled)` along with the freshly-written files.
  //
  // - New enable (no existing manifest): the appDir must follow the
  //   probe order in spec recipe-system v1.10 §10.9.3 Step 3d (ii):
  //   sibling leftover scan → entry-kind → symlink target → readdir →
  //   history match. The probe routes the four anomaly cases to
  //   `BundledAppIdConflictAnomaly`, the readable-but-no-install
  //   case to `BundledAppIdConflict` (`'self-made'`), and the
  //   readable-with-install case to the partial-residue recovery
  //   path (Step 4-7 executed as if it were a regular enable, so
  //   `code-trusted (bundled)` only wraps freshly-written files).
  // - Recovery (existing bundled/sample manifest, non-coherent):
  //   wipe the appDir first and rebuild from scratch. The matching
  //   `app/data/<appId>/` is on a sibling path and stays untouched
  //   (BS-L3-A).
  const appDir = join(projectRoot, 'app', appId)
  let isRecoveryPath = existingManifest !== null
  if (!isRecoveryPath) {
    // Reuse the history read inside the anomaly probe so we don't
    // pay the file read cost twice when partial-residue recovery
    // falls through to Step 4-7.
    //
    // Use the throwing snapshot loader rather than `readRecipeHistory`
    // directly: the latter swallows IO failures and returns `[]` by
    // contract (best-effort scanner semantics), which would silently
    // downgrade an unreadable `recipe-history.jsonl` into a "no
    // history" reading. The partial-residue probe relies on knowing
    // whether the history is genuinely empty vs unreadable to decide
    // between `self-made` and `partial-residue` recovery; the silent
    // downgrade would block legitimate recovery and hide local-state
    // read failures from the operator. Surfacing the IO failure as
    // 503 `BundledLocalStateUnavailable` keeps the enable path's
    // fail-closed posture symmetric with the disable path (PR #56
    // codex attempt 3 Finding "fail-open local state probe").
    const historyForProbe = loadRecipeHistorySnapshot(fs).entries
    const probe = probeAppDirAnomaly(fs, projectRoot, appId, recipeId, historyForProbe)
    switch (probe.state) {
      case 'absent':
        // Normal new-enable path — nothing to clean up before
        // mkdir below.
        break
      case 'leftover-temp-dir':
        throw new BundledInstallerError(
          `Leftover temp dir blocks enable for "${recipeId}" (appId="${appId}"): ${probe.leftoverPath}`,
          500,
          'BundledAppIdConflictAnomaly',
          { recipeId, appId, anomalyType: 'leftover-temp-dir', leftoverPath: probe.leftoverPath },
        )
      case 'non-directory-entry':
        throw new BundledInstallerError(
          `appDir "${appDir}" exists as a non-directory entry`,
          500,
          'BundledAppIdConflictAnomaly',
          { recipeId, appId, anomalyType: 'non-directory-entry' },
        )
      case 'broken-symlink':
        throw new BundledInstallerError(
          `appDir "${appDir}" is a broken symlink`,
          500,
          'BundledAppIdConflictAnomaly',
          { recipeId, appId, anomalyType: 'broken-symlink' },
        )
      case 'symlink-out-of-app-root':
        // Spec recipe-system v1.11 §10.9.3 Step 3d (ii-f): live
        // symlink whose realpath leaves `<projectRoot>/app/`. The
        // throw keeps step 3 `readdirSync` from ever running on the
        // external target. The structured `resolvedTarget` field is
        // returned to the client (and the audit log) so ops can
        // pinpoint the offending link without a separate fs probe.
        // The audit event name is normative
        // (`bundled-symlink-out-of-app-root`, spec v1.11 §10.9.3).
        recipeLogger.error(
          {
            event: 'bundled-symlink-out-of-app-root',
            recipeId,
            appId,
            resolvedTarget: probe.resolvedTarget,
          },
          'Bundled enable rejected: live symlink target is outside <projectRoot>/app/',
        )
        throw new BundledInstallerError(
          `appDir "${appDir}" is a live symlink whose target "${probe.resolvedTarget}" is outside <projectRoot>/app/`,
          500,
          'BundledAppIdConflictAnomaly',
          {
            recipeId,
            appId,
            anomalyType: 'symlink-out-of-app-root',
            resolvedTarget: probe.resolvedTarget,
          },
        )
      case 'unreadable':
        throw new BundledInstallerError(
          `appDir "${appDir}" is unreadable: ${probe.detail}`,
          503,
          'BundledAppIdConflictAnomaly',
          { recipeId, appId, anomalyType: 'unreadable', errno: probe.errno, detail: probe.detail },
        )
      case 'self-made':
        throw new BundledInstallerError(
          `appId "${appId}" is a user-authored ('self-made') app — bundled enable is not the recovery path`,
          400,
          'BundledAppIdConflict',
          { recipeId, appId, conflictSource: 'self-made' },
        )
      case 'partial-residue':
        // Promote to the recovery path so Step 4 below wipes the
        // partial residue and Step 5 overwrites the (absent)
        // manifest with a freshly-minted one. Spec recipe-system
        // v1.10 §10.9.3 Step 3d (ii-a-partial-residue) treats this
        // as a successful enable response (`status: 'enabled'`).
        isRecoveryPath = true
        break
    }
  }
  if (isRecoveryPath && fs.existsSync(appDir)) {
    // Drop stale / tampered residue from the previous incarnation
    // before the new artifacts land. `app/data/<appId>/` is on a
    // sibling path (`app/data/`, not `app/`) so this rm does not
    // touch user data.
    tryRm(fs, appDir)
  }
  const writtenArtifactPaths: string[] = []
  try {
    fs.mkdirSync(appDir, { recursive: true })
    for (const artifact of parsed.artifacts) {
      const destPath = join(appDir, artifact.path)
      const destDir = dirname(destPath)
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true })
      }
      fs.writeFileAtomic(destPath, artifact.content)
      writtenArtifactPaths.push(artifact.path)
    }
  } catch (err) {
    // Rollback Step 4: remove the partial `app/<appId>/` directory.
    // We always created (or recreated) it above, so it is safe to
    // wipe — the data dir lives at the sibling `app/data/<appId>/`.
    tryRm(fs, appDir)
    throw new BundledInstallerError(
      `Failed to copy bundled artifacts for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      500,
      'EnableCopyFailed',
      { recipeId, appId },
    )
  }

  // Step 5: manifest write (`source: 'bundled'`,
  // `trustLevel: 'code-trusted (bundled)'`).
  const captureRequires = parsed.capture?.requires ?? []
  // The parser surfaces `api.scopes` as `string[]` because recipe.yaml
  // is user-authored; by this point validateApiSection() (called from
  // parseRecipe) has already verified every scope is a Scope literal,
  // so the narrowing cast is sound.
  const apiScopes: Scope[] = (parsed.api?.scopes ?? []) as Scope[]
  const apiSection: ApiSection = parsed.api
    ? {
        scopes: apiScopes,
        calls: parsed.api.calls.map((c) => ({
          id: c.id,
          handler: c.handler as ApiSection['calls'][number]['handler'],
          args: c.args,
        })),
      }
    : { scopes: [], calls: [] }
  const manifest: RecipeManifest = {
    appId,
    recipeId,
    recipeVersion: parsed.metadata.version,
    hash: parsed.hash,
    installedAt: new Date().toISOString(),
    approvedScopes: apiScopes,
    api: apiSection,
    captureRequires,
    approvedCaptures: [...captureRequires], // auto-approve (BS-L4)
    trustLevel: 'code-trusted (bundled)',
    source: 'bundled',
  }
  try {
    manifestStore.save(manifest)
  } catch (err) {
    // Step 4 always created (or re-created) appDir, so it is safe
    // to wipe on rollback — `app/data/<appId>/` is on a sibling
    // path and stays put (BS-L3-A).
    tryRm(fs, appDir)
    throw new BundledInstallerError(
      `Failed to write manifest for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      500,
      'EnableManifestWriteFailed',
      { recipeId, appId },
    )
  }

  // Step 6: ensure `app/data/<appId>/` exists (re-enable preserves
  // existing user data per BS-L3-A).
  const dataDir = join(projectRoot, 'app', 'data', appId)
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  } catch (err) {
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    throw new BundledInstallerError(
      `Failed to create data dir for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      500,
      'EnableDataDirMkdirFailed',
      { recipeId, appId },
    )
  }

  // Step 7: history append.
  const historyEntry: RecipeHistoryEntry = {
    id: generateHistoryId(fs),
    action: 'install',
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    author: parsed.metadata.author,
    source: 'bundled',
    hash: parsed.hash,
    appliedAt: manifest.installedAt,
    artifacts: writtenArtifactPaths,
    menu: (parsed.menu ?? []).map((m) => m.id),
    recipeId,
    appId,
  }
  try {
    appendRecipeHistory(fs, historyEntry)
  } catch (err) {
    // History append fails *after* manifest + artifacts are committed.
    // Best-effort rollback: tear down both so the next call sees a
    // clean slate. Data dir stays put (BS-L3-A).
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    throw new BundledInstallerError(
      `Failed to append history for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
      500,
      'EnableHistoryAppendFailed',
      { recipeId, appId },
    )
  }

  return { status: 'enabled', source: 'bundled', appId }
}

// =========================================
// Public API: disable
// =========================================

export interface DisableBundledRecipeArgs {
  fs: FileAccessLayer
  manifestStore: RecipeManifestStore
  projectRoot: string
  recipeId: string
  /**
   * Optional pre-loaded `recipe-history.jsonl` snapshot. When
   * provided, the locked transaction reuses the same parsed history
   * across `classifyLocalResidue` and the `findHistoryMatchForBundled`
   * fallback, avoiding the redundant sync reads + parses on the
   * lock-held hot path that the disable HTTP handler's pre-lock
   * snapshot was already paying for (PR #56 codex attempt 6 Finding
   * "resource exhaustion" — the snapshot optimization previously
   * stopped at the lock boundary).
   */
  historySnapshot?: RecipeHistorySnapshot
}

export interface DisableBundledRecipeResult {
  status: 'disabled' | 'already-disabled'
  dataPreserved: boolean
  appId?: string
  /**
   * Persisted manifest source of the just-disabled record, surfaced
   * for ws-event broadcasting (BS-L3-B round-trip). Always `'bundled'`
   * for bundled-enable lineage and `'sample'` for grandfather-sample
   * lineage. Omitted for `already-disabled` results (no manifest was
   * present to read the source from).
   *
   * @see docs/specs/http-api-contract.md v1.7.1 §6.3.8.B (broadcast)
   */
  source?: 'bundled' | 'sample'
  /**
   * Closed-enum `metadata.note` per `data-persistence.md` v1.4 §6.3:
   *
   *   - `'manifest-already-absent'` — disable completed with no
   *     manifest on disk (partial residue path, spec recipe-system
   *     v1.10 §10.9.4 Step 2 partial residue).
   *   - `'bundled-registry-stale'` — local manifest existed but the
   *     bundled registry no longer lists the recipe id (typically a
   *     future KB release rename / removal).
   *   - `'bundled-registry-unavailable'` — local manifest existed
   *     but the registry itself was not enumerable (scanner cache
   *     uninitialised, disk IO error). The disable still proceeds
   *     to clean up the local state.
   *
   * Multiple notes are mutually exclusive — the disable transaction
   * picks the most specific one (manifest-already-absent overrides
   * registry status, which in turn overrides the present-and-OK case
   * where `metadata` is simply omitted).
   */
  metadata?: { note?: DisableMetadataNote }
}

/**
 * Disable a bundled sample recipe (v0.2.1).
 *
 * Sequential steps (recipe-system v1.10 §10.9.4):
 *
 *   1. `classifyLocalResidue` — short-circuit on `'none'`
 *      (`already-disabled`); throw on `'corrupted'`.
 *   2. Delete `app/<appId>/` (artifacts only; data is preserved per
 *      BS-L3-A).
 *   3. Delete the manifest.
 *   4. Append an uninstall record to `recipe-history.jsonl` with
 *      `source = <persisted manifest.source>` and
 *      `ownDataDeleted: false`.
 *
 * The disable transaction is best-effort + ordering-normative: each
 * step is independently retry-safe so a client retry after a 500
 * picks up where the previous attempt left off.
 */
export function disableBundledRecipe(
  args: DisableBundledRecipeArgs,
): DisableBundledRecipeResult {
  const { fs, manifestStore, projectRoot, recipeId, historySnapshot } = args

  // Load (or reuse) the snapshot once for the whole transaction so
  // the locked critical section pays the history read cost at most
  // once. The HTTP handler already passes its pre-lock snapshot
  // through `args.historySnapshot`; standalone callers (tests, future
  // CLI entry points) fall back to a fresh load (PR #56 codex
  // attempt 6 Finding "resource exhaustion").
  const snapshot = historySnapshot ?? loadRecipeHistorySnapshot(fs)

  // Step 1: local-state classification.
  const residue = classifyLocalResidue({
    fs,
    manifestStore,
    recipeId,
    historySnapshot: snapshot,
  })
  if (residue === 'none') {
    return { status: 'already-disabled', dataPreserved: true }
  }
  if (residue === 'corrupted') {
    throw new BundledInstallerError(
      `Local state for "${recipeId}" is corrupted (manifest / history appId mismatch)`,
      500,
      'BundledLocalStateCorrupted',
      { recipeId },
    )
  }

  const manifest = findManifestByRecipeId(manifestStore, recipeId)
  const installRecord = findHistoryMatchForBundled(snapshot.entries, recipeId)

  // Resolve appId + source from whichever side is present.
  // Fail-closed: when the manifest is present we trust its appId
  // (and its persisted `source`); otherwise we fall back to the
  // install-record (manifest-already-absent path).
  //
  // The persisted `source` round-trip is BS-L3-B: a grandfather
  // sample (manifest.source === 'sample') must emit `source:
  // 'sample'` in the uninstall record so the next already-disabled
  // lookup matches the same source-scoped subset.
  let appId: string
  let persistedSource: 'sample' | 'bundled' | 'import' | 'url'
  let manifestAlreadyAbsent = false
  if (manifest !== null) {
    appId = manifest.appId
    persistedSource = narrowPersistedSource(manifest.source)
  } else if (installRecord !== undefined) {
    appId = installRecord.appId ?? installRecord.recipeId ?? recipeId
    persistedSource = narrowPersistedSource(installRecord.source)
    manifestAlreadyAbsent = true
  } else {
    // classifyLocalResidue returned 'present' but neither side
    // is actually present — should not happen, but guard.
    return { status: 'already-disabled', dataPreserved: true }
  }

  // Path-boundary check: `appId` comes from persisted state
  // (manifest store and/or recipe-history.jsonl). A tampered record
  // could otherwise drive the recursive `rmSync` below outside
  // `<projectRoot>/app/`. Fail-closed before any filesystem write
  // so even a corrupted state cannot escalate to arbitrary deletion.
  assertSafeAppId(projectRoot, appId)

  // Step 2: probe bundled-registry presence so the history append
  // below records `metadata.note: 'bundled-registry-stale' |
  // 'bundled-registry-unavailable'` per spec recipe-system v1.10
  // §10.9.4 Step 2 SSOT. `manifest-already-absent` (partial residue
  // path) overrides the registry note because the artifacts +
  // manifest are gone anyway — registry state is moot for that case.
  const registryPresence = manifestAlreadyAbsent
    ? null
    : probeBundledRegistryPresence(recipeId)
  let metadataNote: DisableMetadataNote | undefined
  if (manifestAlreadyAbsent) {
    metadataNote = 'manifest-already-absent'
  } else if (registryPresence === 'stale') {
    metadataNote = 'bundled-registry-stale'
    recipeLogger.warn(
      { recipeId, appId, persistedSource },
      '[bundled-installer] disable: bundled registry stale (event=bundled-registry-stale-disable)',
    )
  } else if (registryPresence === 'unavailable') {
    metadataNote = 'bundled-registry-unavailable'
    recipeLogger.warn(
      { recipeId, appId, persistedSource },
      '[bundled-installer] disable: bundled registry unavailable (event=bundled-registry-unavailable-disable)',
    )
  }

  // Step 3: delete `app/<appId>/` (artifacts only).
  //
  // Critical: in the history-only path (`manifestAlreadyAbsent ===
  // true`) the manifest store does not corroborate that
  // `app/<appId>/` still belongs to *this* bundled recipe. If the
  // manifest was removed earlier and the same `appId` was later
  // reused by another app — self-made or imported — running
  // `rmSync` here would delete that unrelated app. Spec
  // recipe-system v1.10 §10.9.4 SSOT routes the history-only case
  // to "Step 5 only" (history append + audit log warning,
  // `metadata.note: 'manifest-already-absent'`); the artifacts are
  // assumed to be gone already because the manifest is. Honour
  // that by skipping the `rmSync` whenever we cannot prove
  // ownership through a live manifest.
  const appDir = join(projectRoot, 'app', appId)
  if (!manifestAlreadyAbsent && fs.existsSync(appDir)) {
    try {
      fs.rmSync(appDir, { recursive: true, force: true })
    } catch (err) {
      throw new BundledInstallerError(
        `Failed to remove artifacts for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
        500,
        'DisableArtifactsRemovalFailed',
        { recipeId, appId },
      )
    }
  }

  // Step 4: delete the manifest.
  if (manifest !== null) {
    try {
      manifestStore.delete(appId)
    } catch (err) {
      throw new BundledInstallerError(
        `Failed to delete manifest for "${recipeId}": ${err instanceof Error ? err.message : String(err)}`,
        500,
        'DisableManifestRemovalFailed',
        { recipeId, appId },
      )
    }
  }

  // Step 5: history append.
  // `name` is a localized display field — prefer the install
  // record's stored display name so the uninstall row keeps the
  // human-readable label, never the machine `recipeId`. The
  // ultimate fallback is `recipeId` only when no install record
  // has ever existed (registry-stale grandfather sample path).
  const historyEntry: RecipeHistoryEntry = {
    id: generateHistoryId(fs),
    action: 'uninstall',
    name: installRecord?.name ?? recipeId,
    version: manifest?.recipeVersion ?? installRecord?.version ?? '0.0.0',
    source: persistedSource,
    hash: manifest?.hash ?? installRecord?.hash ?? '',
    appliedAt: new Date().toISOString(),
    artifacts: [],
    menu: [],
    recipeId,
    appId,
    ownDataDeleted: false,
    ...(metadataNote !== undefined ? { metadata: { note: metadataNote } } : {}),
  }
  try {
    appendRecipeHistory(fs, historyEntry)
  } catch (err) {
    // Best-effort: surface a warning but return 200 (per spec)
    // because the artifacts + manifest have already been removed.
    recipeLogger.warn(
      { err, recipeId, appId },
      '[bundled-installer] disable: failed to append history record',
    )
  }

  // BS-L3-B: round-trip the persisted source so the ws-event
  // broadcast and consumers downstream can tell a grandfather-
  // sample disable apart from a fresh bundled one. `narrowPersistedSource`
  // already coerced any out-of-set value to `'bundled'`; we further
  // narrow to the `'bundled' | 'sample'` subset because the
  // bundled-installer never reaches this point with `'import'` /
  // `'url'` (those paths fail closed in `findManifestByRecipeId`
  // and `findHistoryMatchForBundled`).
  const broadcastSource: 'bundled' | 'sample' =
    persistedSource === 'sample' ? 'sample' : 'bundled'
  return {
    status: 'disabled',
    dataPreserved: true,
    appId,
    source: broadcastSource,
    ...(metadataNote !== undefined ? { metadata: { note: metadataNote } } : {}),
  }
}

// =========================================
// Internal helpers
// =========================================

/**
 * Look up the single bundled/sample manifest for a `recipeId` and
 * fail-closed when more than one matches.
 *
 * Source-scoped uniqueness is a v0.2.1 normative invariant
 * (recipe-system v1.10 §10.9.3 Step 2 / Step 5, BS-L2' lookup
 * semantics): exactly one of `{ bundled, sample }` per `recipeId`.
 * A duplicate is a corruption signal — picking the first match
 * would let `disableBundledRecipe` tear down an arbitrary app and
 * leave the duplicate behind. Throwing surfaces the corruption to
 * the user (`BundledManifestUniquenessViolation` 500) so they can
 * clean up `recipes-installed/` by hand.
 */
function findManifestByRecipeId(
  manifestStore: RecipeManifestStore,
  recipeId: string,
): RecipeManifest | null {
  const matches: RecipeManifest[] = []
  for (const manifest of manifestStore.list()) {
    if (manifest.recipeId === recipeId && isBundledOrSample(manifest.source)) {
      matches.push(manifest)
    }
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]
  throw new BundledInstallerError(
    `Multiple bundled/sample manifests for recipeId "${recipeId}" — manual cleanup required`,
    500,
    'BundledManifestUniquenessViolation',
    {
      recipeId,
      foundAppIds: matches.map((m) => m.appId),
    },
  )
}

/**
 * Look up the latest bundled/sample install record for a `recipeId`.
 *
 * Matches **only** on the canonical `RecipeHistoryEntry.recipeId`
 * field. `entry.name` is a localized display string (v0.1.x history
 * even stored it in the user's locale) — keying a destructive
 * operation off display text would let a tampered or hand-edited
 * row become authoritative input for the disable transaction, which
 * then walks into `rmSync(app/<appId>)`. Pre-recipeId-era history
 * rows are not migrated by this PR; they remain inaccessible to
 * the bundled-installer until a dedicated migration ships.
 */
function findHistoryMatchForBundled(
  history: readonly RecipeHistoryEntry[],
  recipeId: string,
): RecipeHistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry.recipeId !== recipeId) continue
    if (!isBundledOrSample(entry.source)) continue
    const action = entry.action ?? 'install'
    if (action === 'install') return entry
    // The most recent record for this recipeId is an uninstall →
    // there is no longer an install record in effect.
    return undefined
  }
  return undefined
}

function isBundledOrSample(
  source: string | undefined,
): source is 'bundled' | 'sample' {
  return source === 'bundled' || source === 'sample'
}

/**
 * Narrow a manifest-or-history `source` field into the persisted
 * four-value enum. The bundled-installer only operates on the
 * `'bundled'` / `'sample'` subset, but we keep `'import'` / `'url'`
 * round-trippable for any future cross-source disable surface;
 * `undefined` or any other value falls back to `'bundled'` so the
 * uninstall record still parses (the disable transaction is best-
 * effort + ordering-normative, recipe-system v1.10 §10.9.4 SSOT).
 */
function narrowPersistedSource(
  source: string | undefined,
): 'sample' | 'bundled' | 'import' | 'url' {
  if (source === 'sample' || source === 'bundled' || source === 'import' || source === 'url') {
    return source
  }
  return 'bundled'
}

/**
 * Map a persisted manifest to its UI-facing source label.
 * Grandfather samples (`source: 'sample'`) surface as
 * `'sample (grandfather)'`; current bundled enables surface as
 * `'bundled'`. The persisted field is never rewritten (BS-L2).
 */
function deriveSourceLabel(manifest: RecipeManifest): SampleRecipeSourceLabel {
  type ExtendedSource = RecipeManifest & { source?: string }
  const persisted = (manifest as ExtendedSource).source
  if (persisted === 'sample') return 'sample (grandfather)'
  return 'bundled'
}

function tryRm(fs: FileAccessLayer, path: string): void {
  try {
    fs.rmSync(path, { recursive: true, force: true })
  } catch (err) {
    recipeLogger.warn(
      { err, path },
      '[bundled-installer] rollback rmSync failed (best-effort)',
    )
  }
}

function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx === -1) return '.'
  if (idx === 0) return path.slice(0, 1)
  return path.slice(0, idx)
}

// Re-export for the route handler to introspect.
export { getKovitoboardDir }
