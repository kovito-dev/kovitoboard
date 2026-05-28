/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Stable API: app/ extension type definitions (renderer-side).
 *
 * These types extend the shared definitions with React-specific fields.
 * Backward-compatible within the same major version.
 *
 * @stable v0.1.0
 * @see src/shared/app-types.ts for React-independent base types
 * @see DEC-005 (Specification-Driven Architecture)
 */

import type { AppMenuEntryMeta } from '../../shared/app-types'
import type { RecipePageTrustLevel } from '../../shared/recipe-types'

/**
 * Authored shape — what a recipe author writes in `app/menu.ts`.
 *
 * Carries only the file-owned fields: identifier metadata + the
 * dynamic component import. The AppManifest-derived enrichment
 * (`trustLevel` / `source` / `displayName` / `menuOrder` /
 * `userMenuLabel`) is **not** present here because those values
 * are produced server-side after a manifest lookup and an author
 * cannot legitimately write them in their `menu.ts`.
 *
 * Use this type when typing the shape of `app/menu.ts` (see
 * {@link AppMenuModule}) and for code paths that only have the
 * raw author entries on hand (the `app-loader` glob fallback,
 * recipe-exporter fixtures, etc.). The enriched
 * {@link AppMenuEntry} is the renderer / wire shape and adds the
 * manifest-derived fields on top.
 *
 * @stable v0.2.1
 */
export interface AuthoredAppMenuEntry extends AppMenuEntryMeta {
  /** Dynamic import function returning the page component (must use export default) */
  component: () => Promise<{ default: React.ComponentType }>
}

/**
 * A single user-defined menu entry, enriched with AppManifest-
 * sourced fields (`trustLevel`, `source`, `displayName`,
 * `menuOrder`, `userMenuLabel`). This is the **renderer / wire
 * shape** the Apps screen consumes; it extends
 * {@link AuthoredAppMenuEntry} and is produced from the wire
 * response by `app-loader.toAppMenuEntry`. Authors writing
 * `app/menu.ts` should not refer to this type — they should use
 * {@link AuthoredAppMenuEntry} (the {@link AppMenuModule}
 * surface).
 */
export interface AppMenuEntry extends AuthoredAppMenuEntry {
  /**
   * Trust-axis value sourced from the active recipe manifest
   * (`RecipeManifest.trustLevel`) at menu-entry load time. Narrowed
   * to {@link RecipePageTrustLevel} so the renderer-side types
   * statically exclude `'KB-trusted'` — that literal is reserved
   * for KB-core surfaces and the wire validation in
   * `app-loader.ts` already coerces stray values to `null`. `null`
   * is the "no manifest registered yet" state (the trust marker
   * hides itself).
   *
   * @see recipe-system.md v1.4 §6.10.3 / §6.10.4
   * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
   * @stable v0.2.0
   */
  trustLevel: RecipePageTrustLevel | null
  /**
   * UI source badge derived server-side from the matching
   * `AppManifest.source`. `null` when no manifest exists (legacy
   * hand-edited `app/menu.ts`). Five values: `'self-made'` (scanner
   * derived) + `'bundled' | 'sample' | 'import' | 'url'` (persisted).
   *
   * Drives the Apps screen row badge. `null` hides the badge.
   *
   * @see docs/specs/app-directory-extension.md v1.6 §6.7
   * @stable v0.2.1
   */
  source:
    | 'self-made'
    | 'bundled'
    | 'sample'
    | 'import'
    | 'url'
    | null
  /**
   * Display name from `AppManifest.displayName`. `null` when no
   * manifest exists. Drives the row title on the Apps screen.
   *
   * Renderer fallback chain (`AppsTab.tsx`):
   *   `userMenuLabel ?? label ?? displayName ?? appId`
   * `label` (menu.ts-derived, refreshed on every scan) precedes
   * `displayName` (AppManifest install snapshot) so recipe upgrades
   * that mutate `app/menu.ts` are reflected in the Apps screen
   * without rewriting the AppManifest. This approximates the
   * `app-directory-extension.md` v1.6 §6.8.2 file-SSOT precedence
   * (`recipe.yaml.menu.label` / `app/menu.ts`) without introducing
   * a new wire field; a server-side resolver that surfaces
   * `recipe.yaml.menu.label` directly is the deferred follow-up.
   *
   * @stable v0.2.1
   */
  displayName: string | null
  /**
   * Persisted menu order from `AppManifest.menuOrder`. Drives the
   * default sort on the Apps screen. `null` when no manifest exists.
   *
   * @stable v0.2.1
   */
  menuOrder: number | null
  /**
   * User override label from `AppManifest.userMenuLabel`. `null`
   * when not set; empty string is invalid on PATCH (400
   * `MenuLabelEmpty`).
   *
   * @stable v0.2.1
   */
  userMenuLabel: string | null
  /**
   * Recipe lineage identifier (`recipe.yaml`'s `recipeId`) for
   * apps installed from a recipe. `null` for self-made apps and
   * for legacy hand-edited entries with no manifest. The Apps
   * tab uses this to route Disable for bundled / sample apps
   * through `POST /api/recipes/sample/:recipeId/disable` so the
   * `app/data/<appId>/` directory is preserved (the destructive
   * remove-app flow would otherwise delete user data — spec
   * grandfather data-preservation invariant).
   *
   * @stable v0.2.1
   */
  recipeId: string | null
  /**
   * Tri-state AppManifest discriminator. Splits the two
   * meanings the `source === null` axis would otherwise
   * conflate:
   *
   *   - `'present'`   : `app/<appId>/manifest.json` exists and
   *                     parsed successfully.
   *   - `'unreadable'`: the manifest file exists on disk but
   *                     parse / schema validation failed --
   *                     the partial-residue recovery state.
   *                     `source` and `recipeId` are recovered
   *                     from the matching `RecipeManifest`.
   *   - `'missing'`   : the manifest file is entirely absent.
   *                     A legacy hand-edited row that never had
   *                     a manifest -- `source` and `recipeId`
   *                     stay `null`.
   *
   * Drives the Apps tab Actions menu split between Disable
   * (recovery state for bundled / sample sources) and Remove
   * app (legacy hand-edited + present self-made / import / url).
   * Conflating the two on `source === null` was the root cause
   * of the destructive-routing risks surfaced in earlier
   * review passes.
   *
   * @stable v0.2.1
   */
  manifestState: 'present' | 'unreadable' | 'missing' | 'anomalous'
}

/**
 * The shape exported by `app/menu.ts`.
 *
 * Recipe authors export this object literally — the `menuEntries`
 * array carries the authored shape ({@link AuthoredAppMenuEntry})
 * only. The enriched fields on {@link AppMenuEntry} are added
 * after the wire layer at `app-loader.toAppMenuEntry`, so requiring
 * them in `app/menu.ts` would force authors to write values that
 * are only known after a manifest lookup — a compile-time
 * regression. The split keeps the wire / runtime enrichment out
 * of the authored surface while letting the renderer keep the
 * field as required on the wire shape.
 */
export interface AppMenuModule {
  menuEntries: AuthoredAppMenuEntry[]
}

/**
 * Predicate: is this entry eligible for menu-metadata operations
 * (`PUT /api/apps/menu-order` closed-world batch +
 * `PATCH /api/apps/:appId/menu-label`)?
 *
 * `app-directory-extension.md` v1.6 §6.8.1 pins eligibility on
 * AppManifest readability — the wire shape exposes that as a
 * non-null `displayName` (every successful AppManifest read
 * populates the field; partial residue / unreadable manifest
 * surface `null`). Ineligible rows must be routed through the
 * source-based disable / removal path (§4.3 L3) rather than
 * through reorder / rename, otherwise the batch will fail with
 * `MenuOrderCoverageMismatch` and PATCH will fail with
 * `AppManifestUnreadable`.
 *
 * @stable v0.2.1
 */
export function isMenuMetadataEligible(entry: AppMenuEntry): boolean {
  return entry.displayName !== null
}
