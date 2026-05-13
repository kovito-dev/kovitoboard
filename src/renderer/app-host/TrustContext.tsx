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
 * Surface contract (convenience, **not** a forgery mitigation):
 *   - The raw React `Context` object is kept module-private as a
 *     code-organization choice; only `<TrustProvider>` and
 *     `useTrustLevel()` are exported.
 *   - **This is not a security boundary.** Recipe code shares the
 *     same JS realm — anything exported from this module (including
 *     `TrustProvider` itself) can be imported by recipe code, and a
 *     hostile recipe could simply mount its own `<TrustProvider
 *     value="code-trusted">` around a KB-managed widget that reads
 *     `useTrustLevel()`. Same-realm recipe code can also reach into
 *     React internals to forge the value even without importing
 *     this file (v0.2.x same-realm honest claim,
 *     `recipe-system.md` v1.7.3 §6.10.6.11).
 *   - **Therefore: security-critical KB widgets MUST take
 *     `trustLevel` via explicit prop, not via this context.** The
 *     context is for ergonomics in widgets that already render
 *     advisory UI (gray badges, banner text) where forgery has no
 *     authority impact. `TrustMarker` is one such widget — even if
 *     a recipe forges the value, it only changes the visible badge
 *     for that recipe's own subtree, which the recipe already
 *     controls visually anyway.
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
import type { RecipePageTrustLevel } from '../../shared/recipe-types'

/**
 * Module-private React context. Recipe-page subset only —
 * `'KB-trusted'` is excluded at the type level (it never
 * legitimately accompanies a recipe install).
 */
const TrustContext = createContext<RecipePageTrustLevel | null>(null)

interface TrustProviderProps {
  value: RecipePageTrustLevel | null
  children: ReactNode
}

/**
 * Convenience wrapper around the module-private Context Provider.
 * Read the file header before adding new consumers — this is a
 * code-organization helper, not a forgery defence.
 */
export function TrustProvider({ value, children }: TrustProviderProps) {
  return <TrustContext.Provider value={value}>{children}</TrustContext.Provider>
}

/**
 * Read the active recipe's trust level. Returns `null` when used
 * outside a `RecipePageHost` (or inside one where the manifest has
 * not yet been registered) so consumers can render an unobtrusive
 * fallback without conditionally branching at the call site.
 *
 * SECURITY: see the file header — the value is not authenticated.
 * Use an explicit prop for any decision with authority impact.
 */
export function useTrustLevel(): RecipePageTrustLevel | null {
  return useContext(TrustContext)
}
