/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App manifest helpers — read / write / scan
 * `app/<appId>/manifest.json`.
 *
 * The app manifest is **not** the dispatcher gate
 * (`recipes-installed/<appId>/manifest.json` is); it is a separate
 * file that records *what* an installed app is — its display name,
 * the recipe lineage when applicable, and the agent that created it
 * for user-creation apps. It exists so that:
 *   - The recipe sample page can tell which apps were installed
 *     from a given recipe (`source.recipeId`).
 *   - The agent has a canonical place to look at uninstall time to
 *     know what to remove.
 *   - The reinstall flow can detect same-name conflicts before
 *     dispatching the next install request.
 *
 * Reads are best-effort: `readAppManifest` returns `null` for
 * missing / malformed files (with a warn line) so callers can
 * surface a recoverable "half-installed" state to the UI without
 * having to wrap every read in try/catch. Writes are atomic
 * (`writeFileAtomic`: same-directory temp + fsync + rename) and do
 * throw — the agent's "mark installed" step needs the failure to
 * bubble up so the install does not silently complete with no
 * manifest.
 *
 * @see docs/specs/v0.1.0-app-id-and-manifest.md §3.2
 * @see DEC-024 D-4-a, recipe-system.md v2.0 § 13-3
 * @stable v0.1.0
 */
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import type { AppManifest } from '../../shared/app-manifest-types'
import { recipeLogger } from '../logger'

const APP_MANIFEST_FILENAME = 'manifest.json'

/** Resolve the on-disk path to `app/<appId>/manifest.json`. */
export function getAppManifestPath(projectRoot: string, appId: string): string {
  return join(projectRoot, 'app', appId, APP_MANIFEST_FILENAME)
}

/**
 * Read `app/<appId>/manifest.json` and return the parsed manifest.
 *
 * Returns `null` (with a `recipe` warn line) when:
 *   - the file does not exist,
 *   - the file exists but cannot be read,
 *   - the file exists but is not valid JSON,
 *   - the parsed JSON does not satisfy the `AppManifest` shape.
 *
 * Never throws. Callers that need to *require* a manifest (e.g. the
 * uninstall handler) should treat `null` as the "missing" signal
 * and decide their own recovery policy.
 */
export function readAppManifest(
  fs: FileAccessLayer,
  projectRoot: string,
  appId: string,
): AppManifest | null {
  const path = getAppManifestPath(projectRoot, appId)
  if (!fs.existsSync(path)) return null

  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    recipeLogger.warn(
      { err, appId, path },
      'Failed to read app manifest; treating as missing',
    )
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    recipeLogger.warn(
      { err, appId, path },
      'app manifest is not valid JSON; treating as missing',
    )
    return null
  }

  if (!isAppManifest(parsed)) {
    recipeLogger.warn(
      { appId, path },
      'app manifest does not match expected schema; treating as missing',
    )
    return null
  }

  return parsed
}

/**
 * Atomic-ish write of `app/<appId>/manifest.json`. Creates the
 * `app/<appId>/` directory if it does not exist. Throws on any
 * filesystem error so the agent's "mark installed" step surfaces
 * the failure to the user instead of silently leaving a recipe in
 * a half-installed state.
 *
 * The write is JSON.stringified with two-space indentation so
 * users who open the file by hand see something readable. The
 * trailing newline matches the `recipe-history.jsonl` /
 * `setting.json` style used elsewhere.
 */
export function writeAppManifest(
  fs: FileAccessLayer,
  projectRoot: string,
  manifest: AppManifest,
): void {
  const dir = join(projectRoot, 'app', manifest.appId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const path = join(dir, APP_MANIFEST_FILENAME)
  fs.writeFileAtomic(path, JSON.stringify(manifest, null, 2) + '\n')
}

/**
 * Scan every immediate subdirectory of `app/` and return the
 * manifests of those that contain a parseable `manifest.json`.
 *
 * Used by:
 *   - The recipe sample page, to compute the "installed" badge by
 *     `source.recipeId` (paired with `recipe-history.json`).
 *   - The reinstall flow, for same-name conflict detection.
 *   - The uninstall flow, to discover what to remove.
 *
 * Subdirectories without a manifest, or with a malformed manifest,
 * are silently skipped (the warn lines come from `readAppManifest`).
 * Returns an empty array when `app/` itself does not exist.
 */
export function scanAppManifests(
  fs: FileAccessLayer,
  projectRoot: string,
): AppManifest[] {
  const appDir = join(projectRoot, 'app')
  if (!fs.existsSync(appDir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(appDir)
  } catch (err) {
    recipeLogger.warn(
      { err, appDir },
      'Failed to readdir app/; returning empty manifest list',
    )
    return []
  }

  const manifests: AppManifest[] = []
  for (const entry of entries) {
    const manifest = readAppManifest(fs, projectRoot, entry)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

/**
 * Discriminate between a parsed JSON value and an `AppManifest`.
 * Conservative: only accepts shapes that pass every required check
 * for both `AppManifest` itself and the `AppSourceInfo` discriminator.
 * Optional / future fields are not gated here; we do not want a
 * v0.2.0 manifest to be rejected by a v0.1.0 reader.
 */
function isAppManifest(value: unknown): value is AppManifest {
  if (!isPlainObject(value)) return false
  if (typeof value.appId !== 'string' || value.appId.length === 0) return false
  if (typeof value.displayName !== 'string') return false
  if (typeof value.createdAt !== 'string') return false
  if (typeof value.kovitoboardVersion !== 'string') return false
  if (!isPlainObject(value.source)) return false

  const src = value.source
  if (src.type === 'recipe') {
    return (
      typeof src.recipeId === 'string' &&
      typeof src.recipeVersion === 'string' &&
      (src.recipeSource === 'sample' ||
        src.recipeSource === 'import' ||
        src.recipeSource === 'url')
    )
  }
  if (src.type === 'user-creation') {
    return typeof src.createdViaAgent === 'string'
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
