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
import type { TrustLevelValue } from '../../shared/recipe-types'

/**
 * A single user-defined menu entry from app/menu.ts.
 * Extends AppMenuEntryMeta with the React component loader.
 */
export interface AppMenuEntry extends AppMenuEntryMeta {
  /** Dynamic import function returning the page component (must use export default) */
  component: () => Promise<{ default: React.ComponentType }>
  /**
   * Trust-axis value sourced from the active recipe manifest
   * (`RecipeManifest.trustLevel`) at menu-entry load time. `null`
   * when no manifest has been registered for the entry — the
   * trust-marker UI treats this as the unmanaged-extension case
   * (still gray, hidden until install completes).
   *
   * @see recipe-system.md v1.4 §6.10.3 / §6.10.4
   * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
   * @stable v0.2.0
   */
  trustLevel: TrustLevelValue | null
}

/** The shape exported by app/menu.ts */
export interface AppMenuModule {
  menuEntries: AppMenuEntry[]
}
