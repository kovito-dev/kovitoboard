/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'

import en from '../../src/renderer/i18n/en'
import ja from '../../src/renderer/i18n/ja'

/**
 * Sanity tests for the four i18n keys added by D-4 (recipe install
 * "safety boundary" + "trusted code" disclosure).
 *
 * Rendering of the dialog itself is exercised at the L1 (Playwright)
 * layer; this suite stays logic-level (no jsdom / no React render
 * pipeline) and focuses on guaranteeing that:
 *
 * - both message catalogs declare the new keys (so `t(...)` cannot
 *   silently fall back to the raw key string at runtime);
 * - the values are non-empty strings, so a missed translation does
 *   not leak through as a blank dialog section;
 * - the English and Japanese values differ (a copy/paste regression
 *   that left ja.ts holding the English string would produce a
 *   visible translation hole, which we want to catch in CI rather
 *   than via manual review).
 */

const REQUIRED_KEYS = [
  'recipe.install.warning.safetyBoundary.heading',
  'recipe.install.warning.safetyBoundary.body',
  'recipe.install.warning.trustedCode.heading',
  'recipe.install.warning.trustedCode.body',
] as const

describe('D-4 i18n keys present in both catalogs', () => {
  for (const key of REQUIRED_KEYS) {
    it(`en.ts declares ${key}`, () => {
      expect(en).toHaveProperty(key)
      const value = (en as Record<string, string>)[key]
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    it(`ja.ts declares ${key}`, () => {
      expect(ja).toHaveProperty(key)
      const value = (ja as Record<string, string>)[key]
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    it(`en.ts and ja.ts hold different values for ${key} (translation present)`, () => {
      const enValue = (en as Record<string, string>)[key]
      const jaValue = (ja as Record<string, string>)[key]
      expect(enValue).not.toBe(jaValue)
    })
  }
})
