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
import { createHash } from 'crypto'
import { join, normalize, resolve, sep } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { resolveProjectRoot } from '../config'
import { parseRecipe } from '../recipe-parser'
import type { ParsedRecipe } from '../../shared/recipe-types'
import type { AppMenuEntryMeta } from '../../shared/app-types'
import type { RecipeManifest, RecipePageTrustLevel } from '../recipe/apiTypes'
import type { AppManifest } from '../../shared/app-manifest-types'

/**
 * UI-facing source classification derived from `AppManifest.source`.
 *
 * Five values:
 *   - `'self-made'`   — scanner-derived (`source.type === 'user-creation'`).
 *                       Not part of the persisted enum; computed on read.
 *   - `'bundled'`     — `source.type === 'recipe'` + `recipeSource === 'bundled'`.
 *   - `'sample'`      — `source.type === 'recipe'` + `recipeSource === 'sample'`.
 *   - `'import'`      — `source.type === 'recipe'` + `recipeSource === 'import'`.
 *   - `'url'`         — `source.type === 'recipe'` + `recipeSource === 'url'`.
 *
 * v0.2.1 Apps screen renders each row's badge from this discriminator.
 *
 * @see docs/specs/app-directory-extension.md v1.6 §6.7
 * @see docs/specs/data-persistence.md v1.4 §6.8 (persisted enum 4-value SSOT)
 * @stable v0.2.1
 */
export type MenuEntrySourceBadge =
  | 'self-made'
  | 'bundled'
  | 'sample'
  | 'import'
  | 'url'

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
  /**
   * UI source badge derived from the active `AppManifest` for this
   * menu row's `appId`. `null` when no matching `AppManifest` exists
   * (legacy hand-edited `app/menu.ts` with no install lineage). The
   * v0.2.1 Apps screen renders this verbatim; older renderers ignore
   * the field for backward compatibility.
   *
   * @see docs/specs/app-directory-extension.md v1.6 §6.7
   * @stable v0.2.1
   */
  source: MenuEntrySourceBadge | null
  /**
   * Display name from the active `AppManifest.displayName`. Used by
   * the Apps screen so the row matches the manifest-recorded name
   * instead of the bare `label` from `app/menu.ts`. `null` when no
   * matching `AppManifest` exists.
   *
   * Distinct from `userMenuLabel` (below): `displayName` is the
   * default name persisted at install / create time, while
   * `userMenuLabel` is the user's override (when set).
   *
   * @see docs/specs/app-directory-extension.md v1.6 §6.2
   * @stable v0.2.1
   */
  displayName: string | null
  /**
   * Persisted menu-order index from the active `AppManifest.menuOrder`.
   * Drives the default sort on the Apps screen. `null` when no
   * matching `AppManifest` exists or the field is absent (pre-v0.2.1
   * manifest).
   *
   * @see docs/specs/app-directory-extension.md v1.6 §6.2
   * @stable v0.2.1
   */
  menuOrder: number | null
  /**
   * Quad-state discriminator for the AppManifest read attempt.
   *
   *   - `'present'`   : `app/<appId>/manifest.json` exists and
   *                     parsed successfully.
   *   - `'unreadable'`: the file exists on disk but the parse /
   *                     schema validation failed -- the partial-
   *                     residue recovery window the spec wants
   *                     routed through bundled disable.
   *   - `'missing'`   : the file is entirely absent -- a
   *                     legitimate legacy / hand-edited row that
   *                     never had an AppManifest.
   *   - `'anomalous'` : the canonical `app/<appId>/` directory
   *                     fails the realpath boundary check
   *                     (symlink escape, missing canonical
   *                     directory, etc.). Every destructive
   *                     wire action must be suppressed for this
   *                     state because nothing about the row can
   *                     be trusted.
   *
   * The Apps screen reads this to keep `Remove app` available for
   * legacy hand-edited rows while suppressing destructive actions
   * for the unreadable recovery state and the anomalous state,
   * without ever conflating the two on the `source === null`
   * axis (which carries multiple states on its own).
   *
   * @stable v0.2.1
   */
  manifestState: 'present' | 'unreadable' | 'missing' | 'anomalous'
  /**
   * Recipe identifier (`recipe.yaml`'s `recipeId`) for apps whose
   * `AppManifest.source.type === 'recipe'`. The Apps tab uses this
   * to route disable / sample-specific operations through the
   * `POST /api/recipes/sample/:recipeId/disable` endpoint so the
   * `app/data/<appId>/` directory survives — taking a bundled /
   * sample app down the destructive remove-app path would delete
   * user data and violate the spec's grandfather data-preservation
   * invariant.
   *
   * `null` when no AppManifest exists or when the app is
   * `user-creation` (self-made).
   *
   * @see docs/specs/recipe-system.md v1.10 §10.9 (bundled disable)
   * @stable v0.2.1
   */
  recipeId: string | null
  /**
   * User override label from the active `AppManifest.userMenuLabel`.
   * `null` when not set (renderer falls back through the chain
   * below); empty string is invalid (rejected on PATCH).
   *
   * Spec base label SSOT (`app-directory-extension.md` v1.6 §6.8.2):
   *   `userMenuLabel ?? recipe.yaml.menu.label ?? menu.ts entry.label ?? appId`
   *
   * Wire-level approximation (renderer `AppsTab.tsx`, deferring the
   * server-side `recipe.yaml`-resolver follow-up):
   *   `userMenuLabel ?? label ?? displayName ?? appId`
   * `label` (file-derived from `app/menu.ts`, refreshed on every
   * scan) is preferred over the AppManifest install snapshot
   * `displayName` so recipe upgrades that mutate `menu.ts` propagate
   * without rewriting the manifest.
   *
   * @see docs/specs/app-directory-extension.md v1.6 §6.2 / §6.8.2
   * @stable v0.2.1
   */
  userMenuLabel: string | null
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
      // Trust level + AppManifest-derived fields are filled in by
      // `readUserMenuEntries` after the manifest lookup. Parser
      // stays oblivious so the legacy `parseMenuTs` test surface
      // keeps the same call shape.
      trustLevel: null,
      source: null,
      displayName: null,
      menuOrder: null,
      userMenuLabel: null,
      recipeId: null,
      // Parser-default state. `readUserMenuEntries` flips this to
      // `'present'` or `'unreadable'` once the AppManifest lookup
      // has fired; bare callers (the recipe-exporter unit tests
      // that drive `parseMenuTsForApp` without a manifest store)
      // observe the `'missing'` default, matching the contract
      // that a row with no manifest attached has no manifest at
      // all.
      manifestState: 'missing',
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
 * Tri-plus-anomaly result returned by an {@link AppManifestLookup}.
 *
 *   - `'present'`   : the manifest read succeeded.
 *   - `'unreadable'`: the manifest file is on disk but parse /
 *                     schema validation failed (partial-residue
 *                     recovery state).
 *   - `'missing'`   : the manifest file is entirely absent
 *                     (legacy / hand-edited row).
 *   - `'anomalous'` : the canonical `app/<appId>/` directory
 *                     fails the realpath boundary check
 *                     (symlink escape or similar) -- the wire
 *                     row should suppress every destructive
 *                     action because nothing about the row can
 *                     be trusted.
 *
 * The result is structurally discriminated so the renderer can
 * tell "no manifest at all" (Remove app safe) from
 * "manifest unreadable" (recovery state, Remove unsafe) without
 * conflating both on `source === null`.
 *
 * @stable v0.2.1
 */
export type AppManifestLookupResult =
  | { state: 'present'; manifest: AppManifest }
  | { state: 'unreadable' }
  | { state: 'missing' }
  | { state: 'anomalous' }

/**
 * Lookup used by `readUserMenuEntries` to attach the
 * `AppManifest`-sourced UI fields (`source` / `displayName` /
 * `menuOrder` / `userMenuLabel`) to each entry. Returns the
 * tri-plus-anomaly {@link AppManifestLookupResult} so callers
 * can drive the wire `manifestState` discriminator without a
 * second filesystem probe.
 *
 * Wired by `app-routes.ts`'s `createAppRouter`, which has
 * `fs` + `projectRoot` available for `readAppManifest` and the
 * realpath boundary helper.
 *
 * @stable v0.2.1
 */
export type AppManifestLookup = (
  appId: string,
) => AppManifestLookupResult

/**
 * Optional lookup used by `readUserMenuEntries` to recover the
 * persisted source badge for **partial-residue** rows — apps whose
 * `AppManifest` is unreadable (file exists on disk but parse /
 * schema validation failed) while their
 * `recipes-installed/<appId>/manifest.json` (`RecipeManifest`) is
 * still intact. Returns the matching `RecipeManifest` or `null`.
 *
 * The caller is responsible for **only** returning a non-null
 * value when the AppManifest file is physically present but
 * unreadable — passing a `RecipeManifest` for a row whose
 * AppManifest is genuinely absent would let a hand-edited
 * `app/menu.ts` row inherit a recipe-derived badge from a stale
 * manifest that has no real ownership claim (the
 * "missing vs unreadable conflation" guard). The reference
 * implementation in `app-routes.ts createAppRouter` uses
 * `fs.existsSync(getAppManifestPath(...))` to discriminate the two
 * states.
 *
 * Scoped to the bundled-enable lifecycle today: the persisted
 * `RecipeManifest.source` is a 4-value enum
 * (`'sample' | 'bundled' | 'import' | 'url'`), so the renderer can
 * still surface a meaningful badge during a recovery state even
 * when the AppManifest read fails (in which case
 * `deriveSourceBadge` would otherwise return `null` and the
 * badge would silently disappear from the Apps screen).
 *
 * `app-directory-extension.md` v1.6 §6.7 note 4 names the scanner
 * (`RecipeManifest` evidence) as the source-classification SSOT;
 * the full scanner pipeline that also derives `import` / `url`
 * without consulting `AppManifest.source` is deferred to a
 * follow-up. `'self-made'` requires the AppManifest because the
 * scanner evidence for `user-creation` lives there exclusively
 * and there is no `RecipeManifest` to fall back to.
 *
 * @stable v0.2.1
 */
export type RecipeManifestLookup = (
  appId: string,
) => RecipeManifest | null

/**
 * Convert an `AppManifest.source` discriminator into the UI badge
 * value used by the v0.2.1 Apps screen. Five-way derivation: four
 * persisted `recipeSource` values + the scanner-derived `'self-made'`
 * literal for `user-creation` apps (not part of the persisted enum).
 *
 * @see docs/specs/app-directory-extension.md v1.6 §6.7
 * @stable v0.2.1
 */
export function deriveSourceBadge(
  manifest: AppManifest,
): MenuEntrySourceBadge {
  if (manifest.source.type === 'user-creation') {
    return 'self-made'
  }
  return manifest.source.recipeSource
}

/**
 * Compute the menu-order snapshot string for an array of wire
 * entries. Mirrors `apps-routes.ts computeMenuOrderSnapshot`'s
 * algorithm (`sha256(sorted "<appId>:<menuOrder>" tuples).slice(0, 16)`)
 * so the value the renderer seeds onto `snapshotVersionRef` matches
 * the snapshot the `PUT /api/apps/menu-order` handler recomputes at
 * write time — without that match the very first reorder of a fresh
 * page load skips the `MenuOrderSnapshotDrift` (HTTP 409) gate, and
 * two clients can silently overwrite each other's reorders
 * (`app-directory-extension.md` v1.6 §6.8.3 / `http-api-contract.md`
 * v1.7.1 §6.3.9.A BS-L6).
 *
 * Eligible-only: only rows with a readable AppManifest
 * (`displayName !== null` on the wire) participate in the
 * closed-world batch (§6.8.1 eligible-set definition), so the
 * snapshot is restricted to those rows. Partial-residue rows whose
 * `source` was recovered via `RecipeManifestLookup` are still
 * ineligible for reorder and are excluded here.
 *
 * @stable v0.2.1
 */
export function computeMenuOrderSnapshotFromEntries(
  entries: MenuEntryWithPage[],
): string {
  const sorted = entries
    .filter((entry) => entry.displayName !== null)
    .map((entry) => `${entry.id}:${entry.menuOrder ?? ''}`)
    .sort()
  return createHash('sha256')
    .update(sorted.join('\n'))
    .digest('hex')
    .slice(0, 16)
}

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
 *
 * When `manifestLookup` is supplied (v0.2.1 API path), each entry's
 * `source` / `displayName` / `menuOrder` / `userMenuLabel` fields are
 * populated from the matching `AppManifest`. Entries without a
 * matching manifest keep the fields at `null`; the renderer treats
 * `null` as "fall back to menu.ts label / no badge".
 *
 * When `recipeManifestLookup` is also supplied (v0.2.1 partial-
 * residue fallback for the source badge), an entry whose
 * `AppManifest` is unreadable falls through to the
 * `RecipeManifest.source` (`'sample' | 'bundled' | 'import' | 'url'`)
 * so the Apps screen surfaces the recovery state instead of hiding
 * the badge. See {@link RecipeManifestLookup} JSDoc for the spec
 * basis (`app-directory-extension.md` v1.6 §6.7 note 4).
 *
 * When `kovitoboardRoot` is supplied (v0.2.1 BL-2026-206), the base
 * label of recipe-install-derived apps (`source.type === 'recipe'`)
 * is resolved locale-aware from the source-tree recipe.yaml
 * (`app-directory-extension.md` v1.7.1 §6.8.2.1): the
 * `i18n.<locale>.menu[appId].label` override wins, else the top-level
 * `menu[appId].label`. `locale` selects the override map and defaults
 * to the OSS fallback `'en'`. The `NavMenu` / renderer / snapshot are
 * unchanged — the wire `label` field simply carries the
 * locale-resolved base label. Callers that omit `kovitoboardRoot`
 * (unit tests) keep the pre-v0.2.1 menu.ts-derived base label.
 */
export function readUserMenuEntries(
  fs: FileAccessLayer,
  trustLookup?: TrustLevelLookup,
  manifestLookup?: AppManifestLookup,
  recipeManifestLookup?: RecipeManifestLookup,
  locale: 'ja' | 'en' = 'en',
  kovitoboardRoot?: string,
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

  // Per-call cache for source-tree recipe parses so a recipe.yaml that
  // exposes multiple apps is read/parsed at most once per request
  // (keyed by recipeId; `null` records an unresolved attempt).
  const recipeParseCache = new Map<string, ParsedRecipe | null>()

  // Resolve each `page` to an absolute path on disk. Tries `.tsx`
  // first (the recipe convention), then `.ts`. Leaves the field
  // `null` if neither exists; the renderer surfaces a clear error
  // in that case rather than silently dropping the menu entry.
  for (const entry of entries) {
    // Reject menu rows whose `page` path resolves outside the
    // canonical `app/` directory before letting `join(appDir, ...)`
    // walk a `../` segment. The parser regex (`import('./<page>')`)
    // already strips the leading `./`, but `<page>` itself may
    // contain `..` segments, an absolute path, or Windows
    // separators — any of those would let a hand-edited menu row
    // address a file outside `app/` and the renderer would
    // dynamic-import it via Vite's `/@fs/` URL scheme. The
    // canonical-app-id check at line 181 below only governs
    // trust-badge attribution; the file-resolution gap is what is
    // closed here.
    // Layer 1 — lexical containment under `app/`. Refuses
    // parent-directory escapes, absolute paths, drive-qualified
    // shapes, and Windows separators before we touch the
    // filesystem.
    if (!isWithinAppDir(entry.page, appDir)) {
      serverLogger.warn(
        { id: entry.id, page: entry.page },
        '[menu-extractor] Skipping menu entry whose page path escapes app/',
      )
      if (trustLookup) entry.trustLevel = null
      continue
    }
    // Layer 2 — app-id binding. `app-directory-extension.md` binds
    // menu `id`, the `app/<appId>/` subtree, and the
    // `window.kb.call` bridge to the same `appId`. Loading a
    // sibling app's pages on this route would inject the wrong
    // app's runtime capability context (recipe-scoped bridge),
    // so we refuse cross-app drift outright instead of merely
    // stripping the trust badge downstream.
    if (!isCanonicalAppIdPath(entry.page, entry.id)) {
      serverLogger.warn(
        { id: entry.id, page: entry.page },
        '[menu-extractor] Skipping menu entry whose page path does not live under app/<id>/',
      )
      if (trustLookup) entry.trustLevel = null
      continue
    }
    const tsxPath = join(appDir, `${entry.page}.tsx`)
    const tsPath = join(appDir, `${entry.page}.ts`)
    const candidate = fs.existsSync(tsxPath)
      ? tsxPath
      : fs.existsSync(tsPath)
        ? tsPath
        : null
    if (candidate !== null) {
      // Layer 3 — symlink defence, split into two complementary
      // checks so we do not falsely reject legitimate paths on
      // case-insensitive or normalization-changing filesystems
      // (macOS APFS, NTFS) where `realpathSync(candidate)` can
      // legitimately differ from `candidate` in casing or NFD/NFC
      // even when no symlink is involved:
      //
      //   3a. `lstatSync(candidate).isSymbolicLink` detects a
      //       file-level symlink at the candidate itself. This
      //       catches `<id>/Index.tsx → /elsewhere/...`.
      //
      //   3b. `realpathSync(candidate)` must canonicalize to a
      //       path inside the canonical `<id>/` directory, which
      //       must in turn live under the canonical `app/`. This
      //       catches intermediate-directory symlinks
      //       (`<id> → /elsewhere/...`) and any other parent-
      //       chain redirection. Containment is verified by
      //       prefix, not by string equality, so cased or
      //       NFD-normalized differences on case-insensitive FS
      //       no longer cause false rejects.
      //
      // Logs carry only the user-supplied `page` and a stable
      // reason code; absolute canonical paths are never emitted
      // because they would leak host filesystem layout for the
      // exact attack shapes this guard is defending against.
      const appIdDir = join(appDir, entry.id)
      try {
        if (fs.lstatSync(candidate).isSymbolicLink) {
          serverLogger.warn(
            { id: entry.id, page: entry.page, reason: 'symlink-redirect' },
            '[menu-extractor] Skipping menu entry whose page file is a symlink',
          )
          if (trustLookup) entry.trustLevel = null
          continue
        }
        const realAppDir = fs.realpathSync(appDir)
        const realAppIdDir = fs.realpathSync(appIdDir)
        const realCandidate = fs.realpathSync(candidate)
        const appRootMarker = realAppDir.endsWith(sep)
          ? realAppDir
          : realAppDir + sep
        if (
          realAppIdDir !== realAppDir &&
          !realAppIdDir.startsWith(appRootMarker)
        ) {
          serverLogger.warn(
            { id: entry.id, page: entry.page, reason: 'app-id-dir-escape' },
            '[menu-extractor] Skipping menu entry whose app/<id>/ directory escapes app/',
          )
          if (trustLookup) entry.trustLevel = null
          continue
        }
        const idRootMarker = realAppIdDir.endsWith(sep)
          ? realAppIdDir
          : realAppIdDir + sep
        if (
          realCandidate !== realAppIdDir &&
          !realCandidate.startsWith(idRootMarker)
        ) {
          serverLogger.warn(
            { id: entry.id, page: entry.page, reason: 'app-id-escape' },
            '[menu-extractor] Skipping menu entry whose canonical path escapes app/<id>/',
          )
          if (trustLookup) entry.trustLevel = null
          continue
        }
        // Persist the canonical path. By this point we have
        // verified (a) the candidate is not itself a symlink and
        // (b) its canonical form lives under the canonical
        // `app/<id>/`. The residual race — an attacker that
        // converts `realCandidate` into a symlink between this
        // assignment and the renderer's later `/@fs/` import —
        // requires a renderer-side re-canonicalization to close;
        // that is tracked as a follow-up outside this PR.
        entry.pageAbsolutePath = realCandidate
      } catch {
        serverLogger.warn(
          { id: entry.id, page: entry.page, reason: 'realpath-failure' },
          '[menu-extractor] Skipping menu entry whose path could not be canonicalized',
        )
        if (trustLookup) entry.trustLevel = null
        continue
      }
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
    if (manifestLookup) {
      // Same canonical-app-id gate as the trust attachment above:
      // a hand-edited row that points at a sibling app's directory
      // must not inherit that sibling's badge / displayName. We
      // leave the AppManifest-derived fields at `null` for the
      // off-canonical case, so the renderer falls back to the bare
      // `menu.ts` label and renders no source badge.
      if (isCanonicalAppIdPath(entry.page, entry.id)) {
        const lookup = manifestLookup(entry.id)
        entry.manifestState = lookup.state
        if (lookup.state === 'present') {
          const manifest = lookup.manifest
          entry.source = deriveSourceBadge(manifest)
          entry.displayName = manifest.displayName
          entry.menuOrder = manifest.menuOrder ?? null
          entry.userMenuLabel = manifest.userMenuLabel ?? null
          // Recipe-derived apps carry the recipe lineage id in
          // `source.recipeId`; self-made apps (`user-creation`)
          // have no recipe lineage and stay at `null`. The Apps
          // tab uses this to route bundled / sample apps through
          // the non-destructive disable endpoint instead of the
          // remove-app flow.
          if (manifest.source.type === 'recipe') {
            entry.recipeId = manifest.source.recipeId
            // Locale-aware base label resolution
            // (app-directory-extension.md v1.7.1 §6.8.2.1). Only when
            // there is no `userMenuLabel` override (which wins above
            // the base label) and a source-tree root is supplied. The
            // resolved label replaces the menu.ts-derived base label on
            // the wire; `userMenuLabel` is sent separately and layered
            // on top by the renderer, so this stays below it.
            if (entry.userMenuLabel == null && kovitoboardRoot !== undefined) {
              const localeLabel = resolveRecipeLocaleBaseLabel(
                fs,
                kovitoboardRoot,
                manifest.source.recipeId,
                entry.id,
                locale,
                recipeParseCache,
              )
              if (localeLabel !== null) entry.label = localeLabel
            }
          }
        } else if (
          lookup.state === 'unreadable' &&
          recipeManifestLookup
        ) {
          // Partial-residue fallback: the AppManifest read failed
          // (missing / parse error) but the bundled-enable
          // `RecipeManifest` is still on disk. Recover the 4-value
          // persisted `source` so the Apps screen keeps showing the
          // badge during the recovery window — the menu-metadata
          // fields (`displayName` / `menuOrder` / `userMenuLabel`)
          // intentionally stay `null` because the renderer's
          // `isMenuMetadataEligible` predicate keys off
          // `displayName !== null` to gate reorder / rename
          // (`app-directory-extension.md` v1.6 §6.8.1 / §6.8.3
          // eligible-set definition).
          // `manifestState` is already `'unreadable'` from the
          // lookup result -- this branch only enriches the wire
          // with the recovered source classification + recipe
          // lineage so the Apps tab can keep Disable wired
          // through the non-destructive endpoint during the
          // partial-residue recovery window.
          const recipeManifest = recipeManifestLookup(entry.id)
          if (recipeManifest !== null) {
            if (recipeManifest.source) {
              entry.source = recipeManifest.source
            }
            entry.recipeId = recipeManifest.recipeId
          }
        }
      }
    }
  }

  // Provisional `menuOrder` assignment is NOT performed here so
  // the persisted-only `menuOrder` values can be hashed into the
  // wire snapshot (`X-Apps-Menu-Snapshot`) before any synthetic
  // values are injected. Without that ordering, the GET-side
  // snapshot would contain provisional indices while the PUT-side
  // `apps-routes.ts computeMenuOrderSnapshot` recomputes from the
  // persisted manifests (which still carry `menuOrder === null`
  // for unassigned rows) -- the first reorder would then fail
  // with HTTP 409 `MenuOrderSnapshotDrift` even when no
  // concurrent writer existed. The provisional injection has
  // been moved to {@link assignProvisionalMenuOrder} which the
  // caller runs *after* snapshot computation; see
  // `app-routes.ts` for the call site.
  return entries
}

/**
 * Resolve the locale-aware base label for a recipe-install-derived
 * app from its source-tree recipe.yaml
 * (`app-directory-extension.md` v1.7.1 §6.8.2.1, read-source pin
 * §6.8.2).
 *
 * Read source = `<kovitoboardRoot>/recipes/<recipeId>/recipe.yaml`
 * (the OSS source tree; install persists only `manifest.json`, never
 * the recipe.yaml). `recipeId` comes from `AppManifest.source.recipeId`.
 *
 * Returns (3 exclusive cases, §6.8.2.1):
 *   - case (1): the `i18n.<locale>.menu[appId].label` override when
 *     present (`id === appId` exists ∧ override non-empty);
 *   - case (2): the top-level `menu[appId].label` (locale-independent)
 *     when the entry exists but the locale override is absent;
 *   - case (3): `null` when the recipe.yaml is absent / unreadable /
 *     has no `menu` entry whose `id === appId`, so the caller falls
 *     back to the next precedence stage (menu.ts label → appId).
 *
 * The parser enforces `menu[].id` uniqueness, so a matching entry is
 * unique when it exists.
 */
function resolveRecipeLocaleBaseLabel(
  fs: FileAccessLayer,
  kovitoboardRoot: string,
  recipeId: string,
  appId: string,
  locale: 'ja' | 'en',
  cache: Map<string, ParsedRecipe | null>,
): string | null {
  // Memoize parsed recipes within a single `readUserMenuEntries` call
  // so a multi-app recipe.yaml is read and parsed at most once per
  // `/api/app/menu-entries` request (`undefined` = not yet attempted,
  // `null` = attempted and unresolved).
  let parsed = cache.get(recipeId)
  if (parsed === undefined) {
    parsed = loadSourceTreeRecipe(fs, kovitoboardRoot, recipeId, appId)
    cache.set(recipeId, parsed)
  }
  if (parsed === null) return null
  const menuEntry = parsed.menu.find((m) => m.id === appId)
  if (!menuEntry) return null // case (3): (a)=No
  const override = parsed.metadata.i18n?.[locale]?.menu?.[appId]?.label
  if (override) return override // case (1): locale override present
  return menuEntry.label // case (2): top-level base label (locale-independent)
}

/**
 * Read + parse the source-tree recipe for `recipeId`, or `null` when it
 * is absent / out of bounds / unparseable. Split out from
 * {@link resolveRecipeLocaleBaseLabel} so the result can be memoized.
 */
function loadSourceTreeRecipe(
  fs: FileAccessLayer,
  kovitoboardRoot: string,
  recipeId: string,
  appId: string,
): ParsedRecipe | null {
  // `recipeId` originates from the on-disk `AppManifest` and is
  // interpolated into a filesystem path. The recipe-id slug grammar
  // permits `.` and `/` (namespaced ids), so a tampered manifest could
  // carry `../…`; resolve and require lexical containment under
  // `<kovitoboardRoot>/recipes/` before touching the filesystem.
  const recipesRoot = resolve(join(kovitoboardRoot, 'recipes'))
  const recipeDir = resolve(join(recipesRoot, recipeId))
  const recipesRootMarker = recipesRoot.endsWith(sep) ? recipesRoot : recipesRoot + sep
  if (recipeDir !== recipesRoot && !recipeDir.startsWith(recipesRootMarker)) {
    serverLogger.warn(
      { recipeId, appId, reason: 'recipe-id-path-escape' },
      '[menu-extractor] Recipe id escapes the recipes/ root; skipping locale base-label resolution',
    )
    return null
  }
  // Absent source-tree recipe.yaml is the normal case (3) for
  // import/url apps that have no live install in v0.2.x; stay silent.
  const recipeYamlPath = join(recipeDir, 'recipe.yaml')
  if (!fs.existsSync(recipeYamlPath)) return null
  // Canonical containment: lexical `resolve` blocks `../` in `recipeId`
  // but not a symlinked `recipes/<recipeId>` (or recipe.yaml) that
  // redirects outside the tree. Canonicalize the real recipe.yaml path
  // and require it to stay under the real recipes/ root before reading
  // — mirrors the Layer-3 symlink defence on the app/ page resolution.
  try {
    const realRecipesRoot = fs.realpathSync(recipesRoot)
    const realRecipeYaml = fs.realpathSync(recipeYamlPath)
    const realRootMarker = realRecipesRoot.endsWith(sep)
      ? realRecipesRoot
      : realRecipesRoot + sep
    if (!realRecipeYaml.startsWith(realRootMarker)) {
      serverLogger.warn(
        { recipeId, appId, reason: 'recipe-yaml-symlink-escape' },
        '[menu-extractor] Recipe path canonicalizes outside recipes/; skipping locale base-label resolution',
      )
      return null
    }
  } catch (err) {
    serverLogger.warn(
      { recipeId, appId, err, reason: 'recipe-yaml-realpath-failure' },
      '[menu-extractor] Could not canonicalize source-tree recipe path; falling back',
    )
    return null
  }
  try {
    // `parseRecipe` takes the recipe *directory* and reads recipe.yaml
    // itself (reusing the shared parser SSOT, §6.8.2.1) — do not pass
    // the file contents.
    //
    // Residual TOCTOU (accepted): the containment check above
    // canonicalizes by path, then `parseRecipe` re-opens recipe.yaml by
    // pathname, so an attacker who can win a race against the
    // canonical check could swap in a symlink between the two. This is
    // the same accepted residual documented for the app/ page
    // resolution above (an O_NOFOLLOW / fd-based read would be needed
    // to close it, and the shared parser must not be forked); it
    // requires write access to the read-only OSS install `recipes/`
    // tree, where direct file replacement is already possible. Tracked
    // as the same follow-up as the app/ page residual.
    return parseRecipe(recipeDir, fs)
  } catch (err) {
    serverLogger.warn(
      { recipeId, appId, err },
      '[menu-extractor] Failed to parse source-tree recipe.yaml for base label; falling back',
    )
    return null
  }
}

/**
 * Apply the spec's provisional `menuOrder` assignment to wire
 * entries in-place, per `app-directory-extension.md` v1.6 §6.8.1
 * step 2. The scanner assigns a provisional order to every
 * eligible app whose `AppManifest.menuOrder` is unset -- the
 * `app/menu.ts` array position for entries that appear there.
 * Spec step 3 keeps the assignment transient (the on-disk
 * manifest is not rewritten); only the wire response carries
 * the value, and a user's first `PUT /api/apps/menu-order`
 * persists the chosen order.
 *
 * Splitting this from `readUserMenuEntries` lets callers
 * compute the wire snapshot from the persisted-only state
 * before the synthetic indices land -- without that ordering,
 * GET snapshot and PUT snapshot drift in mixed v0.2.0 /
 * v0.2.1 projects.
 *
 * Eligibility mirrors §6.8.1: `displayName !== null` (the
 * AppManifest is readable). Partial-residue rows recovered via
 * `RecipeManifestLookup` keep `displayName === null` and stay
 * outside the closed-world batch -- their `menuOrder` is not
 * populated here either.
 *
 * @stable v0.2.1
 */
export function assignProvisionalMenuOrder(
  entries: MenuEntryWithPage[],
): void {
  let nextProvisionalIndex = 0
  for (const entry of entries) {
    if (entry.displayName === null) continue
    if (entry.menuOrder !== null) {
      // Already persisted — keep the on-disk value and step over
      // it so two provisional assignments do not later occupy the
      // same numeric slot.
      nextProvisionalIndex = Math.max(
        nextProvisionalIndex,
        entry.menuOrder + 1,
      )
      continue
    }
    entry.menuOrder = nextProvisionalIndex
    nextProvisionalIndex += 1
  }
}

/**
 * Returns true when `page` (as parsed out of `import('./<page>')`)
 * resolves to a location strictly inside `app/` once joined with
 * `appDir`. This is **Layer 1** of the three-layer path-containment
 * check in `readUserMenuEntries` — it refuses parent-directory
 * escapes, absolute paths, Windows separators, and drive-qualified
 * paths before we touch the filesystem.
 *
 * The check is intentionally coarser than `isCanonicalAppIdPath`:
 * it does NOT require the path to live under `app/<appId>/`. The
 * sibling-drift refusal (cross-app capability mixup per
 * `app-directory-extension.md`) is enforced by `isCanonicalAppIdPath`
 * one layer further in. Splitting the predicates keeps each one's
 * invariant crisp and lets the trust-badge layer evolve
 * independently of the file-resolution gate.
 *
 * `appDir`, when supplied, enables a defence-in-depth post-resolve
 * check: the candidate path is rebuilt via `resolve(appDir, page)`
 * and must end up under `appDir`. This catches Win32-only escapes
 * such as `C:/../../bar` whose drive-qualified prefix bypasses the
 * lexical traversal checks because `normalize` collapses them away
 * from the project tree on Windows hosts.
 *
 * Exported so unit tests can drive the predicate directly.
 */
export function isWithinAppDir(page: string, appDir?: string): boolean {
  // Cheap structural rejections first: forward slash is the only
  // separator the recipe layout uses, so any absolute path or
  // backslash is already non-canonical (and avoids quirks on
  // Windows hosts).
  if (page.length === 0) return false
  if (page.startsWith('/') || page.startsWith('\\')) return false
  if (page.includes('\\')) return false

  // Reject Win32 drive-qualified shapes (`C:foo`, `C:/foo`,
  // `D:bar`). On Windows hosts `path.normalize` quietly strips
  // the drive prefix and emits a relative tail (`C:/../../bar` →
  // `bar` on Win32), so the POSIX-style `..` checks below would
  // otherwise let drive-qualified inputs through.
  if (/^[A-Za-z]:/.test(page)) return false

  // `normalize` collapses `./` and `../` segments. After this:
  //   - `pages/Foo`              → `pages/Foo`           (kept)
  //   - `./pages/Foo`            → `pages/Foo`           (kept)
  //   - `doc-viewer/../evil-app` → `evil-app`            (kept; the
  //       trust-badge attribution catches sibling drift separately)
  //   - `../etc/passwd`          → `../etc/passwd`       (rejected)
  //   - `pages/../../etc/passwd` → `../etc/passwd`       (rejected)
  //   - `..`                     → `..`                  (rejected)
  const normalized = normalize(page)
  if (
    normalized === '..' ||
    normalized.startsWith('..') ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    return false
  }

  // Defence in depth: rebuild the candidate path against the
  // concrete `appDir` and verify lexical containment. This catches
  // any platform-specific quirk in `normalize` we did not anticipate.
  // The check is platform-aware via `resolve` + `sep`.
  if (appDir !== undefined) {
    const candidate = resolve(appDir, page)
    const rootMarker = appDir.endsWith(sep) ? appDir : appDir + sep
    if (candidate !== appDir && !candidate.startsWith(rootMarker)) {
      return false
    }
  }
  return true
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
