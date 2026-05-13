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
 * Design notes:
 *   - The host renderer owns the source value; recipe code never
 *     writes to this context. The context is read-only from the
 *     recipe's perspective.
 *   - The default value is `null`, mirroring the "no manifest yet"
 *     answer the menu-entries API returns when a recipe row exists
 *     in `app/menu.ts` but no manifest has been registered. The
 *     trust marker treats `null` as the unmanaged-extension case
 *     and hides itself, matching the behaviour expected by
 *     KB-internal screens that render outside any `RecipePageHost`.
 *   - The context value is intentionally *just the trust level*.
 *     If we later need to propagate richer signals (appId, recipeId,
 *     etc.) we can widen the shape without touching the public
 *     trust-marker API. T-3-3 defence (handoff v1.1 §8.2) is
 *     orthogonal: `RecipePageHost` is the router-level guarantee
 *     that the context is always provided for `/ext/<appId>` routes.
 *
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis vocabulary)
 * @stable v0.2.0
 */

import { createContext, useContext } from 'react'
import type { TrustLevelValue } from '../../shared/recipe-types'

/**
 * Recipe trust-axis value provided to children of `RecipePageHost`.
 *
 * `null` is the legitimate "no managed manifest available" answer
 * (KB core pages, unmanaged `app/menu.ts` rows, unit-test consumers
 * mounted without a host wrapper).
 */
export const TrustContext = createContext<TrustLevelValue | null>(null)

/**
 * Read the active recipe's trust level. Returns `null` when used
 * outside a `RecipePageHost` (or inside one where the manifest has
 * not yet been registered) so consumers can render an unobtrusive
 * fallback without conditionally branching at the call site.
 */
export function useTrustLevel(): TrustLevelValue | null {
  return useContext(TrustContext)
}
