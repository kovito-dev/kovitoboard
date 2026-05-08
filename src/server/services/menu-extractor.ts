/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Menu extractor — parse `app/menu.ts` and return user-defined menu entries.
 *
 * Used by `GET /api/app/menu-entries` to expose the renderer-facing menu
 * contract without depending on Vite's `import.meta.glob`. The renderer
 * consumes the JSON output and resolves each `page` path to a dynamic
 * import at the call site.
 *
 * The parser uses a regex (the source is TypeScript, so `JSON.parse` is
 * not an option) and is intentionally permissive: malformed entries are
 * skipped, missing files yield an empty array, and parse failures are
 * logged as warnings without throwing.
 */
import { serverLogger } from '../logger'
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { resolveProjectRoot } from '../config'
import type { AppMenuEntryMeta } from '../../shared/app-types'

/** Menu entry shape returned by the extractor (meta + page path). */
export interface MenuEntryWithPage extends AppMenuEntryMeta {
  /** Page module path relative to `app/`, e.g. `pages/Foo` (no extension). */
  page: string
  /**
   * Absolute path to the page module on disk (with extension).
   * Populated by `readUserMenuEntries`; the renderer uses it to
   * dynamic-import the file via Vite's `/@fs/` URL scheme so that
   * pages added after dev-server boot are loadable without a
   * supervisor restart. `null` when no matching `.tsx` / `.ts`
   * file exists (recipe author error or the file is still being
   * written).
   */
  pageAbsolutePath: string | null
}

/**
 * Parse the contents of `app/menu.ts` and extract menu entry definitions.
 *
 * Recognized shape (all four fields required):
 *   { id: '<id>', label: '<label>', icon: '<icon>',
 *     component: () => import('./<page>') }
 *
 * Each `page` value is the path passed to the `import()` call, with the
 * leading `./` stripped (e.g. `pages/Foo` for `import('./pages/Foo')`).
 */
export function parseMenuTs(content: string): MenuEntryWithPage[] {
  const entries: MenuEntryWithPage[] = []

  // Match individual object literals in the menuEntries array.
  // Whitespace and quote style (single/double) are tolerated; field order
  // is not — recipe-applicator emits id/label/icon/component in this order
  // and that is the only shape we currently support.
  const entryPattern =
    /\{\s*id:\s*['"]([^'"]+)['"]\s*,\s*label:\s*['"]([^'"]+)['"]\s*,\s*icon:\s*['"]([^'"]+)['"]\s*,\s*component:\s*\(\)\s*=>\s*import\(\s*['"]\.\/([^'"]+)['"]\s*\)/g

  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(content)) !== null) {
    entries.push({
      id: match[1],
      label: match[2],
      icon: match[3],
      page: match[4],
      // Absolute path is filled in by readUserMenuEntries; the bare
      // parser cannot probe the filesystem.
      pageAbsolutePath: null,
    })
  }

  return entries
}

/**
 * Parse `app/menu.ts` and return only the entries whose `id` matches
 * `appId`. DEC-024 D-1 mandates `entry.id === appId`, so the result
 * is at most one entry in well-formed projects, but the extractor
 * stays permissive: callers receive whatever rows match. An empty
 * result is also valid (the app may not register a menu entry).
 *
 * Used by the recipe exporter when writing `recipe.yaml`'s `menu:`
 * section so cross-app menu rows do not leak into the export.
 */
export function parseMenuTsForApp(content: string, appId: string): MenuEntryWithPage[] {
  return parseMenuTs(content).filter((entry) => entry.id === appId)
}

/**
 * Read `app/menu.ts` from disk and return parsed entries.
 *
 * - Returns `[]` if the file does not exist (newly initialized projects).
 * - Returns `[]` and logs a warning if parsing fails — the renderer
 *   should remain functional even when a recipe author writes an
 *   unparseable `menu.ts`.
 */
export function readUserMenuEntries(fs: FileAccessLayer): MenuEntryWithPage[] {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')
  const menuPath = join(appDir, 'menu.ts')

  if (!fs.existsSync(menuPath)) return []

  let entries: MenuEntryWithPage[]
  try {
    const content = fs.readFileSync(menuPath, 'utf-8')
    entries = parseMenuTs(content)
  } catch (err) {
    serverLogger.warn({ err }, '[menu-extractor] Failed to read or parse app/menu.ts:')
    return []
  }

  // Resolve each `page` to an absolute path on disk. Tries `.tsx`
  // first (the recipe convention), then `.ts`. Leaves the field
  // `null` if neither exists; the renderer surfaces a clear error
  // in that case rather than silently dropping the menu entry.
  for (const entry of entries) {
    const tsxPath = join(appDir, `${entry.page}.tsx`)
    const tsPath = join(appDir, `${entry.page}.ts`)
    if (fs.existsSync(tsxPath)) {
      entry.pageAbsolutePath = tsxPath
    } else if (fs.existsSync(tsPath)) {
      entry.pageAbsolutePath = tsPath
    }
  }

  return entries
}

/** Absolute path to `app/menu.ts` (used by the file watcher). */
export function getMenuTsPath(fs: FileAccessLayer): string {
  const projectRoot = resolveProjectRoot(fs)
  return join(projectRoot, 'app', 'menu.ts')
}
