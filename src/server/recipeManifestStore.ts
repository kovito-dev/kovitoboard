/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe Manifest Store — Manages manifest.json for installed recipes.
 *
 * Reads and writes `.kovitoboard/recipes-installed/{appId}/manifest.json`
 * and maintains an in-memory cache **keyed by appId** (DEC-024 D-1).
 * The manifest's own `recipeId` field is preserved on disk so the
 * recipe's lineage is recoverable, but the dispatcher / store always
 * routes by `appId`.
 *
 * - Scans and loads all manifests at startup
 * - Updates cache on explicit save/delete
 * - No file watching (v0.1.0 uses startup scan + explicit updates only)
 *
 * @see recipe-system.md §12-5-1 (manifest.json)
 * @stable v0.1.0
 */

import { recipeLogger } from './logger'
import { join } from 'path'
import type { FileAccessLayer } from './fs-layer.js'
import type { RecipeManifest, CaptureKind, TrustLevel } from './recipe/apiTypes.js'
import {
  isValidScope,
  isValidHandlerName,
  isValidCaptureKind,
  isValidTrustLevel,
} from './recipe/apiTypes.js'

// =========================================
// Store class
// =========================================

export class RecipeManifestStore {
  private cache = new Map<string, RecipeManifest>()
  private readonly baseDir: string

  /**
   * @param kovitoboardDir - Absolute path to the .kovitoboard/ directory
   * @param fs - File access layer
   */
  constructor(
    kovitoboardDir: string,
    private readonly fs: FileAccessLayer,
  ) {
    this.baseDir = join(kovitoboardDir, 'recipes-installed')
  }

  /**
   * Scan and load all manifests into the cache at startup.
   * Invalid manifests are logged as warnings and skipped.
   *
   * v0.2.0 grandfather migration: manifests written before the
   * v0.2.0 fields existed are coerced into the new shape on load.
   * `captureRequires` (v1.5) and `approvedCaptures` default to empty
   * arrays — so the capture endpoint step 3 always answers
   * `CaptureNotDeclared` for grandfather installs — and `trustLevel`
   * defaults to `'unknown'`. The cache then sees a fully-populated
   * manifest regardless of how old the on-disk file is, and the
   * migrated shape is persisted back on the next `save()` call. See
   * recipe-system.md v1.5 §6.10.4.
   *
   * Invariant I-CR1 (`approvedCaptures ⊆ captureRequires`) is also
   * verified here: a manifest that satisfies the legacy validator
   * but violates I-CR1 (e.g. a tampered file written by hand) is
   * skipped with a warn-level log so a stale manifest cannot widen
   * the capture surface at runtime (recipe-system.md v1.5 §6.10.3).
   */
  loadAll(): void {
    this.cache.clear()

    if (!this.fs.existsSync(this.baseDir)) {
      return // Directory not created = no installed recipes
    }

    const entries = this.fs.readdirSync(this.baseDir)
    let migratedCount = 0
    for (const entry of entries) {
      const manifestPath = join(this.baseDir, entry, 'manifest.json')
      if (!this.fs.existsSync(manifestPath)) {
        continue
      }

      try {
        const raw = this.fs.readFileSync(manifestPath, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        const validationError = validateManifest(parsed)
        if (validationError) {
          recipeLogger.warn(`[manifest-store] Skipping invalid manifest: ${manifestPath} — ${validationError}`)
          continue
        }
        // Migrate the on-disk shape to the v0.2.0 manifest. The
        // function returns the same reference when nothing changed,
        // so a fully-current manifest does not allocate.
        const { manifest, migrated } = applyGrandfatherMigration(parsed as Record<string, unknown>)
        if (migrated) {
          migratedCount += 1
        }

        // I-CR1 enforcement at load time. The validator above
        // guarantees both fields are well-typed arrays of capture
        // kinds; here we additionally guarantee the subset
        // relationship so the runtime gate can trust the manifest
        // shape end-to-end.
        const declaredSet = new Set<CaptureKind>(manifest.captureRequires)
        const offender = manifest.approvedCaptures.find((kind) => !declaredSet.has(kind))
        if (offender !== undefined) {
          recipeLogger.warn(
            {
              appId: manifest.appId,
              recipeId: manifest.recipeId,
              offender,
            },
            `[manifest-store] Skipping I-CR1 violating manifest at ${manifestPath} ` +
              `(approvedCaptures contains "${offender}" which is not in captureRequires).`,
          )
          continue
        }

        this.cache.set(manifest.appId, manifest)
      } catch (err) {
        recipeLogger.warn({ err }, `[manifest-store] Failed to load manifest: ${manifestPath}`)
      }
    }

    if (migratedCount > 0) {
      recipeLogger.info(
        { migratedCount },
        `[manifest-store] Migrated ${migratedCount} grandfather manifest(s) to v0.2.0 shape ` +
          `(captureRequires=[], approvedCaptures=[], trustLevel='unknown'). ` +
          'The on-disk shape is rewritten on the next save().',
      )
    }
    recipeLogger.info(`[manifest-store] Loaded ${this.cache.size} manifest(s)`)
  }

  /**
   * Save a manifest and update the cache. Keyed by `manifest.appId`
   * (the KB-local identifier); the manifest's own `recipeId` field
   * is preserved as recipe-lineage metadata.
   */
  save(manifest: RecipeManifest): void {
    const dir = join(this.baseDir, manifest.appId)
    if (!this.fs.existsSync(dir)) {
      this.fs.mkdirSync(dir, { recursive: true })
    }

    const manifestPath = join(dir, 'manifest.json')
    // Atomic replace: a partial write here would surface on the next
    // boot as a JSON.parse failure and drop the recipe from the
    // manifest cache (effectively "uninstalling" it).
    this.fs.writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
    this.cache.set(manifest.appId, manifest)
  }

  /**
   * Get the manifest for the specified `appId`.
   */
  get(appId: string): RecipeManifest | null {
    return this.cache.get(appId) ?? null
  }

  /**
   * Return all manifests as a list.
   */
  list(): RecipeManifest[] {
    return [...this.cache.values()]
  }

  /**
   * Delete a manifest (for uninstall).
   */
  delete(appId: string): void {
    const dir = join(this.baseDir, appId)
    const manifestPath = join(dir, 'manifest.json')
    if (this.fs.existsSync(manifestPath)) {
      this.fs.unlinkSync(manifestPath)
    }
    this.cache.delete(appId)
  }

  /**
   * Check whether the specified `appId` is installed.
   */
  has(appId: string): boolean {
    return this.cache.has(appId)
  }
}

// =========================================
// Validation
// =========================================

/**
 * Validate a manifest.json object.
 *
 * The v0.2.0 fields (`approvedCaptures`, `trustLevel`) are validated
 * **only when present**: legacy manifests written before the v0.2.0
 * upgrade omit them and {@link applyGrandfatherMigration} fills the
 * defaults on load. New manifests written by the post-v0.2.0
 * mark-installed handler always include the fields.
 *
 * @returns null if valid, error message string if invalid
 */
function validateManifest(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'manifest must be an object'
  }

  const obj = raw as Record<string, unknown>

  // Required string fields. `appId` is the KB-local identifier
  // (cache key); `recipeId` is the recipe author's lineage id;
  // `recipeVersion` was renamed from the legacy `version`.
  for (const field of ['appId', 'recipeId', 'recipeVersion', 'hash', 'installedAt'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      return `"${field}" must be a non-empty string`
    }
  }

  // approvedScopes
  if (!Array.isArray(obj.approvedScopes)) {
    return '"approvedScopes" must be an array'
  }
  for (const scope of obj.approvedScopes) {
    if (!isValidScope(scope)) {
      return `approvedScopes contains invalid scope: "${String(scope)}"`
    }
  }

  // api
  if (typeof obj.api !== 'object' || obj.api === null || Array.isArray(obj.api)) {
    return '"api" must be an object'
  }
  const api = obj.api as Record<string, unknown>

  if (!Array.isArray(api.scopes)) {
    return '"api.scopes" must be an array'
  }
  for (const scope of api.scopes) {
    if (!isValidScope(scope)) {
      return `api.scopes contains invalid scope: "${String(scope)}"`
    }
  }

  if (!Array.isArray(api.calls)) {
    return '"api.calls" must be an array'
  }
  for (let i = 0; i < api.calls.length; i++) {
    const call = api.calls[i] as Record<string, unknown>
    if (typeof call !== 'object' || call === null) {
      return `api.calls[${i}] must be an object`
    }
    if (typeof call.id !== 'string' || call.id.length === 0) {
      return `api.calls[${i}].id must be a non-empty string`
    }
    if (!isValidHandlerName(call.handler)) {
      return `api.calls[${i}].handler "${String(call.handler)}" is not valid`
    }
  }

  // v0.2.0 fields — validated only when present so a legacy manifest
  // still loads (the migration helper fills in the defaults).
  if (obj.captureRequires !== undefined) {
    if (!Array.isArray(obj.captureRequires)) {
      return '"captureRequires" must be an array'
    }
    for (const kind of obj.captureRequires) {
      if (!isValidCaptureKind(kind)) {
        return `captureRequires contains invalid capture kind: "${String(kind)}"`
      }
    }
  }
  if (obj.approvedCaptures !== undefined) {
    if (!Array.isArray(obj.approvedCaptures)) {
      return '"approvedCaptures" must be an array'
    }
    for (const kind of obj.approvedCaptures) {
      if (!isValidCaptureKind(kind)) {
        return `approvedCaptures contains invalid capture kind: "${String(kind)}"`
      }
    }
  }

  if (obj.trustLevel !== undefined) {
    if (!isValidTrustLevel(obj.trustLevel)) {
      return `"trustLevel" is not a valid trust-level: "${String(obj.trustLevel)}"`
    }
    // `'KB-trusted'` is the reserved KB-core literal and must never
    // accompany a recipe manifest (prompt-injection-threat-model.md
    // v1.0 §2). A corrupted on-disk record or a future server bug
    // could still land here; treat the value as a hard validation
    // failure so `loadAll` skips the manifest (the dispatcher then
    // refuses the recipe entirely, instead of inflating the badge).
    if (obj.trustLevel === 'KB-trusted') {
      return '"trustLevel" must not be "KB-trusted" for a recipe manifest (reserved for KB-core surfaces)'
    }
    // v0.2.x integrity-gap fail-closed: the install path is
    // temporarily disabled (recipe-system.md v1.7.3 §10.6) and v0.2.x
    // has no signing or sideload verification flow that can
    // legitimately mint `'code-trusted'` / `'code-trusted (sideloaded)'`
    // — those literals only become valid when KovitoHub signature
    // verification ships in v0.3.0 (§6.10.6.12). Until then a
    // persisted non-`'unknown'` literal can only come from a
    // hand-edited manifest, a corrupted JSON, or a v0.3.0 record
    // restored into a v0.2.x runtime, none of which the renderer
    // can verify. Reject the manifest so the recipe disappears
    // rather than letting the disk literal drive the audit log and
    // badge UI. The v0.3.0 install path will remove this guard
    // when verification arrives.
    if (obj.trustLevel === 'code-trusted' || obj.trustLevel === 'code-trusted (sideloaded)') {
      return (
        `"trustLevel" "${obj.trustLevel}" is not verifiable in v0.2.x; ` +
        'expected "unknown" until KovitoHub signature verification ships in v0.3.0'
      )
    }
  }

  return null
}

/**
 * Coerce a `validateManifest`-checked record into a `RecipeManifest`
 * with the v0.2.0 fields filled in.
 *
 * - Manifests that already carry `captureRequires` /
 *   `approvedCaptures` / `trustLevel` pass through unchanged (the
 *   returned `migrated` flag is `false`).
 * - Legacy manifests without any of these fields gain
 *   `captureRequires: []` (capture endpoint step 3 always refuses) +
 *   `approvedCaptures: []` (capture endpoint step 4 would refuse
 *   anyway via I-CR1) + `trustLevel: 'unknown'` (trust-marker UI
 *   shows the user that the install predates the trust axis). The
 *   flag is `true` so the loader can log a single info line
 *   summarising the migration.
 *
 * The function intentionally clones only when it has to so a
 * fully-current manifest does not pay a copy cost on every restart.
 *
 * @see recipe-system.md v1.5 §6.10.4 (grandfather migration)
 */
export function applyGrandfatherMigration(
  raw: Record<string, unknown>,
): { manifest: RecipeManifest; migrated: boolean } {
  const hasRequires = 'captureRequires' in raw && Array.isArray(raw.captureRequires)
  const hasCaptures = 'approvedCaptures' in raw && Array.isArray(raw.approvedCaptures)
  const hasTrust = 'trustLevel' in raw && typeof raw.trustLevel === 'string'

  if (hasRequires && hasCaptures && hasTrust) {
    return { manifest: raw as unknown as RecipeManifest, migrated: false }
  }

  // Build a shallow copy with the v0.2.0 defaults patched in. We
  // avoid mutating `raw` so the caller's reference (e.g. the
  // JSON.parse result the loader still holds) stays stable for the
  // error path.
  const captureRequires: CaptureKind[] = hasRequires
    ? (raw.captureRequires as CaptureKind[])
    : []
  const approvedCaptures: CaptureKind[] = hasCaptures
    ? (raw.approvedCaptures as CaptureKind[])
    : []
  const trustLevel: TrustLevel = hasTrust ? (raw.trustLevel as TrustLevel) : 'unknown'

  const migrated: RecipeManifest = {
    ...(raw as unknown as RecipeManifest),
    captureRequires,
    approvedCaptures,
    trustLevel,
  }
  return { manifest: migrated, migrated: true }
}
