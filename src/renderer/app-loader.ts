/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Stable API: Frontend extension loader.
 *
 * Discovers and loads user-defined menu entries and styles from app/.
 * These functions are the sole entry points for FE extensions.
 *
 * Public interface:
 *   - loadUserMenuEntries(): Promise<UserMenuEntriesResult>
 *   - loadUserStyles(): Promise<void>
 *
 * Implementation note (v0.1.0):
 *   Menu entry metadata is fetched from `GET /api/app/menu-entries`
 *   instead of being read directly via `import.meta.glob('../../app/menu.{ts,tsx}')`.
 *   The glob form was resolved exactly once at parent-module
 *   evaluation time, so menu entries created after the dev server
 *   started (e.g. by a recipe install) only appeared after a
 *   supervisor restart. Routing the metadata through the API removes
 *   that gap.
 *
 *   Page modules are loaded via Vite's `/@fs/<absolute>` URL with
 *   the `/* @vite-ignore *\/` hint so Vite does not try to resolve
 *   them at transform time. This sidesteps the same glob limitation
 *   for newly created page files. The trade-off is that the path is
 *   only resolvable while the Vite dev server is running, which
 *   matches DEC-016 (dev-mode canonical for v0.1.0).
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 * @see DEC-016 (dev-mode canonical)
 */

import type { AppMenuEntry, AppMenuModule } from './types/app-types'
import type { AppMenuEntryMeta } from '../shared/app-types'
import type { RecipePageTrustLevel } from '../shared/recipe-types'
import { isRecipePageTrustLevel } from '../shared/recipe-types'
import { createLogger } from './lib/logger'
import { kbFetch } from './lib/kbFetch'

const log = createLogger('app-loader')

/**
 * UI source badge value (v0.2.1). Derived server-side from
 * `AppManifest.source` so the renderer never has to parse the
 * persisted discriminator.
 *
 * @see src/server/services/menu-extractor.ts `MenuEntrySourceBadge`
 */
type MenuEntrySourceBadge =
  | 'self-made'
  | 'bundled'
  | 'sample'
  | 'import'
  | 'url'

/** Server-side shape returned by `GET /api/app/menu-entries`. */
interface MenuEntryWire extends AppMenuEntryMeta {
  /** Page path relative to `app/` (no extension), e.g. `pages/Foo`. */
  page: string
  /**
   * Absolute path to the page module on disk (with extension), or
   * `null` if the file is missing. Consumed by the renderer to
   * dynamic-import the module via Vite's `/@fs/` URL.
   */
  pageAbsolutePath: string | null
  /**
   * Trust-axis value sourced server-side from the active recipe
   * manifest (v0.2.0). `null` when the manifest has not yet been
   * registered (legacy `app/menu.ts` edited outside the install
   * flow). The renderer forwards this to the trust-marker UI.
   *
   * Typed as the broader `string` on the wire because legacy /
   * forged payloads may emit `'KB-trusted'` (the reserved literal);
   * `toAppMenuEntry` runs the {@link RecipePageTrustLevel} guard
   * before forwarding to {@link AppMenuEntry.trustLevel}.
   */
  trustLevel?: string | null
  /**
   * UI source badge derived server-side from the matching
   * `AppManifest.source`. `null` when no manifest exists (legacy
   * hand-edited `app/menu.ts`). Five values: `'self-made'` (scanner
   * derived) + `'bundled' | 'sample' | 'import' | 'url'` (persisted).
   *
   * Optional on the wire so pre-v0.2.1 server builds (which omit
   * the field) still parse; `toAppMenuEntry` coerces `undefined` to
   * `null` before forwarding.
   *
   * @stable v0.2.1
   */
  source?: MenuEntrySourceBadge | null
  /**
   * Display name from `AppManifest.displayName`. `null` when no
   * manifest exists. Drives the row title on the Apps screen.
   *
   * Renderer fallback chain (`AppsTab.tsx`):
   *   `userMenuLabel ?? label ?? displayName ?? appId`
   * `label` (menu.ts-derived, refreshed on every scan) precedes
   * `displayName` (AppManifest install snapshot). See the
   * renderer-side `AppMenuEntry.displayName` JSDoc in
   * `types/app-types.ts` for the spec rationale
   * (`app-directory-extension.md` v1.6 §6.8.2 file SSOT).
   *
   * @stable v0.2.1
   */
  displayName?: string | null
  /**
   * Persisted menu order from `AppManifest.menuOrder`. Drives the
   * default sort on the Apps screen. `null` when no manifest exists
   * or the field is absent (pre-v0.2.1 manifest).
   *
   * @stable v0.2.1
   */
  menuOrder?: number | null
  /**
   * User override label from `AppManifest.userMenuLabel`. `null`
   * when not set (default to `displayName` / `label` / `appId`).
   *
   * @stable v0.2.1
   */
  userMenuLabel?: string | null
}

/**
 * Result shape returned by {@link loadUserMenuEntries}.
 *
 * - `entries` — the menu entries themselves (wire-validated).
 * - `menuOrderSnapshot` — the server's current menu-order snapshot
 *   hash, surfaced through the `X-Apps-Menu-Snapshot` response
 *   header. The Apps tab seeds `snapshotVersionRef` with this value
 *   on mount so the **first** `PUT /api/apps/menu-order` request
 *   already carries a `snapshotVersion`; without that seed the
 *   `MenuOrderSnapshotDrift` (HTTP 409) gate is silently skipped
 *   on the first reorder. `null` when the header is absent (the
 *   legacy `import.meta.glob` fallback path) or the server omitted
 *   it.
 *
 * @stable v0.2.1
 */
export interface UserMenuEntriesResult {
  entries: AppMenuEntry[]
  menuOrderSnapshot: string | null
}

/**
 * Discover and load user menu entries.
 *
 * Tries the API first; falls back to `import.meta.glob` for the
 * legacy in-tree `app/menu.{ts,tsx}` shape so existing tests (which
 * may stub the file directly without bringing up the API) keep
 * working.
 *
 * Returns a `{ entries, menuOrderSnapshot }` pair — the snapshot
 * comes from the `X-Apps-Menu-Snapshot` response header and is
 * `null` on the fallback path (no header to surface).
 */
export async function loadUserMenuEntries(): Promise<UserMenuEntriesResult> {
  // 1) Preferred path: API.
  try {
    const res = await kbFetch('/api/app/menu-entries')
    if (res.ok) {
      const snapshot = res.headers.get('X-Apps-Menu-Snapshot')
      const wire = (await res.json()) as MenuEntryWire[]
      if (Array.isArray(wire)) {
        return {
          entries: wire.map(toAppMenuEntry),
          menuOrderSnapshot: snapshot,
        }
      }
    } else if (res.status !== 404) {
      log.warn(
        { status: res.status },
        'Unexpected status from /api/app/menu-entries; falling back to glob',
      )
    }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch /api/app/menu-entries; falling back to glob')
  }

  // 2) Fallback: legacy direct glob (kept for backward compatibility
  //    with tests that stub `app/menu.ts` without standing up the API).
  const modules = import.meta.glob<AppMenuModule>('../../app/menu.{ts,tsx}')
  const paths = Object.keys(modules)
  if (paths.length === 0) {
    return { entries: [], menuOrderSnapshot: null }
  }

  try {
    const mod = await modules[paths[0]]()
    const raw = mod.menuEntries ?? []
    // Anything `app/menu.ts` claims about `trustLevel` is
    // author-controlled (the file lives inside the recipe artifact
    // directory). The only legitimate trust authority is the server
    // manifest store, which the API path reads via
    // `manifestStore.get(appId)?.trustLevel`. The fallback exists for
    // tests that stub `app/menu.ts` directly without standing up the
    // API; production browsers always reach the API path. Force
    // `trustLevel` to `null` here so a hostile fallback module cannot
    // forge a trusted badge — the trust marker silently hides itself
    // in that case rather than rendering a misleading claim.
    const entries: AppMenuEntry[] = raw.map((entry) => ({
      ...entry,
      trustLevel: null,
      // The legacy direct-glob fallback predates the v0.2.1 wire
      // additions; we cannot synthesise AppManifest-sourced fields
      // from `app/menu.ts` alone. Force them to `null` so the Apps
      // screen falls back to the bare `menu.ts` label and shows no
      // source badge. Production browsers always reach the API path,
      // which DOES populate these fields — the fallback only exists
      // for test doubles that stub `app/menu.ts` directly.
      source: null,
      displayName: null,
      menuOrder: null,
      userMenuLabel: null,
    }))
    return { entries, menuOrderSnapshot: null }
  } catch (err) {
    log.warn({ err }, 'Failed to load app/menu (fallback glob path)')
    return { entries: [], menuOrderSnapshot: null }
  }
}

/**
 * Convert the wire shape into the renderer's `AppMenuEntry` (with
 * a `component` thunk that resolves the page module on demand).
 *
 * The thunk uses `/@fs/<absolute>` so that Vite serves the file
 * directly without trying to match it against a `import.meta.glob`
 * pattern — this keeps freshly-installed page files reachable
 * without a supervisor restart.
 */
function toAppMenuEntry(meta: MenuEntryWire): AppMenuEntry {
  const absPath = meta.pageAbsolutePath
  // The wire payload may omit `trustLevel` (legacy server / test
  // doubles). Validate against `RecipePageTrustLevel` so an
  // unexpected literal — including the reserved `'KB-trusted'` value
  // which the spec marks as illegal for recipe-page entries — is
  // forced to `null` before it reaches the renderer-side
  // TrustMarker. A server bug or corrupted manifest that leaks
  // `'KB-trusted'` over the wire therefore hides the badge instead
  // of inflating a recipe install to the first-party signal.
  const trustLevel: RecipePageTrustLevel | null = isRecipePageTrustLevel(meta.trustLevel)
    ? meta.trustLevel
    : null
  if (meta.trustLevel === 'KB-trusted') {
    log.warn(
      { entryId: meta.id },
      'Refusing to render KB-trusted badge on a recipe-page menu entry; treating as null. ' +
        'KB-trusted is reserved for KB-core surfaces and must never accompany a recipe install — ' +
        'investigate the manifest source if this fires.',
    )
  }
  // Coerce optional wire fields to `null` so renderer call sites
  // can use the strict `T | null` discriminator without a separate
  // `undefined` branch. Pre-v0.2.1 servers omit these fields; the
  // renderer treats both states ("not sent" / "no manifest") the
  // same — fall back to the bare `menu.ts` label, render no badge.
  const source: MenuEntrySourceBadge | null = isMenuEntrySourceBadge(meta.source)
    ? meta.source
    : null
  const displayName: string | null =
    typeof meta.displayName === 'string' ? meta.displayName : null
  const menuOrder: number | null =
    typeof meta.menuOrder === 'number' && Number.isInteger(meta.menuOrder)
      ? meta.menuOrder
      : null
  const userMenuLabel: string | null =
    typeof meta.userMenuLabel === 'string' ? meta.userMenuLabel : null
  return {
    id: meta.id,
    label: meta.label,
    icon: meta.icon,
    trustLevel,
    source,
    displayName,
    menuOrder,
    userMenuLabel,
    component: () => {
      if (!absPath) {
        const err = new Error(
          `[app-loader] Page module not found for "${meta.page}". ` +
            'The recipe author may have referenced a missing file, or ' +
            'the file write has not finished yet. Try reloading.',
        )
        log.warn({ page: meta.page }, 'Page module path missing in API response')
        return Promise.reject(err)
      }
      // `/* @vite-ignore */` prevents Vite from trying to statically
      // analyze this dynamic import. The `/@fs/` prefix instructs
      // the dev server to serve the absolute path. Both are
      // dev-mode-only constructs (DEC-016).
      return import(/* @vite-ignore */ `/@fs${absPath}`) as Promise<{
        default: React.ComponentType
      }>
    },
  }
}

/**
 * Type guard for the v0.2.1 source badge wire field. Defends the
 * renderer against unexpected literals (older server build that
 * emits a fifth recipeSource value, or a forged response). Unknown
 * values are coerced to `null` so the badge silently hides instead
 * of rendering a misleading state.
 */
function isMenuEntrySourceBadge(
  value: unknown,
): value is MenuEntrySourceBadge {
  return (
    value === 'self-made' ||
    value === 'bundled' ||
    value === 'sample' ||
    value === 'import' ||
    value === 'url'
  )
}

/**
 * Discover and load all user CSS from app/styles/.
 * Each matched CSS file is imported as a side effect.
 */
export async function loadUserStyles(): Promise<void> {
  const styles = import.meta.glob('../../app/styles/**/*.css')

  for (const path of Object.keys(styles)) {
    try {
      await styles[path]()
    } catch (err) {
      log.warn({ err, path }, 'Failed to load style')
    }
  }
}
