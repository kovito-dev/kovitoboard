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
 * A single user-defined menu entry from app/menu.ts.
 * Extends AppMenuEntryMeta with the React component loader.
 */
export interface AppMenuEntry extends AppMenuEntryMeta {
  /** Dynamic import function returning the page component (must use export default) */
  component: () => Promise<{ default: React.ComponentType }>
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
   * manifest exists. Drives the row title on the Apps screen;
   * fallback chain is `userMenuLabel ?? displayName ?? label ?? appId`.
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
}

/** The shape exported by app/menu.ts */
export interface AppMenuModule {
  menuEntries: AppMenuEntry[]
}
