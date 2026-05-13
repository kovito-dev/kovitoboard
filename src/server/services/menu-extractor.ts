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
import { join, normalize, sep } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { resolveProjectRoot } from '../config'
import type { AppMenuEntryMeta } from '../../shared/app-types'
import type { RecipePageTrustLevel } from '../recipe/apiTypes'

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
  /**
   * Trust-axis value sourced from the active `RecipeManifest`
   * for the menu entry's `appId` (v0.2.0), narrowed to the
   * recipe-page-only subset so the reserved `'KB-trusted'` literal
   * cannot reach the wire even as a representable state. `null` when
   * no manifest has been registered for the entry yet (pre-install
   * probe, hand-edited `app/menu.ts`, canonical-prefix guard refusal,
   * or `'KB-trusted'` coerced by the lookup helper).
   *
   * The renderer reads this to render the recipe-page trust marker
   * without an extra round-trip. v0.2.x always supplies `'unknown'`
   * for managed installs (grandfather migration) — v0.3.0 wiring
   * extends this to `'code-trusted'` / `'code-trusted (sideloaded)'`
   * without a wire-format change.
   *
   * @see recipe-system.md v1.4 §6.10.3 / §6.10.4
   * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
   * @stable v0.2.0
   */
  trustLevel: RecipePageTrustLevel | null
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
      // Trust level is filled in by `readUserMenuEntries` after the
      // manifest lookup. Parser stays oblivious so the legacy
      // `parseMenuTs` test surface keeps the same call shape.
      trustLevel: null,
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
 * Optional manifest lookup used by `readUserMenuEntries` to attach
 * the active recipe's trust level to each entry. Narrowed to
 * {@link RecipePageTrustLevel} so the impossible `'KB-trusted'`
 * state is not even representable at the menu-entry boundary —
 * callers (currently `app-routes.ts`) coerce the broader manifest
 * `TrustLevel` to this narrower union (or `null`) before handing it
 * to the extractor.
 */
export type TrustLevelLookup = (appId: string) => RecipePageTrustLevel | null

/**
 * Read `app/menu.ts` from disk and return parsed entries.
 *
 * - Returns `[]` if the file does not exist (newly initialized projects).
 * - Returns `[]` and logs a warning if parsing fails — the renderer
 *   should remain functional even when a recipe author writes an
 *   unparseable `menu.ts`.
 *
 * When `trustLookup` is supplied (the API path always does), each
 * entry's `trustLevel` is populated from the active manifest store
 * so the renderer can render the recipe-page trust marker without
 * an extra round-trip.
 */
export function readUserMenuEntries(
  fs: FileAccessLayer,
  trustLookup?: TrustLevelLookup,
): MenuEntryWithPage[] {
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
    if (trustLookup) {
      // Only attach the manifest's trust level when the menu row is
      // bound to the canonical artifact directory for its `appId`.
      // `recipe-applicator.ts` always emits `component: () =>
      // import('./<appId>/...')` — anything else is either an honest
      // hand-edit that should not inherit the badge or a forgery
      // attempt that reuses an installed `appId` while pointing at
      // foreign code. We normalize the raw page string first so a
      // path-traversal segment (`doc-viewer/../evil-app/...`) cannot
      // satisfy a naive `startsWith(`${id}/`)` check.
      if (isCanonicalAppIdPath(entry.page, entry.id)) {
        entry.trustLevel = trustLookup(entry.id)
      } else {
        entry.trustLevel = null
      }
    }
  }

  return entries
}

/**
 * Returns true when `page` (as parsed out of `import('./<page>')`)
 * resolves to a location strictly inside the canonical
 * `app/<appId>/` directory — i.e. the canonical recipe-applicator
 * layout. Path-traversal segments (`../`), absolute paths, and
 * Windows-style `\` separators are all rejected up front.
 *
 * Defends against the hand-edited `app/menu.ts` row that reuses an
 * installed `appId` while pointing `component` at a different
 * directory: such a row would otherwise inherit the manifest's
 * trust badge and let attacker-authored UI borrow a trusted signal.
 *
 * Exported so unit tests can exercise the bypass cases directly
 * (absolute paths, backslash separators, nested traversal) without
 * having to drive the regex through `parseMenuTs` first — the
 * parser regex already filters most of these shapes out, but the
 * canonical-path check is the SSOT and should be testable on its
 * own.
 */
export function isCanonicalAppIdPath(page: string, appId: string): boolean {
  // Cheap structural rejections first: forward slash is the only
  // separator the recipe layout uses on disk and the only separator
  // the parser's regex emits, so any backslash or leading slash is
  // already non-canonical (and avoids quirks on Windows hosts).
  if (page.length === 0) return false
  if (page.startsWith('/') || page.startsWith('\\')) return false
  if (page.includes('\\')) return false

  // Normalize collapses `./` and `../` segments — `doc-viewer/../evil-app`
  // becomes `evil-app`. We then re-check the canonical prefix on the
  // normalized form so a traversal cannot dress an attacker path up
  // to look like it lives under `<appId>/`.
  const normalized = normalize(page)
  if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`)) {
    return false
  }
  // POSIX path normalization (the parser regex emits forward slashes
  // only) — convert any Windows back-slashes that `normalize` might
  // emit on Win32 hosts so the canonical-prefix comparison stays
  // platform-independent.
  const posix = normalized.split(sep).join('/')
  return posix === appId || posix.startsWith(`${appId}/`)
}

/** Absolute path to `app/menu.ts` (used by the file watcher). */
export function getMenuTsPath(fs: FileAccessLayer): string {
  const projectRoot = resolveProjectRoot(fs)
  return join(projectRoot, 'app', 'menu.ts')
}
