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

import { join } from 'path'
import type { FileAccessLayer } from './fs-layer.js'
import type { RecipeManifest } from './recipe/apiTypes.js'
import { isValidScope, isValidHandlerName } from './recipe/apiTypes.js'

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
   */
  loadAll(): void {
    this.cache.clear()

    if (!this.fs.existsSync(this.baseDir)) {
      return // Directory not created = no installed recipes
    }

    const entries = this.fs.readdirSync(this.baseDir)
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
          console.warn(`[manifest-store] Skipping invalid manifest: ${manifestPath} — ${validationError}`)
          continue
        }
        const manifest = parsed as RecipeManifest
        this.cache.set(manifest.appId, manifest)
      } catch (err) {
        console.warn(`[manifest-store] Failed to load manifest: ${manifestPath}`, err)
      }
    }

    console.log(`[manifest-store] Loaded ${this.cache.size} manifest(s)`)
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
    this.fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
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

  return null
}
