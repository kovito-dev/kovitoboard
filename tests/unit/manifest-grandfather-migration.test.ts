/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the grandfather migration introduced in v0.2.0
 * (recipe-system.md v1.5 §6.10.4): legacy manifests written before
 * the `captureRequires` / `approvedCaptures` / `trustLevel` fields
 * existed must be coerced into the new shape on load so the capture
 * endpoint can apply the opt-in gate uniformly.
 *
 * v1.5 changes: `captureRequires` field also migrates to `[]`, so
 * grandfather installs land on step 3 (`CaptureNotDeclared`) of the
 * capture-route flow rather than step 4 (`CaptureNotApproved`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyGrandfatherMigration,
  RecipeManifestStore,
} from '../../src/server/recipeManifestStore'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger } from '../../src/server/logger'

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
  it('fills in captureRequires / approvedCaptures / trustLevel on legacy manifests', () => {
    const { manifest, migrated } = applyGrandfatherMigration(legacyManifest())
    expect(migrated).toBe(true)
    expect(manifest.captureRequires).toEqual([])
    expect(manifest.approvedCaptures).toEqual([])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('passes through a fully-current manifest unchanged', () => {
    const current = {
      ...legacyManifest(),
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
      trustLevel: 'unknown',
    }
    const { manifest, migrated } = applyGrandfatherMigration(current)
    expect(migrated).toBe(false)
    expect(manifest.captureRequires).toEqual(['a11y'])
    expect(manifest.approvedCaptures).toEqual(['a11y'])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('treats a partial migration (only approvedCaptures present) as needing migration', () => {
    const partial = {
      ...legacyManifest(),
      approvedCaptures: ['a11y'],
    }
    const { manifest, migrated } = applyGrandfatherMigration(partial)
    expect(migrated).toBe(true)
    // approvedCaptures is retained verbatim — the load-time I-CR1
    // check (recipeManifestStore.loadAll) drops manifests where the
    // approved set is not a subset of the declared set, so this
    // entry would be rejected by the loader even though the
    // migration helper passes it through.
    expect(manifest.captureRequires).toEqual([])
    expect(manifest.approvedCaptures).toEqual(['a11y'])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('treats a partial migration (only captureRequires present) as needing migration', () => {
    const partial = {
      ...legacyManifest(),
      captureRequires: ['a11y'],
    }
    const { manifest, migrated } = applyGrandfatherMigration(partial)
    expect(migrated).toBe(true)
    expect(manifest.captureRequires).toEqual(['a11y'])
    expect(manifest.approvedCaptures).toEqual([])
    expect(manifest.trustLevel).toBe('unknown')
  })

  it('treats a partial migration (trust present, capture fields absent) as needing migration', () => {
    const partial = {
      ...legacyManifest(),
      trustLevel: 'unknown',
    }
    const { manifest, migrated } = applyGrandfatherMigration(partial)
    expect(migrated).toBe(true)
    expect(manifest.captureRequires).toEqual([])
    expect(manifest.approvedCaptures).toEqual([])
    expect(manifest.trustLevel).toBe('unknown')
  })
})

describe('RecipeManifestStore.loadAll — KB-trusted ingress refusal (defence-in-depth)', () => {
  let tmp: string

  beforeAll(async () => {
    // `recipeLogger.warn` reaches the lazy proxy on the rejection
    // path; without the root logger init the proxy throws on access.
    const root = mkdtempSync(join(tmpdir(), 'kb-manifest-kbtrust-logroot-'))
    mkdirSync(join(root, '.kovitoboard', 'logs'), { recursive: true })
    await initLogger(root, null)
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-manifest-kbtrust-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeManifest(appId: string, body: Record<string, unknown>): void {
    // The store keys off `<kovitoboardDir>/recipes-installed/<appId>/manifest.json`,
    // so we materialise the same shape on disk for the test.
    const dir = join(tmp, 'recipes-installed', appId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(body, null, 2), 'utf-8')
  }

  it('skips a manifest that declares trustLevel "KB-trusted" (recipe ingress fails closed)', () => {
    // `KB-trusted` passes the enum check (it lives in the broader
    // trust-axis union) but must never accompany a recipe manifest.
    // The validator marks this as malformed and `loadAll` drops the
    // manifest from the cache — the dispatcher then refuses the
    // recipe entirely instead of inflating the badge.
    writeManifest('forged-app', {
      appId: 'forged-app',
      recipeId: 'forged-recipe',
      recipeVersion: '1.0.0',
      hash: 'deadbeef',
      installedAt: '2026-01-01T00:00:00.000Z',
      approvedScopes: ['own-data'],
      api: { scopes: ['own-data'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'KB-trusted',
    })
    const store = new RecipeManifestStore(tmp, new DirectFsLayer())
    store.loadAll()
    expect(store.get('forged-app')).toBeNull()
  })

  it('accepts a manifest that declares trustLevel "unknown" (positive control)', () => {
    writeManifest('clean-app', {
      appId: 'clean-app',
      recipeId: 'clean-recipe',
      recipeVersion: '1.0.0',
      hash: 'deadbeef',
      installedAt: '2026-01-01T00:00:00.000Z',
      approvedScopes: ['own-data'],
      api: { scopes: ['own-data'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
    })
    const store = new RecipeManifestStore(tmp, new DirectFsLayer())
    store.loadAll()
    const m = store.get('clean-app')
    expect(m).not.toBeNull()
    expect(m!.trustLevel).toBe('unknown')
  })

  it('skips a manifest that declares trustLevel "code-trusted" in v0.2.x (no verification path)', () => {
    // v0.2.x has no signature / sideload flow that can mint a
    // non-`'unknown'` recipe manifest, so a persisted `code-trusted`
    // record can only have come from a hand-edit, a corruption, or
    // a v0.3.0 manifest restored into a v0.2.x runtime — none of
    // which the renderer can verify. Fail closed.
    writeManifest('inflated-app', {
      appId: 'inflated-app',
      recipeId: 'inflated-recipe',
      recipeVersion: '1.0.0',
      hash: 'deadbeef',
      installedAt: '2026-01-01T00:00:00.000Z',
      approvedScopes: ['own-data'],
      api: { scopes: ['own-data'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted',
    })
    const store = new RecipeManifestStore(tmp, new DirectFsLayer())
    store.loadAll()
    expect(store.get('inflated-app')).toBeNull()
  })

  it('skips a manifest that declares trustLevel "code-trusted (sideloaded)" in v0.2.x', () => {
    writeManifest('side-app', {
      appId: 'side-app',
      recipeId: 'side-recipe',
      recipeVersion: '1.0.0',
      hash: 'deadbeef',
      installedAt: '2026-01-01T00:00:00.000Z',
      approvedScopes: ['own-data'],
      api: { scopes: ['own-data'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (sideloaded)',
    })
    const store = new RecipeManifestStore(tmp, new DirectFsLayer())
    store.loadAll()
    expect(store.get('side-app')).toBeNull()
  })
})
