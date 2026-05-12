/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the grandfather migration introduced in v0.2.0
 * (recipe-system.md v1.4 §6.10.4): legacy manifests written before
 * the `approvedCaptures` / `trustLevel` fields existed must be
 * coerced into the new shape on load so the capture endpoint can
 * apply the opt-in gate uniformly.
 */
import { describe, expect, it } from 'vitest'
import { applyGrandfatherMigration } from '../../src/server/recipeManifestStore'

function legacyManifest(): Record<string, unknown> {
  return {
    appId: 'legacy-app',
    recipeId: 'legacy-recipe',
    recipeVersion: '1.0.0',
    hash: 'deadbeef',
    installedAt: '2026-01-01T00:00:00.000Z',
    approvedScopes: ['own-data'],
    api: { scopes: ['own-data'], calls: [] },
  }
}

describe('applyGrandfatherMigration', () => {
  it('fills in approvedCaptures / trustLevel on legacy manifests', () => {
    const { manifest, migrated } = applyGrandfatherMigration(legacyManifest())
    expect(migrated).toBe(true)
    expect(manifest.approvedCaptures).toEqual([])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('passes through a fully-current manifest unchanged', () => {
    const current = {
      ...legacyManifest(),
      approvedCaptures: ['a11y'],
      trustLevel: 'unknown',
    }
    const { manifest, migrated } = applyGrandfatherMigration(current)
    expect(migrated).toBe(false)
    expect(manifest.approvedCaptures).toEqual(['a11y'])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('treats a partial migration (captures present, trust absent) as needing migration', () => {
    const partial = {
      ...legacyManifest(),
      approvedCaptures: ['a11y'],
    }
    const { manifest, migrated } = applyGrandfatherMigration(partial)
    expect(migrated).toBe(true)
    expect(manifest.approvedCaptures).toEqual(['a11y'])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('treats a partial migration (trust present, captures absent) as needing migration', () => {
    const partial = {
      ...legacyManifest(),
      trustLevel: 'unknown',
    }
    const { manifest, migrated } = applyGrandfatherMigration(partial)
    expect(migrated).toBe(true)
    expect(manifest.approvedCaptures).toEqual([])
    expect(manifest.trustLevel).toBe('unknown')
  })
})
