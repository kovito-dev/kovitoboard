/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.1 `SampleRecipeInfo.enabled` + `source`
 * derivation in `scanSampleRecipes` / `refreshInstallStatus`.
 *
 * The derivation goes through the manifest store to read the
 * persisted source (`'bundled'` / `'sample'`) and then checks the
 * matching `<projectRoot>/app/<appId>/` directory for coherence —
 * a manifest that survives an out-of-band `rm -rf app/<appId>`
 * must surface as `enabled: false` so the next bundled-enable
 * call falls into the artifacts recovery path
 * (recipe-system v1.10 §10.9.5 BS-L2').
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanSampleRecipes,
  refreshInstallStatus,
  getSampleRecipes,
} from '../../src/server/services/recipe-scanner'
import { RecipeManifestStore } from '../../src/server/recipeManifestStore'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger } from '../../src/server/logger'
import { _resetProjectRootCache } from '../../src/server/config'

const SAMPLE_RECIPE_ID = 'document-viewer'

describe('scanSampleRecipes / refreshInstallStatus: enabled/source coherence', () => {
  let projectRoot: string
  let fs: DirectFsLayer
  let manifestStore: RecipeManifestStore

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-scanner-derive-logroot-'))
    mkdirSync(join(root, '.kovitoboard', 'logs'), { recursive: true })
    await initLogger(root, null)
  })

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-scanner-derive-'))
    mkdirSync(join(projectRoot, '.kovitoboard'), { recursive: true })
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    _resetProjectRootCache()
    fs = new DirectFsLayer()
    manifestStore = new RecipeManifestStore(
      join(projectRoot, '.kovitoboard'),
      fs,
    )
  })

  afterEach(() => {
    delete process.env.KOVITOBOARD_PROJECT_ROOT
    _resetProjectRootCache()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('marks enabled=true only when manifest AND app/<appId>/ both exist', () => {
    manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.1.0',
      hash: 'coherent-hash',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    // Mirror the artifacts directory so the coherence check passes.
    mkdirSync(join(projectRoot, 'app', SAMPLE_RECIPE_ID), { recursive: true })

    scanSampleRecipes(fs, manifestStore)
    const cache = getSampleRecipes()
    const sample = cache.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)
    expect(sample).toBeDefined()
    expect(sample!.enabled).toBe(true)
    expect(sample!.source).toBe('bundled')
  })

  it('marks enabled=false when manifest exists but app/<appId>/ was deleted by hand', () => {
    // Same shape as the coherent case, but **without** the
    // matching `app/<appId>/` directory. A scanner that trusts the
    // manifest alone would mis-report this as enabled and let the
    // sample card hide the re-enable button; the coherence check
    // is what catches the manual-sweep edge case.
    manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.1.0',
      hash: 'orphan-hash',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })

    scanSampleRecipes(fs, manifestStore)
    const cache = getSampleRecipes()
    const sample = cache.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)
    expect(sample).toBeDefined()
    expect(sample!.enabled).toBe(false)
    expect(sample!.source).toBeUndefined()
  })

  it('refreshInstallStatus picks up the post-disable app/<appId>/ removal', () => {
    // Seed a coherent enable state.
    manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.1.0',
      hash: 'h',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    mkdirSync(join(projectRoot, 'app', SAMPLE_RECIPE_ID), { recursive: true })
    scanSampleRecipes(fs, manifestStore)
    expect(
      getSampleRecipes().find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!.enabled,
    ).toBe(true)

    // Simulate the disable transaction tearing down both sides.
    rmSync(join(projectRoot, 'app', SAMPLE_RECIPE_ID), { recursive: true, force: true })
    manifestStore.delete(SAMPLE_RECIPE_ID)

    refreshInstallStatus(fs, manifestStore)
    const sample = getSampleRecipes().find(
      (s) => s.metadata.recipeId === SAMPLE_RECIPE_ID,
    )!
    expect(sample.enabled).toBe(false)
    expect(sample.source).toBeUndefined()
  })

  it('surfaces grandfather-sample manifests as enabled with source="sample (grandfather)"', () => {
    manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'grandfather',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
      source: 'sample',
    })
    mkdirSync(join(projectRoot, 'app', SAMPLE_RECIPE_ID), { recursive: true })
    scanSampleRecipes(fs, manifestStore)
    const sample = getSampleRecipes().find(
      (s) => s.metadata.recipeId === SAMPLE_RECIPE_ID,
    )!
    expect(sample.enabled).toBe(true)
    expect(sample.source).toBe('sample (grandfather)')
  })
})
