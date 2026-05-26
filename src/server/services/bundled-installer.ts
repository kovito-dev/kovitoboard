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

import { join } from 'path'
import { createHash } from 'crypto'
import type { FileAccessLayer } from '../fs-layer'
import { recipeLogger } from '../logger'
import { getKovitoboardDir } from '../paths'
import {
  appendRecipeHistory,
  generateHistoryId,
  readRecipeHistory,
} from '../recipe-history'
import { parseRecipe } from '../recipe-parser'
import type { RecipeManifestStore } from '../recipeManifestStore'
import type { ParsedRecipe, RecipeHistoryEntry } from '../../shared/recipe-types'
import type { ApiSection, RecipeManifest } from '../recipe/apiTypes'
import type { Scope } from '../handlers/types'
import {
  findHistoryMatch,
  type SampleRecipeInfo,
  type SampleRecipeSourceLabel,
} from './recipe-scanner'

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
 */
export function classifyLocalResidue(args: ClassifyLocalResidueArgs): LocalResidueState {
  const { fs, manifestStore, recipeId } = args

  const manifest = findManifestByRecipeId(manifestStore, recipeId)
  const history = readRecipeHistory(fs)
  const installRecord = findHistoryMatchForBundled(history, recipeId)

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

  // Step 3: parse the bundled recipe on disk.
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
  const existingManifest = manifestStore.get(appId)
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

  // Step 4: artifacts copy (atomic via per-file writeFileAtomic into
  // the final `app/<appId>/` directory). The sequence is "build
  // first, swap last": if any per-file write fails the rollback in
  // the catch block below removes the partially-populated directory
  // recursively, leaving `app/data/<appId>/` untouched.
  const appDir = join(projectRoot, 'app', appId)
  const appDirPreExisted = fs.existsSync(appDir)
  const writtenArtifactPaths: string[] = []
  try {
    if (!appDirPreExisted) {
      fs.mkdirSync(appDir, { recursive: true })
    }
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
    // Only delete what we created — if it pre-existed (re-enable
    // race / leftover), leave the user's state alone.
    if (!appDirPreExisted) {
      tryRm(fs, appDir)
    }
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
    hash: sample.hash,
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
    if (!appDirPreExisted) {
      tryRm(fs, appDir)
    }
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
    if (!appDirPreExisted) {
      tryRm(fs, appDir)
    }
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
    hash: sample.hash,
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
    if (!appDirPreExisted) {
      tryRm(fs, appDir)
    }
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
  metadata?: { note?: 'manifest-already-absent' }
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
  const { fs, manifestStore, projectRoot, recipeId } = args

  // Step 1: local-state classification.
  const residue = classifyLocalResidue({ fs, manifestStore, recipeId })
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
  const history = readRecipeHistory(fs)
  const installRecord = findHistoryMatchForBundled(history, recipeId)

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

  // Step 2: delete `app/<appId>/` (artifacts only).
  const appDir = join(projectRoot, 'app', appId)
  if (fs.existsSync(appDir)) {
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

  // Step 3: delete the manifest.
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

  // Step 4: history append.
  const historyEntry: RecipeHistoryEntry = {
    id: generateHistoryId(fs),
    action: 'uninstall',
    name: manifest?.recipeId ?? installRecord?.name ?? recipeId,
    version: manifest?.recipeVersion ?? installRecord?.version ?? '0.0.0',
    source: persistedSource,
    hash: manifest?.hash ?? installRecord?.hash ?? '',
    appliedAt: new Date().toISOString(),
    artifacts: [],
    menu: [],
    recipeId,
    appId,
    ownDataDeleted: false,
    ...(manifestAlreadyAbsent
      ? { metadata: { note: 'manifest-already-absent' as const } }
      : {}),
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
    ...(manifestAlreadyAbsent
      ? { metadata: { note: 'manifest-already-absent' as const } }
      : {}),
  }
}

// =========================================
// Internal helpers
// =========================================

function findManifestByRecipeId(
  manifestStore: RecipeManifestStore,
  recipeId: string,
): RecipeManifest | null {
  for (const manifest of manifestStore.list()) {
    if (manifest.recipeId === recipeId && isBundledOrSample(manifest.source)) {
      return manifest
    }
  }
  return null
}

function findHistoryMatchForBundled(
  history: RecipeHistoryEntry[],
  recipeId: string,
): RecipeHistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry.recipeId !== recipeId && entry.name !== recipeId) continue
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
