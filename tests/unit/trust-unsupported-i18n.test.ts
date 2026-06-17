/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * i18n key presence for the `multi-question-unsupported` degrade modal
 * (BL-2026-263 Phase A, trust-prompt-relay.md v1.8 §10.7.3 / §9.5-4).
 *
 * The `trust.unsupported.*` keys must exist (and be non-empty) in both the
 * English and Japanese dictionaries so the degrade modal never falls back
 * to a raw key string. (`MessageKey` is derived from `ja`, so a key present
 * in `ja` but missing from `en` already fails typecheck; this test adds an
 * explicit runtime guard and asserts the values are non-empty.)
 */
import { describe, it, expect } from 'vitest'
import en from '../../src/renderer/i18n/en'
import ja from '../../src/renderer/i18n/ja'

const KEYS = [
  'trust.unsupported.title',
  'trust.unsupported.description',
  'trust.unsupported.button.cancel',
  'trust.unsupported.badge',
] as const

describe('trust.unsupported.* i18n keys', () => {
  it('exist and are non-empty in en', () => {
    for (const key of KEYS) {
      const value = (en as Record<string, string>)[key]
      expect(value, `en missing ${key}`).toBeDefined()
      expect(value.length, `en ${key} empty`).toBeGreaterThan(0)
    }
  })

  it('exist and are non-empty in ja', () => {
    for (const key of KEYS) {
      const value = (ja as Record<string, string>)[key]
      expect(value, `ja missing ${key}`).toBeDefined()
      expect(value.length, `ja ${key} empty`).toBeGreaterThan(0)
    }
  })
})
