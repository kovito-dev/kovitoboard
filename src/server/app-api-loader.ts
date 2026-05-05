/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Stable API: Backend API extension loader.
 *
 * Scans two directory patterns and mounts each file as an Express Router:
 *
 * 1. Flat layout:   app/api/*.ts       → /api/ext/{filename}
 * 2. Nested layout:  app/{app-name}/api/*.ts → /api/ext/{app-name}/{filename}
 *    (DEC-008: app-name must match /^[a-z][a-z0-9-]{0,63}$/)
 *
 * Public interface:
 *   - mountAppApiRoutes(app: Express, fs: FileAccessLayer): Promise<void>
 *
 * Mount convention:
 *   - app/api/example.ts → /api/ext/example
 *   - app/api/_helpers.ts → skipped (underscore prefix = internal helper)
 *   - app/research-reports/api/start-research.ts → /api/ext/research-reports/start-research
 *
 * On duplicate mount paths, the first-scanned file wins and a warning is logged.
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 * @see DEC-008 (Nested app API loader)
 */

import { join, basename } from 'path'
import type { Express } from 'express'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'

/** Directories reserved under app/ — never treated as app names for nested layout */
const RESERVED_DIRS = new Set(['api', 'pages', 'styles', 'data'])

/** Valid app-name pattern (DEC-008) */
const APP_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

export async function mountAppApiRoutes(
  app: Express,
  fs: FileAccessLayer,
): Promise<void> {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')

  if (!fs.existsSync(appDir)) {
    return // No app/ directory — nothing to mount
  }

  // Track mounted paths to detect duplicates (first wins)
  const mounted = new Set<string>()

  // 1. Flat layout (backward-compatible): app/api/*.ts → /api/ext/{filename}
  const flatApiDir = join(appDir, 'api')
  if (fs.existsSync(flatApiDir)) {
    await mountApiDir(app, fs, flatApiDir, null, mounted)
  }

  // 2. Nested layout (DEC-008): app/{app-name}/api/*.ts → /api/ext/{app-name}/{filename}
  const entries = fs.readdirSync(appDir)
  for (const name of entries) {
    if (RESERVED_DIRS.has(name)) continue

    if (!APP_NAME_RE.test(name)) {
      console.warn(`[app-api] SKIP (invalid name): app/${name}/ — must match ${APP_NAME_RE}`)
      continue
    }

    const nestedApiDir = join(appDir, name, 'api')
    if (!fs.existsSync(nestedApiDir)) continue

    // Verify it is a readable directory (readdirSync throws on non-directory)
    try {
      fs.readdirSync(nestedApiDir)
    } catch {
      continue
    }

    await mountApiDir(app, fs, nestedApiDir, name, mounted)
  }
}

/**
 * Mount all .ts/.js files in a single API directory.
 *
 * @param apiDir  - Absolute path to the api/ directory to scan
 * @param appName - null for flat layout, app name string for nested layout
 * @param mounted - Set of already-mounted paths for duplicate detection
 */
async function mountApiDir(
  app: Express,
  fs: FileAccessLayer,
  apiDir: string,
  appName: string | null,
  mounted: Set<string>,
): Promise<void> {
  const files = fs.readdirSync(apiDir)
  for (const file of files) {
    // Skip non-.ts/.js files and _ prefixed files
    if (!/\.(ts|js)$/.test(file) || file.startsWith('_')) continue

    const routeName = basename(file).replace(/\.(ts|js)$/, '')
    const mountPath = appName
      ? `/api/ext/${appName}/${routeName}`
      : `/api/ext/${routeName}`
    const displaySource = appName
      ? `app/${appName}/api/${file}`
      : `app/api/${file}`

    // Duplicate detection (first wins)
    if (mounted.has(mountPath)) {
      console.warn(`[app-api] SKIP (duplicate): ${mountPath} ← ${displaySource}`)
      continue
    }

    const filePath = join(apiDir, file)
    try {
      const mod = await import(filePath)
      const router = mod.default
      if (!router) {
        console.warn(`[app-api] ${displaySource}: no default export, skipping`)
        continue
      }
      app.use(mountPath, router)
      mounted.add(mountPath)
      console.log(`[app-api] Mounted: ${mountPath} ← ${displaySource}`)
    } catch (err) {
      console.error(`[app-api] Failed to load ${displaySource}:`, err)
    }
  }
}
