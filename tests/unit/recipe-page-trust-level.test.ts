/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the recipe-page trust-level type guard
 * (CodeX review attempt 4 finding: `'KB-trusted'` must not be
 * acceptable as a recipe-page badge).
 *
 * The wire-validation path in
 * `src/renderer/app-loader.ts` uses `isRecipePageTrustLevel` to
 * filter `meta.trustLevel` before it reaches the renderer's
 * `TrustMarker`. A server bug or corrupted manifest that emits
 * `'KB-trusted'` over the wire must be coerced to `null` so the
 * badge auto-hides instead of inflating the recipe install to a
 * first-party signal.
 *
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis vocabulary)
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1
 */
import { describe, expect, it } from 'vitest'
import {
  isRecipePageTrustLevel,
  isTrustLevelValue,
  RECIPE_PAGE_TRUST_LEVELS,
  TRUST_LEVEL_VALUES,
} from '../../src/shared/recipe-types'

describe('isRecipePageTrustLevel — recipe-page wire validation', () => {
  it('accepts the three legitimate recipe-page literals', () => {
    expect(isRecipePageTrustLevel('code-trusted')).toBe(true)
    expect(isRecipePageTrustLevel('code-trusted (sideloaded)')).toBe(true)
    expect(isRecipePageTrustLevel('unknown')).toBe(true)
  })

  it('rejects `KB-trusted` even though the full trust axis includes it', () => {
    expect(isRecipePageTrustLevel('KB-trusted')).toBe(false)
    // Sanity: the full union accepts the same literal so callers can
    // tell `KB-trusted` from genuinely unknown garbage when they need
    // to diagnose the source.
    expect(isTrustLevelValue('KB-trusted')).toBe(true)
  })

  it('rejects every garbage shape (null, undefined, number, foreign string)', () => {
    expect(isRecipePageTrustLevel(null)).toBe(false)
    expect(isRecipePageTrustLevel(undefined)).toBe(false)
    expect(isRecipePageTrustLevel(0)).toBe(false)
    expect(isRecipePageTrustLevel('trusted')).toBe(false)
    expect(isRecipePageTrustLevel('Code-Trusted')).toBe(false)
  })

  it('exposes the three legitimate literals as a readonly tuple SSOT', () => {
    // Defends against a copy-paste that adds `'KB-trusted'` to the
    // recipe-page list. The full trust axis stays a strict superset.
    const recipeSet = new Set<string>(RECIPE_PAGE_TRUST_LEVELS)
    expect(recipeSet.has('KB-trusted')).toBe(false)
    for (const v of RECIPE_PAGE_TRUST_LEVELS) {
      expect((TRUST_LEVEL_VALUES as readonly string[]).includes(v)).toBe(true)
    }
  })
})
