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
import type { AppManifest } from '../../shared/app-manifest-types'
import {
  getAppManifestPath,
  isAppManifest,
  writeAppManifest,
} from './app-manifest'
import { isCanonicalAppIdPath } from './menu-extractor'
import {
  appendMenuEntry,
  buildEmptyMenuTs,
  MenuTsParseFailedError,
  removeMenuEntry,
  type AppendMenuEntryInput,
} from './menu-ts-editor'
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
// KovitoBoard version lookup (Phase 1.5, BL-2026-179)
// =========================================

/**
 * Best-effort lookup of the running KovitoBoard version. Used by the
 * Step 5.5 `AppManifest` write (spec recipe-system v1.12 §10.9.3 +
 * `app-directory-extension.md` v1.6 §6.2) to record the
 * `kovitoboardVersion` field. The spec allows either
 * `process.env.npm_package_version` (set by `npm run start`) or the
 * `package.json` `version` field; we prefer the env var because it is
 * already exposed by the build system, and fall back to a final
 * `'0.0.0'` placeholder only when both are unavailable (test harnesses
 * that import the helper without the harness env).
 */
function resolveKovitoboardVersion(): string {
  const env = process.env.npm_package_version
  if (typeof env === 'string' && env.length > 0) return env
  // Avoid synchronous filesystem reads here — the env var is what the
  // build system uses, and a missing env in a test harness should
  // surface as a recognisable sentinel rather than crashing the
  // enable transaction. Spec recipe-system v1.12 §10.9.3 Step 5.5
  // does not normatively pin the placeholder; `'0.0.0'` matches the
  // existing convention used by `disableBundledRecipe`'s history
  // append for unknown recipe versions.
  return '0.0.0'
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
 * Outcome of {@link probeAppRootAnomaly}.
 *
 * Five normative anomaly states from spec recipe-system v1.12
 * §10.9.3 Step 1.5 (endpoint-entry fail-closed gate) plus the
 * "ok" branch the caller falls through to Step 2.
 *
 * Spec rationale (BL-2026-177 same-PR resolution): the probe runs
 * once per enable invocation at the endpoint entry so every
 * downstream path-boundary check (Step 3d (ii) probe, Step 4 artifact
 * copy, Step 5.5 AppManifest write, Step 5.6 menu.ts write) executes
 * against a verified `<projectRoot>/app/` directory. Without this
 * gate, an attacker / misconfiguration that planted `app` as a
 * symlink to an external directory would let every per-entry check
 * pass while the bulk of the transaction wrote into the foreign tree.
 *
 * The seven states map 1:1 to the spec error table:
 *
 *   - `'ok'` — `<projectRoot>/app/` either does not exist (normal
 *     new-project state — Step 4 mkdirSync handles creation) or is a
 *     regular directory with no leftover-temp siblings (Step 1.5
 *     leftover scan). Fall through to Step 2.
 *   - `'app-root-symlink'` — `<projectRoot>/app/` itself is a
 *     symbolic link. 500 `BundledRegistryAnomaly`.
 *   - `'app-root-non-directory'` — `<projectRoot>/app/` exists as a
 *     regular file / FIFO / socket etc. 500.
 *   - `'app-root-broken-symlink'` — `<projectRoot>/app/` is a
 *     symbolic link whose realpath surfaces `ENOENT` / `ELOOP` /
 *     `ENOTDIR`. 500 (structural resolution failure).
 *   - `'app-root-unreadable'` — `<projectRoot>/app/` cannot be
 *     stat-ed / read with errno `EACCES` / `EPERM` / `EIO` / `EBUSY`
 *     etc. 503 (retry-after — transient I/O fault).
 *   - `'project-root-unreadable'` — `<projectRoot>` itself is
 *     unreadable. 503 (same retry-after envelope).
 *   - `'app-root-leftover-temp'` — sibling `<appId>.tmp*` /
 *     `<appId>.staging*` directory exists. 500 (previous transaction
 *     left a temp directory behind; user must clean it up by hand).
 *     Carries `leftoverPath` so the audit log records the offending
 *     path without needing a second filesystem probe.
 */
type AppRootAnomalyOutcome =
  | { state: 'ok' }
  | { state: 'app-root-symlink' }
  | { state: 'app-root-non-directory' }
  | { state: 'app-root-broken-symlink' }
  | { state: 'app-root-unreadable'; errno?: string; detail: string }
  | { state: 'project-root-unreadable'; errno?: string; detail: string }
  | { state: 'app-root-leftover-temp'; leftoverPath: string }

/**
 * Probe `<projectRoot>/app/` (the app-root directory itself) for the
 * five anomaly states pinned by spec recipe-system v1.12 §10.9.3
 * Step 1.5 (the new endpoint-entry fail-closed gate that resolves
 * BL-2026-177 in the same PR as the rest of Phase 1.5 completion).
 *
 * Step ordering (normative, mirrors apps-routes `verifyAppRoot` from
 * PR #57 attempt 11 — different surface, identical semantics):
 *
 *   1. `lstatSync(<projectRoot>)` — surface a 503 if the parent
 *      directory is itself unreadable.
 *   2. `existsSync(<projectRoot>/app)`. Absent → `'ok'` (Step 4 will
 *      create it).
 *   3. `lstatSync(<projectRoot>/app)`. Symlink → step 4; non-dir →
 *      `'app-root-non-directory'`.
 *   4. Symlink target resolution via `realpathSync`. Errno-routed
 *      to `'app-root-broken-symlink'` (structural) or
 *      `'app-root-unreadable'` (permission / I/O).
 *   5. Real-directory case: `readdirSync` to enumerate siblings, scan
 *      for `<appId>.tmp*` / `<appId>.staging*`.
 *
 * @param fs — file access layer.
 * @param projectRoot — the absolute path of the user's project root.
 * @param appId — the bundled-registry default appId for the enable
 *   transaction; used to bound the leftover-temp sibling scan to the
 *   directory the next steps actually need to write into.
 */
function probeAppRootAnomaly(
  fs: FileAccessLayer,
  projectRoot: string,
  appId: string,
): AppRootAnomalyOutcome {
  // Step 1: project-root readability. A missing project root is out
  // of scope (the harness would not have started); a permission-
  // denied read is a 503 retry-after.
  try {
    fs.lstatSync(projectRoot)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'project-root-unreadable',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  const appRoot = join(projectRoot, 'app')
  // Step 2: app-root presence. A fresh project that has never enabled
  // a recipe legitimately has no `app/` directory; Step 4's
  // `mkdirSync(appDir, { recursive: true })` will create both `app/`
  // and `app/<appId>/`. Returning `'ok'` here keeps the new-project
  // path identical to the v0.2.0 behaviour.
  if (!fs.existsSync(appRoot)) {
    return { state: 'ok' }
  }
  // Step 3: entry-kind discrimination. `lstatSync` (not `existsSync`)
  // is the only way to distinguish a symlink from its target — a
  // broken symlink would silently make `existsSync` return `false` on
  // some platforms and bypass the entire gate.
  let lstat: { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }
  try {
    lstat = fs.lstatSync(appRoot)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'app-root-unreadable',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (lstat.isSymbolicLink) {
    // Spec recipe-system v1.12 §10.9.3 Step 1.5-b: any symlink at the
    // app-root level is fail-closed reject. The realpath check below
    // distinguishes broken-symlink (500 structural anomaly) from
    // permission failures (503 retry-after) so ops can tell a
    // typo'd link apart from a transient `EACCES`.
    try {
      fs.realpathSync(appRoot)
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
        return { state: 'app-root-broken-symlink' }
      }
      return {
        state: 'app-root-unreadable',
        errno: code,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
    // Live symlink whose realpath resolved successfully — still a
    // hard reject (spec v1.12 §10.9.3 Step 1.5-b). The path-escape
    // attack vector is structural, not target-dependent, because
    // the spec requires `app/` to be a regular directory so the
    // boundary contract `<projectRoot>/app/**` cannot be aliased.
    return { state: 'app-root-symlink' }
  }
  if (!lstat.isDirectory) {
    return { state: 'app-root-non-directory' }
  }
  // Step 5: leftover-temp sibling scan. Re-uses the suffix prefixes
  // owned by the atomic-rename layer of the enable transaction
  // (`LEFTOVER_TEMP_DIR_PREFIXES`). The spec routes the per-appId
  // sibling check (Step 3d (ii-e)) and this endpoint-entry root-wide
  // scan to the same `'app-root-leftover-temp'` state because both
  // signify a previous transaction that did not finish.
  let siblings: string[]
  try {
    siblings = fs.readdirSync(appRoot)
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    return {
      state: 'app-root-unreadable',
      errno: code,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  for (const name of siblings) {
    for (const prefix of LEFTOVER_TEMP_DIR_PREFIXES) {
      if (name.startsWith(appId + prefix)) {
        return {
          state: 'app-root-leftover-temp',
          leftoverPath: join(appRoot, name),
        }
      }
    }
  }
  return { state: 'ok' }
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
  | { state: 'symlink-in-boundary-alias'; resolvedTarget: string }
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

  // `probeTarget` is the canonical path the step 4 readdir will run
  // against. For a non-symlink entry this is just `appDir`; the
  // symlink branch below overwrites it with `realpathSync(appDir)`
  // so step 4 sees the same canonical path the boundary check
  // verified, closing the TOCTOU window a swap-after-check would
  // otherwise open.
  let probeTarget = appDir

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
    try {
      probeTarget = fs.realpathSync(appDir)
    } catch (err) {
      return classifySymlinkResolveError(err)
    }
    if (!isWithin(probeTarget, appBoundary)) {
      return { state: 'symlink-out-of-app-root', resolvedTarget: probeTarget }
    }
    // Step 3d (ii-g) (spec v1.12 Round 2 High 11, BL-2026-179
    // cascade): in-boundary alias attack defence. The live symlink's
    // realpath is inside `<projectRoot>/app/` (ii-f gate passed), but
    // the recovery path's `rmSync(<projectRoot>/app/<appId>)` would
    // unlink the symlink and never touch the aliased directory —
    // dropping `<appId>` from the menu yet leaving the aliased
    // `<projectRoot>/app/<otherAppId>/` artifacts in place. Worse,
    // the Step 4 artifact copy would write into the aliased
    // directory, overwriting another bundled / sample / self-made
    // app's files under the boundary contract. Both attack surfaces
    // collapse if `<projectRoot>/app/<appId>` is required to resolve
    // to itself — the only canonical layout the spec normalizes on.
    //
    // The check is a literal path-string equality: `path.resolve`
    // already canonicalises `appDir`, so any divergence between
    // `probeTarget` (realpath of `appDir`) and the canonical
    // `<projectRoot>/app/<appId>` shape signals that a directory
    // entry redirects to a different sibling under the same
    // boundary. Fail-closed reject with a structured payload so the
    // audit log records both the requested appId and the alias
    // target — ops can recover by unlinking the symlink and
    // retrying without needing a separate filesystem probe.
    const canonicalAppDir = resolve(appBoundary, appId)
    if (probeTarget !== canonicalAppDir) {
      return { state: 'symlink-in-boundary-alias', resolvedTarget: probeTarget }
    }
    // Live symlink whose target stays under <projectRoot>/app/ →
    // fallthrough to step 4 (readdirSync via the resolved canonical
    // path, NOT the original symlink). Using the realpath here
    // closes the TOCTOU race a local attacker could otherwise win
    // by swapping the symlink target between the boundary check
    // and the readdir — the canonical path was captured under the
    // boundary verification, so a post-check swap cannot redirect
    // us out of `<projectRoot>/app/` (PR #56 codex attempt 7
    // Finding "TOCTOU path-boundary bypass").
  } else if (!lstat.isDirectory) {
    return { state: 'non-directory-entry' }
  }

  // Step 4: readability probe. Operate on `probeTarget` (the
  // resolved canonical path when step 3.5 ran, otherwise `appDir`
  // itself) so the readdir cannot follow a swapped-after-check
  // symlink to an out-of-root directory.
  try {
    fs.readdirSync(probeTarget)
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
  //
  // appId cross-check (PR #56 codex attempt 8 Finding "fail-closed
  // misclassification"): the match-by-recipeId alone is not enough
  // to authorize the destructive `rmSync(appDir)` recovery in the
  // enable caller. A stale or corrupted history record claiming the
  // same recipeId under a *different* appId would let the recovery
  // path wipe a self-made directory that has no relation to this
  // bundled recipe. Require the install record's resolved appId to
  // match the target appId before classifying as `partial-residue`;
  // otherwise downgrade to `self-made`, which the caller throws as
  // 400 `BundledAppIdConflict` instead of wiping the directory.
  const installRecord = findHistoryMatchForBundled(history, recipeId)
  if (installRecord !== undefined) {
    const recordAppId = installRecord.appId ?? installRecord.recipeId ?? recipeId
    if (recordAppId === appId) {
      return { state: 'partial-residue' }
    }
    // Same recipeId, different appId: do NOT trust this directory as
    // residue of *this* enable. Fall through to self-made so the
    // caller surfaces a conflict rather than running rmSync.
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

  // Cache-miss disk probe (PR #56 codex attempt 9 Finding "fail-
  // closed gap in local-state validation"): if the cache says
  // "no manifest" but a history install record gives us a candidate
  // appId, the on-disk `recipes-installed/<appId>/manifest.json`
  // may still exist as a malformed file that `manifestStore.loadAll()`
  // dropped at boot (warn log only). Surfacing that as 503 /
  // 500 keeps the disable path fail-closed against stale corrupt
  // manifests — otherwise disable would silently take the
  // manifest-already-absent branch and return success without
  // cleaning up the corrupt file. The probe is `probeManifestFileOnDisk`
  // (cache-ignoring) so it doesn't loop back through the same null
  // cache lookup that got us here.
  if (manifest === null && installRecord !== undefined) {
    const recordAppId = installRecord.appId ?? installRecord.recipeId ?? recipeId
    const cacheMissProbe = probeManifestFileOnDisk(fs, manifestStore, recordAppId)
    if (cacheMissProbe.state === 'present-io-failure') {
      throw new BundledInstallerError(
        `Manifest IO failure for "${recipeId}" (appId="${recordAppId}", cache-miss probe)`,
        503,
        'BundledLocalStateUnavailable',
        { fileName: 'manifest.json', appId: recordAppId, errno: cacheMissProbe.errno, detail: cacheMissProbe.detail },
      )
    }
    if (cacheMissProbe.state === 'present-parse-failure') {
      throw new BundledInstallerError(
        `Manifest parse failure for "${recipeId}" (appId="${recordAppId}", cache-miss probe): ${cacheMissProbe.detail}`,
        500,
        'BundledManifestUnreadable',
        { appId: recordAppId, detail: cacheMissProbe.detail },
      )
    }
    // probe.state === 'absent' → genuine manifestAlreadyAbsent, no
    // change to the residue classification flow below.
  }

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
 * install record exists. The handler **does NOT** short-circuit on
 * `undefined` — it falls back to `recipeId` as the lock key (the
 * bundled-registry default appId per BS-L9 for bundled samples,
 * matching the key the concurrent enable handler would use) and
 * still acquires `acquireAppLock(...)` before delegating to
 * `disableBundledRecipe`, which re-classifies under the lock. This
 * closes the race a pre-lock `already-disabled` short-circuit would
 * otherwise open against an in-flight enable for the same appId
 * (PR #56 codex attempt 8 Finding "race condition / lock bypass" —
 * before that fix the handler returned 200 here without a lock and
 * could race a concurrent enable that committed afterward, leaving
 * the app enabled even though the caller just requested disable).
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
 * v1.12 strengthened semantics (BL-2026-179 Phase 1.5 cascade, spec
 * recipe-system v1.12 §10.9.5 BS-L2'): coherence requires every link
 * in the visibility chain. Without each check a `Phase 1 PR #55/#56`-era
 * enable (which never wrote the AppManifest / menu.ts entry) would
 * make this helper short-circuit on `'already-enabled'` and prevent
 * the v1.12 enable transaction from re-establishing the UI display
 * invariant (judgment doc v2.9 §4.12.1).
 *
 * Returns true iff **all** of the following hold:
 *
 *   1. A `RecipeManifest` with `source ∈ {'bundled', 'sample'}`
 *      exists for `recipeId` (source-scoped uniqueness).
 *   2. `manifest.recipeId === recipeId` (pair coherence).
 *   3. `app/<appId>/` directory is present on disk (artifacts
 *      coherence).
 *   4. **`app/<appId>/manifest.json` (AppManifest) is present, is a
 *      regular file, parses as JSON, and passes `isAppManifest`
 *      schema validation.**
 *   5. **The AppManifest's appId / recipeId match
 *      `manifest.appId` / `recipeId` respectively; the AppManifest's
 *      `source.recipeSource` matches `manifest.source` (three-way
 *      equality, spec v1.12 Round 5).**
 *   6. **`app/menu.ts` is present and contains an entry whose `id`
 *      matches `manifest.appId` (UI display visibility, spec v1.12
 *      Round 2 Critical 4).**
 *
 * Any failure of (4)-(6) routes the enable transaction to Step 3
 * onwards so the missing AppManifest / menu.ts entry is written
 * (recovery path). The check is silent — schema-invalid or absent
 * AppManifest / menu.ts surfaces as `false` (not a thrown error)
 * because the caller already handles the recovery via the existing
 * Step 3d / Step 5 / Step 5.5 / Step 5.6 transaction.
 *
 * @see docs/specs/recipe-system.md v1.12 §10.9.5 BS-L2'
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
  if (!fs.existsSync(appDir)) {
    return false
  }

  // AppManifest readability + schema + three-way equality (spec
  // v1.12 §10.9.5 BS-L2' Round 2-5).
  const appManifestPath = getAppManifestPath(projectRoot, manifest.appId)
  if (!fs.existsSync(appManifestPath)) {
    return false
  }
  let appManifestStat: { isFile: boolean }
  try {
    appManifestStat = fs.lstatSync(appManifestPath)
  } catch {
    return false
  }
  if (!appManifestStat.isFile) {
    return false
  }
  let appManifestRaw: string
  try {
    appManifestRaw = fs.readFileSync(appManifestPath, 'utf-8')
  } catch {
    return false
  }
  let appManifestParsed: unknown
  try {
    appManifestParsed = JSON.parse(appManifestRaw)
  } catch {
    return false
  }
  if (!isAppManifest(appManifestParsed)) {
    return false
  }
  if (appManifestParsed.appId !== manifest.appId) {
    return false
  }
  if (appManifestParsed.source.type !== 'recipe') {
    return false
  }
  if (appManifestParsed.source.recipeId !== recipeId) {
    return false
  }
  // Three-way equality (spec v1.12 Round 5): AppManifest's
  // `recipeSource` must agree with the RecipeManifest's persisted
  // `source` (4-value enum `'bundled' | 'sample' | 'import' | 'url'`).
  // A split state (RecipeManifest `'sample'` + AppManifest `'bundled'`)
  // signals partial Phase 1.5 migration and must route through Step
  // 3 onwards for repair.
  if (appManifestParsed.source.recipeSource !== manifest.source) {
    return false
  }

  // menu.ts entry presence (spec v1.12 §10.9.5 BS-L2' Round 2
  // Critical 4): `GET /api/app/menu-entries` reads menu.ts only, so
  // a missing entry means the bundled app is invisible in the UI
  // even though every manifest is on disk.
  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  if (!fs.existsSync(menuTsPath)) {
    return false
  }
  let menuTsContent: string
  try {
    menuTsContent = fs.readFileSync(menuTsPath, 'utf-8')
  } catch {
    return false
  }
  // Cheap regex check — the same shape `appendMenuEntry` /
  // `removeMenuEntry` already keys on. Reusing the regex keeps the
  // three helpers' "is this entry present?" verdicts in sync.
  const idRe = new RegExp(`\\bid\\s*:\\s*['"\`]${escapeRegexForCoherence(manifest.appId)}['"\`]`)
  if (!idRe.test(menuTsContent)) {
    return false
  }
  return true
}

function escapeRegexForCoherence(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * Enable a bundled sample recipe (v0.2.1, extended in v1.12 Phase 1.5
 * for BL-2026-179 + BL-2026-177 same-PR resolution).
 *
 * Sequential steps (spec recipe-system v1.12 §10.9.3):
 *
 *   1. Bundled-registry presence check (route handler responsibility,
 *      passes the resolved `sample` in via {@link EnableBundledRecipeArgs}).
 *   **1.5. `<projectRoot>/app/` root anomaly check (v1.12 NEW,
 *      endpoint-entry fail-closed gate, BL-2026-177 same-PR fix —
 *      same semantics as the apps-routes `verifyAppRoot` check, see
 *      {@link probeAppRootAnomaly}).**
 *   2. Idempotent gate (BS-L2 / BS-L2'): `isEnabledAndManifestCoherent`
 *      returns true → 200 `already-enabled`.
 *   3a. `parseRecipe` the bundled artifacts on disk.
 *   3b. Reject if `api.scopes` carries `agents-write` / `skills-write`
 *       (BS-L5, defence in depth — the parser already rejects them).
 *   3d. appId collision check + appDir anomaly probe (Step 3d (ii)
 *       including the new (ii-g) in-boundary alias defense).
 *   4. Copy artifacts atomically into `app/<appId>/`.
 *   5. Write the `RecipeManifest` (`recipes-installed/<appId>/manifest.json`,
 *      `source: 'bundled'`, `trustLevel: 'code-trusted (bundled)'`,
 *      capture auto-approve).
 *   **5.5. (v1.12 NEW) Write the `AppManifest`
 *      (`app/<appId>/manifest.json`) so the closed-world batch
 *      `PUT /api/apps/menu-order` includes bundled apps (judgment
 *      doc v2.9 §4.12.1 SSOT). Snapshot the existing AppManifest
 *      content first so a downstream Step 5.6 / 6 / 7 failure can
 *      restore it (BS-L1' rollback discipline).**
 *   **5.6. (v1.12 NEW) Append the `appId` entry to
 *      `app/menu.ts` so the bundled app appears in the UI
 *      (`GET /api/app/menu-entries` reads only menu.ts, not the
 *      AppManifest). Snapshot the existing menu.ts content for the
 *      rollback path; track `menuTsCreatedInTransaction` so a fresh
 *      menu.ts is unlinked (not snapshot-restored) on rollback.**
 *   6. Ensure `app/data/<appId>/` exists (BS-L3-A: existing data
 *      preserved).
 *   7. Append install record to `recipe-history.jsonl`.
 *
 * Rollback discipline (BS-L1' v2.9, spec v1.12 §10.9.5):
 *
 *   - Step 4 failure: delete the partial appDir; AppManifest /
 *     menu.ts / history untouched.
 *   - Step 5 failure: delete appDir; AppManifest / menu.ts / history
 *     untouched. `app/data/<appId>/` preserved (BS-L3-A).
 *   - **Step 5.5 failure: snapshot-restore existing AppManifest (if
 *     any) or leave temp file removed; delete RecipeManifest +
 *     appDir; menu.ts / history untouched.**
 *   - **Step 5.6 failure: snapshot-restore existing AppManifest (if
 *     any) or remove the file; snapshot-restore existing menu.ts (if
 *     any) or unlink (if created in this transaction); delete
 *     RecipeManifest + appDir; history untouched.**
 *   - Step 6 / 7 failure: full menu.ts + AppManifest + RecipeManifest +
 *     appDir teardown.
 *
 * Concurrency: the route handler MUST hold `acquireGlobalMenuTsLock()`
 * AND `acquireAppLock(appId)` (acquisition order normative per spec
 * v1.12 §10.9.5 BS-L1' rollback lock discipline) for the entire
 * duration of this call, including the rollback paths. Without the
 * global menu.ts lock the Step 5.6 + rollback writes race against
 * concurrent recipe install / disable transactions.
 */
export function enableBundledRecipe(
  args: EnableBundledRecipeArgs,
): EnableBundledRecipeResult {
  const { fs, manifestStore, projectRoot, kovitoboardRoot, recipeId, sample } = args

  // Step 1.5: `<projectRoot>/app/` root anomaly check (spec v1.12
  // §10.9.3 Step 1.5, BL-2026-177 same-PR fix). The endpoint-entry
  // gate fails closed before Step 2 / Step 4 ever opens a path under
  // `<projectRoot>/app/`, so even an attacker-planted root symlink
  // / leftover-temp sibling cannot redirect the downstream writes.
  // The route handler does not run an equivalent gate, so the
  // bundled-installer owns this check (the apps-routes equivalent
  // `verifyAppRoot` in PR #57 protects the closed-world menu-order
  // batch surface only).
  const appId = sample.id
  // Defence-in-depth: validate the appId format before we touch the
  // filesystem. The bundled-registry enforces the format upstream,
  // but a future refactor that loosens the registry-side check
  // should not weaken the destructive-path boundary here.
  assertSafeAppId(projectRoot, appId)
  const rootProbe = probeAppRootAnomaly(fs, projectRoot, appId)
  switch (rootProbe.state) {
    case 'ok':
      break
    case 'project-root-unreadable':
      recipeLogger.error(
        { event: 'bundled-app-root-unreadable', recipeId, appId, projectRoot, errno: rootProbe.errno, detail: rootProbe.detail },
        'Bundled enable rejected: project root unreadable',
      )
      throw new BundledInstallerError(
        `Project root "${projectRoot}" is unreadable: ${rootProbe.detail}`,
        503,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'project-root-unreadable',
          errno: rootProbe.errno,
          detail: rootProbe.detail,
        },
      )
    case 'app-root-symlink':
      recipeLogger.error(
        { event: 'bundled-app-root-symlink-reject', recipeId, appId, appRootPath: join(projectRoot, 'app') },
        'Bundled enable rejected: <projectRoot>/app is a symbolic link',
      )
      throw new BundledInstallerError(
        `<projectRoot>/app "${join(projectRoot, 'app')}" is a symbolic link; fail-closed reject`,
        500,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'app-root-symlink',
        },
      )
    case 'app-root-non-directory':
      recipeLogger.error(
        { event: 'bundled-app-root-anomaly', recipeId, appId, appRootPath: join(projectRoot, 'app'), anomalyType: 'app-root-non-directory' },
        'Bundled enable rejected: <projectRoot>/app is not a directory',
      )
      throw new BundledInstallerError(
        `<projectRoot>/app "${join(projectRoot, 'app')}" is not a directory; fail-closed reject`,
        500,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'app-root-non-directory',
        },
      )
    case 'app-root-broken-symlink':
      recipeLogger.error(
        { event: 'bundled-app-root-anomaly', recipeId, appId, appRootPath: join(projectRoot, 'app'), anomalyType: 'app-root-broken-symlink' },
        'Bundled enable rejected: <projectRoot>/app is a broken symlink',
      )
      throw new BundledInstallerError(
        `<projectRoot>/app "${join(projectRoot, 'app')}" is a broken symbolic link; fail-closed reject`,
        500,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'app-root-broken-symlink',
        },
      )
    case 'app-root-unreadable':
      recipeLogger.error(
        { event: 'bundled-app-root-unreadable', recipeId, appId, appRootPath: join(projectRoot, 'app'), errno: rootProbe.errno, detail: rootProbe.detail },
        'Bundled enable rejected: <projectRoot>/app is unreadable',
      )
      throw new BundledInstallerError(
        `<projectRoot>/app "${join(projectRoot, 'app')}" is unreadable: ${rootProbe.detail}`,
        503,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'app-root-unreadable',
          errno: rootProbe.errno,
          detail: rootProbe.detail,
        },
      )
    case 'app-root-leftover-temp':
      recipeLogger.warn(
        { event: 'bundled-leftover-temp-dir', recipeId, appId, leftoverPath: rootProbe.leftoverPath },
        'Bundled enable rejected: leftover temp dir under <projectRoot>/app',
      )
      throw new BundledInstallerError(
        `Leftover temp dir blocks enable for "${recipeId}" (appId="${appId}"): ${rootProbe.leftoverPath}`,
        500,
        'BundledRegistryAnomaly',
        {
          recipeId,
          appId,
          appRootPath: join(projectRoot, 'app'),
          anomalyType: 'app-root-leftover-temp',
          leftoverPath: rootProbe.leftoverPath,
        },
      )
  }

  // Step 2: idempotent gate (BS-L2 / BS-L2', strengthened in v1.12
  // Round 2-5 to require AppManifest readability + schema-valid +
  // three-way equality between RecipeManifest / history install
  // record / AppManifest source. See {@link isEnabledAndManifestCoherent}.
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

  // appId picks the bundled-registry id by default (BS-L9). Already
  // validated above by `assertSafeAppId` in the Step 1.5 prologue —
  // see that block for the rationale on why we validate before any
  // filesystem touch.
  //
  // Source-scoped collision check (recipe-system v1.10 §10.9.3
  // Step 3d (i)): a non-bundled / non-sample manifest at the target
  // appId is a hard conflict regardless of whether its `recipeId`
  // happens to match, because the bundled-installer must not
  // overwrite an `'import'` / `'url'` install. Within the
  // bundled/sample source-scoped subset a `recipeId` mismatch is
  // still a conflict (two different bundled recipes claiming the
  // same appId); only a same-`recipeId` bundled/sample residue is
  // allowed to fall through to the Step 5 overwrite recovery.

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
      case 'symlink-in-boundary-alias':
        // Spec recipe-system v1.12 Round 2 High 11 (BL-2026-179
        // cascade): live symlink whose realpath stays under
        // `<projectRoot>/app/` (the (ii-f) gate passed) but points
        // at a *different* sibling under the same boundary. Without
        // this gate the Step 4 artifact copy would overwrite the
        // aliased app's files, and the rollback rmSync would unlink
        // the symlink without touching the foreign artifacts.
        recipeLogger.error(
          {
            event: 'bundled-symlink-in-boundary-alias',
            recipeId,
            appId,
            resolvedTarget: probe.resolvedTarget,
          },
          'Bundled enable rejected: live symlink target redirects to a different appId under <projectRoot>/app/',
        )
        throw new BundledInstallerError(
          `appDir "${appDir}" is a live symlink whose target "${probe.resolvedTarget}" redirects to a different appId under <projectRoot>/app/`,
          500,
          'BundledAppIdConflictAnomaly',
          {
            recipeId,
            appId,
            anomalyType: 'symlink-in-boundary-alias',
            resolvedTarget: probe.resolvedTarget,
            requestedAppId: appId,
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

  // Step 5: RecipeManifest write (`recipes-installed/<appId>/manifest.json`,
  // `source: 'bundled'`, `trustLevel: 'code-trusted (bundled)'`).
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

  // Step 5.5 (v1.12 NEW, BL-2026-179 cascade): write the AppManifest
  // (`app/<appId>/manifest.json`). The judgment doc v2.9 §4.12.1
  // SSOT pins this as a required visibility invariant — without it
  // the closed-world batch `PUT /api/apps/menu-order` (PR #57) would
  // never see bundled apps in its eligible set, and the menu order
  // / label endpoints would silently route bundled apps to 404.
  //
  // Snapshot the existing AppManifest content first so a Step 5.6 /
  // 6 / 7 failure can restore the recovery-path original state (spec
  // v1.12 §10.9.5 BS-L1' rollback discipline — `existingAppManifestContent`
  // snapshot semantics).
  const appManifestPath = getAppManifestPath(projectRoot, appId)
  let existingAppManifestContent: string | null = null
  if (fs.existsSync(appManifestPath)) {
    // Kind check (spec v1.12 Round 2 Medium 12): a non-regular file
    // at the AppManifest path is a fail-closed reject — we cannot
    // safely overwrite a symlink / FIFO / socket without leaking
    // the bundled-trust badge into whatever the link points at.
    let appManifestStat: { isFile: boolean }
    try {
      appManifestStat = fs.lstatSync(appManifestPath)
    } catch (err) {
      // RecipeManifest was just written above, so we own the
      // rollback for the partial state. AppDir always created by
      // Step 4, so `tryRm(appDir)` brings us back to a clean state.
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Failed to stat existing AppManifest for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'EnableAppManifestWriteFailed',
        { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      )
    }
    if (!appManifestStat.isFile) {
      recipeLogger.error(
        { event: 'bundled-app-manifest-anomaly', recipeId, appId, appManifestPath },
        'Bundled enable rejected: existing AppManifest is not a regular file',
      )
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Existing AppManifest "${appManifestPath}" is not a regular file`,
        500,
        'BundledAppManifestAnomaly',
        { recipeId, appId, anomalyType: 'non-regular-file' },
      )
    }
    try {
      existingAppManifestContent = fs.readFileSync(appManifestPath, 'utf-8')
    } catch (err) {
      // Treat a read failure on an existing regular file as a
      // fail-closed write error — the rollback path needs the
      // snapshot to restore the recovery-path original state, and
      // we cannot guarantee it without the read.
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Failed to snapshot existing AppManifest for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'EnableAppManifestWriteFailed',
        { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      )
    }
  }

  // Compose the canonical displayName per spec v1.12 §10.9.3 Step
  // 5.5: prefer the recipe.yaml `menu` entry's `label` (the entry
  // whose id matches the bundled appId), fall back to the recipe
  // name, then to the appId itself. The cast covers the `parseRecipe`
  // return type which stores menu entries with `id` / `label`.
  const matchedMenuEntry = (parsed.menu ?? []).find((entry) => entry.id === appId)
  const displayName: string =
    (matchedMenuEntry && typeof matchedMenuEntry.label === 'string' && matchedMenuEntry.label.length > 0
      ? matchedMenuEntry.label
      : null) ??
    (typeof parsed.metadata.name === 'string' && parsed.metadata.name.length > 0
      ? parsed.metadata.name
      : null) ??
    appId
  const appManifest: AppManifest = {
    appId,
    displayName,
    createdAt: manifest.installedAt,
    kovitoboardVersion: resolveKovitoboardVersion(),
    source: {
      type: 'recipe',
      recipeId,
      recipeVersion: parsed.metadata.version,
      recipeSource: 'bundled',
    },
    // menuOrder / userMenuLabel are intentionally omitted (spec
    // v1.12 Round 2 Critical 2 / Round 3 C2-fix): the scanner assigns
    // a provisional menuOrder, and `null` for userMenuLabel has
    // explicit-reset semantics that we must not pre-write.
  }
  try {
    writeAppManifest(fs, projectRoot, appManifest)
  } catch (err) {
    // Step 5.5 failure rollback (spec v1.12 §10.9.5 BS-L1' Step 5.5):
    // restore the existing AppManifest content if we snapshotted
    // one, else leave the manifest file gone. Then unwind the
    // RecipeManifest + appDir state Step 4 + Step 5 created.
    if (existingAppManifestContent !== null) {
      try {
        fs.writeFileAtomic(appManifestPath, existingAppManifestContent)
      } catch (restoreErr) {
        recipeLogger.warn(
          { err: restoreErr, recipeId, appId },
          '[bundled-installer] Step 5.5 rollback: failed to restore existing AppManifest snapshot',
        )
      }
    } else if (fs.existsSync(appManifestPath)) {
      // Partial write may have landed even though writeFileAtomic
      // throws; best-effort cleanup of any leftover file.
      try {
        fs.rmSync(appManifestPath, { force: true })
      } catch (cleanupErr) {
        recipeLogger.warn(
          { err: cleanupErr, recipeId, appId, appManifestPath },
          '[bundled-installer] Step 5.5 rollback: failed to remove partial AppManifest',
        )
      }
    }
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    recipeLogger.error(
      { event: 'bundled-enable-app-manifest-write-failed', recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      'Bundled enable rolled back: AppManifest write failed',
    )
    throw new BundledInstallerError(
      `Failed to write AppManifest for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
      500,
      'EnableAppManifestWriteFailed',
      { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
    )
  }

  // Step 5.6 (v1.12 NEW, BL-2026-179 cascade): append the menu entry
  // to `app/menu.ts`. `GET /api/app/menu-entries` derives the UI menu
  // exclusively from `menu-extractor.parseMenuTs(app/menu.ts)`; an
  // AppManifest without a menu.ts entry means the bundled app is
  // invisible in the UI even though the artifacts + manifests are
  // on disk. The judgment doc v2.9 §4.12.1 SSOT pins this as a
  // required visibility invariant.
  //
  // Caller responsibility: the route handler holds the global menu.ts
  // lock + per-app lock for the whole transaction (spec v1.12 §10.9.3
  // Step 5.6 lock acquisition order). The rollback path below relies
  // on the same lock to safely restore the snapshot.

  // Bundled recipe `menu[]` array constraint (spec v1.12 Round 4
  // Critical): exactly one entry whose `id` matches `appId`.
  // Multi-entry support is deferred to v0.3.0+ (multi-app aware
  // enable / disable model). Violations are fail-closed because the
  // single-appId lifecycle (one AppManifest, one app/data/<appId>/,
  // one menu.ts entry per appId per disable transaction) cannot
  // safely host extra entries that share the same appId lifecycle.
  const recipeMenu = parsed.menu ?? []
  if (recipeMenu.length === 0) {
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    recipeLogger.error(
      { event: 'bundled-recipe-asset-malformed', recipeId, appId, reason: 'menu-empty' },
      'Bundled enable rejected: recipe.yaml menu array is empty or absent',
    )
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" has no menu entries`,
      503,
      'BundledRecipeMalformed',
      { recipeId, appId, detail: 'menu array is empty or absent' },
    )
  }
  if (recipeMenu.length > 1) {
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    recipeLogger.error(
      { event: 'bundled-recipe-asset-malformed', recipeId, appId, reason: 'multi-entry-menu', entryCount: recipeMenu.length },
      'Bundled enable rejected: recipe.yaml menu array must have exactly 1 entry',
    )
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" must declare exactly one menu entry, got ${recipeMenu.length}`,
      503,
      'BundledRecipeMalformed',
      {
        recipeId,
        appId,
        detail: 'menu array must have exactly 1 entry for bundled recipe',
        entryCount: recipeMenu.length,
      },
    )
  }
  const recipeMenuEntry = recipeMenu[0]
  if (recipeMenuEntry.id !== appId) {
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    recipeLogger.error(
      { event: 'bundled-recipe-asset-malformed', recipeId, appId, reason: 'entry-id-mismatch', entryId: recipeMenuEntry.id },
      'Bundled enable rejected: recipe.yaml menu entry id does not match appId',
    )
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" menu entry id "${recipeMenuEntry.id}" does not match appId "${appId}"`,
      503,
      'BundledRecipeMalformed',
      { recipeId, appId, detail: 'menu entry id must match appId', entryId: recipeMenuEntry.id },
    )
  }

  // Compose the canonical `<appId>/<sub-path>` page for the menu
  // entry. The recipe-applicator template places recipe artifacts
  // under `<appId>/`, and `isCanonicalAppIdPath` requires the menu
  // entry's `page` to start with `<appId>/` so the renderer's
  // dynamic-import URL stays inside the boundary. Compose the
  // prefix here so the recipe author can keep recipe.yaml short
  // (`page: pages/Index` instead of `page: <appId>/pages/Index`).
  const composedPage = `${appId}/${recipeMenuEntry.page}`
  if (!isCanonicalAppIdPath(composedPage, appId)) {
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    recipeLogger.error(
      { event: 'bundled-recipe-asset-malformed', recipeId, appId, reason: 'menu-entry-page-escape', composedPage },
      'Bundled enable rejected: recipe menu entry page escapes <appId>/ subtree',
    )
    throw new BundledInstallerError(
      `Bundled recipe "${recipeId}" menu entry page "${recipeMenuEntry.page}" escapes <appId>/ subtree (composed: "${composedPage}")`,
      503,
      'BundledRecipeMalformed',
      {
        recipeId,
        appId,
        detail: 'menu entry page escapes <appId>/ subtree',
        composedPage,
      },
    )
  }

  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  let existingMenuTsContent: string | null = null
  let menuTsCreatedInTransaction = false
  if (fs.existsSync(menuTsPath)) {
    // Kind check (spec v1.12 Round 2 Medium 12, shared with Step
    // 4.5 disable cascade).
    let menuTsStat: { isFile: boolean }
    try {
      menuTsStat = fs.lstatSync(menuTsPath)
    } catch (err) {
      rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Failed to stat existing menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'EnableMenuTsAppendFailed',
        { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      )
    }
    if (!menuTsStat.isFile) {
      recipeLogger.error(
        { event: 'bundled-menu-ts-anomaly', recipeId, appId, menuTsPath },
        'Bundled enable rejected: existing app/menu.ts is not a regular file',
      )
      rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Existing app/menu.ts "${menuTsPath}" is not a regular file`,
        500,
        'BundledMenuTsAnomaly',
        { recipeId, appId, anomalyType: 'non-regular-file' },
      )
    }
    try {
      existingMenuTsContent = fs.readFileSync(menuTsPath, 'utf-8')
    } catch (err) {
      rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      throw new BundledInstallerError(
        `Failed to snapshot existing menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'EnableMenuTsAppendFailed',
        { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      )
    }
  }
  const baseMenuTsContent = existingMenuTsContent ?? buildEmptyMenuTs()
  if (existingMenuTsContent === null) {
    menuTsCreatedInTransaction = true
  }
  // Append the entry. `appendMenuEntry` returns `'already-present'`
  // when the appId entry already exists in menu.ts (grandfather
  // sample / partial residue recovery / re-enable retry) — in that
  // case the file stays untouched and the rollback path has nothing
  // to do. Parse failures throw `MenuTsParseFailedError`, which we
  // route to 500 `EnableMenuTsAppendFailed`.
  const appendInput: AppendMenuEntryInput = {
    id: appId,
    label: recipeMenuEntry.label,
    icon: typeof recipeMenuEntry.icon === 'string' && recipeMenuEntry.icon.length > 0 ? recipeMenuEntry.icon : 'box',
    page: composedPage,
  }
  let appendResult
  try {
    appendResult = appendMenuEntry(baseMenuTsContent, appendInput)
  } catch (err) {
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
    manifestStore.delete(appId)
    tryRm(fs, appDir)
    const reason = err instanceof MenuTsParseFailedError ? err.reason : err instanceof Error ? err.message : String(err)
    recipeLogger.error(
      { event: 'bundled-enable-menu-ts-append-failed', recipeId, appId, reason },
      'Bundled enable rolled back: menu.ts parse failed',
    )
    throw new BundledInstallerError(
      `Failed to append menu.ts entry for "${recipeId}" (appId="${appId}"): ${reason}`,
      500,
      'EnableMenuTsAppendFailed',
      { recipeId, appId, detail: reason },
    )
  }
  let menuTsTouched = false
  if (appendResult.kind === 'appended') {
    menuTsTouched = true
    try {
      fs.writeFileAtomic(menuTsPath, appendResult.content)
    } catch (err) {
      rollbackMenuTs(fs, menuTsPath, existingMenuTsContent, menuTsCreatedInTransaction, recipeId, appId)
      rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
      manifestStore.delete(appId)
      tryRm(fs, appDir)
      recipeLogger.error(
        { event: 'bundled-enable-menu-ts-append-failed', recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
        'Bundled enable rolled back: menu.ts atomic write failed',
      )
      throw new BundledInstallerError(
        `Failed to write menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'EnableMenuTsAppendFailed',
        { recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
      )
    }
  }
  // Track whether menu.ts ended up being touched so subsequent
  // rollback decisions in Step 6 / 7 know whether to restore the
  // snapshot / unlink the freshly-created file.
  const menuTsRequiresRollback = menuTsTouched || menuTsCreatedInTransaction

  // Step 6: ensure `app/data/<appId>/` exists (re-enable preserves
  // existing user data per BS-L3-A).
  const dataDir = join(projectRoot, 'app', 'data', appId)
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  } catch (err) {
    if (menuTsRequiresRollback) {
      rollbackMenuTs(fs, menuTsPath, existingMenuTsContent, menuTsCreatedInTransaction, recipeId, appId)
    }
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
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
    // History append fails *after* manifest + artifacts + AppManifest
    // + menu.ts are committed. Best-effort rollback: tear down every
    // committed write so the next call sees a clean slate. Data dir
    // stays put (BS-L3-A).
    if (menuTsRequiresRollback) {
      rollbackMenuTs(fs, menuTsPath, existingMenuTsContent, menuTsCreatedInTransaction, recipeId, appId)
    }
    rollbackAppManifest(fs, appManifestPath, existingAppManifestContent, recipeId, appId)
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

/**
 * Restore (or unlink) an `AppManifest` written under Step 5.5. Spec
 * v1.12 §10.9.5 BS-L1' rollback discipline normative pin: snapshot
 * restore for the recovery path (an existing AppManifest was
 * overwritten), unlink for fresh enable. Best-effort — failures are
 * warn-logged so the parent enable handler still surfaces the
 * original error code to the caller.
 */
function rollbackAppManifest(
  fs: FileAccessLayer,
  appManifestPath: string,
  existingContent: string | null,
  recipeId: string,
  appId: string,
): void {
  if (existingContent !== null) {
    try {
      fs.writeFileAtomic(appManifestPath, existingContent)
    } catch (err) {
      recipeLogger.warn(
        { err, recipeId, appId, appManifestPath },
        '[bundled-installer] rollback: failed to restore AppManifest snapshot',
      )
    }
    return
  }
  if (fs.existsSync(appManifestPath)) {
    try {
      fs.rmSync(appManifestPath, { force: true })
    } catch (err) {
      recipeLogger.warn(
        { err, recipeId, appId, appManifestPath },
        '[bundled-installer] rollback: failed to remove AppManifest',
      )
    }
  }
}

/**
 * Restore (or unlink) `app/menu.ts` under Step 5.6 rollback. Spec
 * v1.12 §10.9.5 BS-L1' rollback discipline normative pin:
 *
 *   - `menuTsCreatedInTransaction === true` → unlink the file we
 *     just created (we own the new menu.ts; leaving a fresh empty
 *     one behind would surface a confusing "menu.ts appeared after
 *     a failed enable" artefact).
 *   - `existingContent !== null` → snapshot-restore the original
 *     content (we mutated a pre-existing menu.ts and must undo).
 *   - both `null` / `false` (idempotent `'already-present'` branch
 *     skipped the write) → no-op.
 */
function rollbackMenuTs(
  fs: FileAccessLayer,
  menuTsPath: string,
  existingContent: string | null,
  createdInTransaction: boolean,
  recipeId: string,
  appId: string,
): void {
  if (createdInTransaction) {
    try {
      if (fs.existsSync(menuTsPath)) {
        fs.rmSync(menuTsPath, { force: true })
      }
    } catch (err) {
      recipeLogger.warn(
        { err, recipeId, appId, menuTsPath },
        '[bundled-installer] rollback: failed to unlink freshly-created menu.ts',
      )
    }
    return
  }
  if (existingContent !== null) {
    try {
      fs.writeFileAtomic(menuTsPath, existingContent)
    } catch (err) {
      recipeLogger.warn(
        { err, recipeId, appId, menuTsPath },
        '[bundled-installer] rollback: failed to restore menu.ts snapshot',
      )
    }
  }
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

  // Step 4.5 (v1.12 NEW, BL-2026-179 cascade): remove the menu.ts
  // entry for the disabled appId. The artifact + RecipeManifest are
  // already gone by Step 3 / Step 4, so leaving the menu.ts entry
  // behind would surface a dead row in the UI (the renderer would
  // attempt an `import('./<appId>/...')` that resolves to a missing
  // file). Spec recipe-system v1.12 §10.9.4 Step 4.5 + judgment doc
  // v2.9 §4.12.1 SSOT pin this as the disable-side counterpart of
  // Step 5.6's append.
  //
  // Concurrency: the route handler holds the global menu.ts lock +
  // per-app lock for the whole disable transaction (spec v1.12
  // §10.9.4 Step 4.5 lock acquisition order — same as enable Step
  // 5.6).
  //
  // The partial-residue branch reaches this step too (see the route
  // handler's `manifestAlreadyAbsent` path): a manifest-already-
  // absent disable still needs to scrub the stale menu.ts row that
  // a prior Phase 1.5 enable left behind.
  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  if (fs.existsSync(menuTsPath)) {
    // Kind check (spec v1.12 Round 2 Medium 12, shared with enable
    // Step 5.6).
    let menuTsStat: { isFile: boolean }
    try {
      menuTsStat = fs.lstatSync(menuTsPath)
    } catch (err) {
      throw new BundledInstallerError(
        `Failed to stat app/menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'DisableMenuTsRemovalFailed',
        { recipeId, appId, detail: { reason: 'atomic-write', error: err instanceof Error ? err.message : String(err) } },
      )
    }
    if (!menuTsStat.isFile) {
      recipeLogger.error(
        { event: 'bundled-menu-ts-anomaly', recipeId, appId, menuTsPath },
        'Bundled disable rejected: existing app/menu.ts is not a regular file',
      )
      throw new BundledInstallerError(
        `Existing app/menu.ts "${menuTsPath}" is not a regular file`,
        500,
        'BundledMenuTsAnomaly',
        { recipeId, appId, anomalyType: 'non-regular-file' },
      )
    }
    let menuTsContent: string
    try {
      menuTsContent = fs.readFileSync(menuTsPath, 'utf-8')
    } catch (err) {
      throw new BundledInstallerError(
        `Failed to read app/menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
        500,
        'DisableMenuTsRemovalFailed',
        { recipeId, appId, detail: { reason: 'atomic-write', error: err instanceof Error ? err.message : String(err) } },
      )
    }
    const removeResult = removeMenuEntry(menuTsContent, appId)
    if (removeResult.kind === 'parse-failed') {
      recipeLogger.error(
        { event: 'bundled-disable-menu-ts-removal-failed', recipeId, appId, reason: removeResult.reason },
        'Bundled disable failed: app/menu.ts parse-failed (user intervention required)',
      )
      throw new BundledInstallerError(
        `Failed to parse app/menu.ts for "${recipeId}" (appId="${appId}"): ${removeResult.reason}`,
        500,
        'DisableMenuTsRemovalFailed',
        { recipeId, appId, detail: { reason: 'parse-failed', error: removeResult.reason } },
      )
    }
    if (removeResult.kind === 'removed') {
      try {
        fs.writeFileAtomic(menuTsPath, removeResult.content)
      } catch (err) {
        recipeLogger.error(
          { event: 'bundled-disable-menu-ts-removal-failed', recipeId, appId, detail: err instanceof Error ? err.message : String(err) },
          'Bundled disable failed: app/menu.ts atomic write failed',
        )
        throw new BundledInstallerError(
          `Failed to write app/menu.ts for "${recipeId}" (appId="${appId}"): ${err instanceof Error ? err.message : String(err)}`,
          500,
          'DisableMenuTsRemovalFailed',
          { recipeId, appId, detail: { reason: 'atomic-write', error: err instanceof Error ? err.message : String(err) } },
        )
      }
    }
    // `removeResult.kind === 'not-found'` is the idempotent path
    // (entry was already removed by hand, or a previous disable
    // retry committed Step 4.5 but failed before Step 5). Continue
    // to Step 5 — the spec's `'not-found'` audit event is best-
    // effort and emitted by the route handler's audit-logging layer,
    // not here.
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
