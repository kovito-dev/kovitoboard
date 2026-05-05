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

/**
 * A single user-defined menu entry from app/menu.ts.
 * Extends AppMenuEntryMeta with the React component loader.
 */
export interface AppMenuEntry extends AppMenuEntryMeta {
  /** Dynamic import function returning the page component (must use export default) */
  component: () => Promise<{ default: React.ComponentType }>
}

/** The shape exported by app/menu.ts */
export interface AppMenuModule {
  menuEntries: AppMenuEntry[]
}
