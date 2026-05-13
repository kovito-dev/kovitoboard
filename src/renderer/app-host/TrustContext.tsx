/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * TrustContext — propagates the active recipe's trust-axis value
 * from `RecipePageHost` to children of the recipe page (and any
 * KB-side wrappers — e.g. `TrustMarker`, `PreambleWarning` — that
 * render inside the recipe tree).
 *
 * Public surface contract (module-private context):
 *   - The raw React `Context` object is intentionally **not
 *     exported**. Exporting it would let same-realm recipe code
 *     import the context handle and mount its own
 *     `<TrustContext.Provider value="code-trusted">...</...>`,
 *     forging the value for any KB-managed widget rendered inside
 *     the recipe subtree.
 *   - Callers use `<TrustProvider value={...}>` (host-only — only
 *     `RecipePageHost` legitimately wraps the recipe tree) to set
 *     the value, and `useTrustLevel()` to read it.
 *   - This is **not** a structural defence: recipe code shares the
 *     same JS realm and could re-create a Context with the same
 *     identity via React internals. The closure-only context handle
 *     reduces the everyday attack surface (a recipe author cannot
 *     spoof the value with a single ergonomic `import`) but the
 *     v0.2.x same-realm honest claim
 *     (`recipe-system.md` v1.7.3 §6.10.6.11) still applies. Security
 *     -critical KB widgets MUST receive `trustLevel` via explicit
 *     prop, not via this context.
 *
 *   - The default value is `null`, mirroring the "no manifest yet"
 *     answer the menu-entries API returns when a recipe row exists
 *     in `app/menu.ts` but no manifest has been registered. The
 *     trust marker treats `null` as the unmanaged-extension case
 *     and hides itself, matching the behaviour expected by
 *     KB-internal screens that render outside any `RecipePageHost`.
 *
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis vocabulary)
 * @stable v0.2.0
 */

import { createContext, useContext, type ReactNode } from 'react'
import type { TrustLevelValue } from '../../shared/recipe-types'

/**
 * Module-private React context. Closure-scoped on purpose — see
 * the file header for the rationale (no ergonomic
 * `<TrustContext.Provider>` forging from same-realm recipe code).
 */
const TrustContext = createContext<TrustLevelValue | null>(null)

interface TrustProviderProps {
  value: TrustLevelValue | null
  children: ReactNode
}

/**
 * Host-only Provider wrapper. Only `RecipePageHost` is expected to
 * legitimately render this; the import remains available to recipe
 * JS in v0.2.x (same-realm constraint), so this stays a visibility
 * signal rather than a structural barrier.
 */
export function TrustProvider({ value, children }: TrustProviderProps) {
  return <TrustContext.Provider value={value}>{children}</TrustContext.Provider>
}

/**
 * Read the active recipe's trust level. Returns `null` when used
 * outside a `RecipePageHost` (or inside one where the manifest has
 * not yet been registered) so consumers can render an unobtrusive
 * fallback without conditionally branching at the call site.
 */
export function useTrustLevel(): TrustLevelValue | null {
  return useContext(TrustContext)
}
