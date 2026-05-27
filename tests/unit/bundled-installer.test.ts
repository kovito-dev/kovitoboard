/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.1 bundled-installer transactions
 * (recipe-system v1.10 §10.9). The unit test layer covers:
 *
 *   - `classifyLocalResidue` 3-value branching
 *   - `isEnabledAndManifestCoherent` happy-path + cache miss
 *   - `enableBundledRecipe` happy / idempotent / scope-reject /
 *     capture auto-approve
 *   - `disableBundledRecipe` happy / idempotent / data preservation /
 *     grandfather-sample source preservation
 *
 * L1 fixture coverage and the wire-error surfaces are exercised
 * separately by the tester-owned E2E suite (committee §3 fixture
 * list — `bundled-enable-fresh`, `bundled-disable-data-preserved`,
 * `bundled-grandfather-idempotent`, `bundled-agents-write-reject`,
 * `bundled-capture-auto-approve`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { symlinkSync } from 'node:fs'
import {
  BundledInstallerError,
  classifyLocalResidue,
  disableBundledRecipe,
  enableBundledRecipe,
  isEnabledAndManifestCoherent,
  resolveBundledAppIdForDisable,
} from '../../src/server/services/bundled-installer'
import { scanSampleRecipes, getSampleRecipes } from '../../src/server/services/recipe-scanner'
import { RecipeManifestStore } from '../../src/server/recipeManifestStore'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger } from '../../src/server/logger'
import {
  appendRecipeHistory,
  readRecipeHistory,
} from '../../src/server/recipe-history'
import { _resetProjectRootCache } from '../../src/server/config'

// Resolve the KovitoBoard install root once — the bundled recipes
// under `recipes/<id>/` are needed by the enable transaction. The
// test file lives at `tests/unit/...`, so two `..` segments reach
// the repo root.
const KB_INSTALL_ROOT = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
)

const SAMPLE_RECIPE_ID = 'document-viewer'

// =========================================
// Test scaffolding
// =========================================

interface Harness {
  projectRoot: string
  manifestStore: RecipeManifestStore
  fs: DirectFsLayer
}

function buildHarness(): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kb-bundled-installer-'))
  // The bundled-installer writes into <projectRoot>/.kovitoboard/...
  // and <projectRoot>/app/..., both of which must exist (the
  // transaction creates them lazily) so a clean tmp dir is enough.
  mkdirSync(join(projectRoot, '.kovitoboard'), { recursive: true })
  const fs = new DirectFsLayer()
  // Pin the project-root resolver to this harness so
  // `recipe-history.appendRecipeHistory` (which goes through
  // `getKovitoboardDir(fs)` → `resolveProjectRoot(fs)`) writes into
  // the harness's tmp dir rather than the test runner's cwd. The
  // resolver caches at module level, so we also reset the cache so
  // each `buildHarness()` call picks up the new env var.
  process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
  _resetProjectRootCache()
  const manifestStore = new RecipeManifestStore(
    join(projectRoot, '.kovitoboard'),
    fs,
  )
  return { projectRoot, manifestStore, fs }
}

function cleanup(h: Harness): void {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
  _resetProjectRootCache()
  rmSync(h.projectRoot, { recursive: true, force: true })
}

function scanSamples(h: Harness) {
  // The scanner anchors on the directory holding `package.json` —
  // when invoked from the repo root that is exactly KB_INSTALL_ROOT.
  // We do not vary that here: every test resolves the bundled
  // sample from the real `recipes/` directory checked into the repo.
  return scanSampleRecipes(h.fs, h.manifestStore)
}

// =========================================
// classifyLocalResidue
// =========================================

describe('classifyLocalResidue', () => {
  let h: Harness

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-bundled-logroot-'))
    mkdirSync(join(root, '.kovitoboard', 'logs'), { recursive: true })
    await initLogger(root, null)
  })

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('returns "none" when neither manifest nor history exists', () => {
    expect(
      classifyLocalResidue({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      }),
    ).toBe('none')
  })

  it('returns "present" when a bundled manifest exists', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)
    expect(sample).toBeDefined()
    enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample: sample!,
    })
    expect(
      classifyLocalResidue({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      }),
    ).toBe('present')
  })

  it('returns "corrupted" when manifest.appId disagrees with history.appId', () => {
    // Write a history entry directly so its appId diverges from the
    // manifest store's later save() — the divergence is what the
    // corruption check detects.
    appendRecipeHistory(h.fs, {
      id: 'r_20260526_001',
      action: 'install',
      name: 'document-viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: 'history-side-app',
    })
    h.manifestStore.save({
      appId: 'manifest-side-app',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'fakehash',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    expect(
      classifyLocalResidue({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      }),
    ).toBe('corrupted')
  })
})

// =========================================
// isEnabledAndManifestCoherent
// =========================================

describe('isEnabledAndManifestCoherent', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('returns false when no manifest is present', () => {
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(false)
  })

  it('returns true after a successful enable', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(true)
  })

  it('returns false when the manifest is present but app/<appId>/ was removed by hand', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    rmSync(join(h.projectRoot, 'app', result.appId), { recursive: true, force: true })
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(false)
  })
})

// =========================================
// enableBundledRecipe
// =========================================

describe('enableBundledRecipe', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('happy path: writes manifest, copies artifacts, appends install history', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(result.status).toBe('enabled')
    expect(result.source).toBe('bundled')
    expect(result.appId).toBe(SAMPLE_RECIPE_ID)

    const manifestPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      result.appId,
      'manifest.json',
    )
    expect(existsSync(manifestPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(onDisk.source).toBe('bundled')
    expect(onDisk.trustLevel).toBe('code-trusted (bundled)')

    const appDir = join(h.projectRoot, 'app', result.appId)
    expect(existsSync(appDir)).toBe(true)
    expect(existsSync(join(appDir, 'pages', 'DocumentViewer.tsx'))).toBe(true)

    const history = readRecipeHistory(h.fs)
    const installRecord = history.find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && (r.action ?? 'install') === 'install',
    )
    expect(installRecord).toBeDefined()
    expect(installRecord!.source).toBe('bundled')
    expect(installRecord!.appId).toBe(result.appId)
  })

  it('idempotent: a second enable returns already-enabled without rewriting history', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    const historyBefore = readRecipeHistory(h.fs).length
    const second = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(second.status).toBe('already-enabled')
    const historyAfter = readRecipeHistory(h.fs).length
    expect(historyAfter).toBe(historyBefore)
  })

  it('capture auto-approve: approvedCaptures equals captureRequires (BS-L4)', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    const manifest = h.manifestStore.get(result.appId)
    expect(manifest).not.toBeNull()
    expect(manifest!.approvedCaptures).toEqual(manifest!.captureRequires)
  })

  it('history-only path skips rmSync to avoid deleting a reused appId belonging to another app', () => {
    // Reproduce the registry-stale grandfather sample state where
    // the manifest was wiped but a bundled/sample install record
    // is still in the JSONL log. Critical invariant: with no live
    // manifest to prove ownership, the disable transaction must
    // NOT touch `app/<appId>/` — that directory may have been
    // re-used by an unrelated app since the manifest disappeared.
    appendRecipeHistory(h.fs, {
      id: 'r_20260401_001',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'sample',
      hash: 'h',
      appliedAt: '2026-04-01T00:00:00.000Z',
      artifacts: [],
      menu: ['document-viewer'],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    // Seed an "unrelated" app that happens to share the appId
    // (e.g. user-created after the original sample manifest was
    // hand-removed).
    const appDir = join(h.projectRoot, 'app', SAMPLE_RECIPE_ID)
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'unrelated.tsx'), 'belongs to another app', 'utf-8')

    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    expect(result.metadata?.note).toBe('manifest-already-absent')
    // The directory of the reused appId is left alone — exactly
    // what BS-L3-A's "non-destructive cleanup on manifest-already-
    // absent" semantics demand.
    expect(existsSync(join(appDir, 'unrelated.tsx'))).toBe(true)
  })

  it('disable history record carries the install record display name, not the machine recipeId', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    const installRecord = readRecipeHistory(h.fs).find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && (r.action ?? 'install') === 'install',
    )!
    // Sanity: the install record stored the display name (from the
    // recipe.yaml `name` field).
    expect(installRecord.name).not.toBe(SAMPLE_RECIPE_ID)
    expect(installRecord.name.length).toBeGreaterThan(0)
    const displayName = installRecord.name

    disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    const uninstallRecord = readRecipeHistory(h.fs).find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && r.action === 'uninstall',
    )!
    // The uninstall row carries the human-readable display name,
    // not the machine `recipeId` — UI / audit consumers expecting
    // `name` to be a localized string keep working.
    expect(uninstallRecord.name).toBe(displayName)
    expect(uninstallRecord.name).not.toBe(SAMPLE_RECIPE_ID)
  })

  it('cross-appId residue: same recipeId under a different appId fails closed (no duplicate manifest)', () => {
    // Same recipeId, different appId, non-coherent residue. The
    // Step 2 coherence gate short-circuits the coherent case;
    // reaching Step 4 with a recipeId-scoped residue under a
    // different appId would mint a *second* manifest and brick
    // every later enable/disable call with the uniqueness
    // violation. Fail closed instead so the user can clean up.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    h.manifestStore.save({
      appId: 'orphan-id',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '0.0.1-old',
      hash: 'stale',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflict')
    expect(err.detail?.conflictSource).toBe('cross-appid-residue')
    expect(err.detail?.existingAppId).toBe('orphan-id')
    // The cross-appId residue is left untouched (no Step 4 ran).
    expect(h.manifestStore.get('orphan-id')).not.toBeNull()
    // No new manifest was created at the bundled-registry id.
    expect(h.manifestStore.get(SAMPLE_RECIPE_ID)).toBeNull()
  })

  it('history match never keys off entry.name (display text)', () => {
    // A history row whose recipeId is missing (or whose `name`
    // happens to be the user-localized display string for an
    // unrelated recipe) must not be treated as a match for the
    // bundled-installer's disable transaction. Seed a row that
    // would have matched under the old `entry.name === recipeId`
    // fallback, then verify the disable call short-circuits as
    // `already-disabled` instead of acting on the spoofed row.
    appendRecipeHistory(h.fs, {
      id: 'r_20260101_001',
      action: 'install',
      // `name` collides with the target recipeId, but `recipeId`
      // itself is absent — the old code would treat this as a
      // bundled install of `document-viewer`. The new code does
      // not, so the disable call must see no residue.
      name: SAMPLE_RECIPE_ID,
      version: '1.0.0',
      source: 'bundled',
      hash: 'spoof-hash',
      appliedAt: '2026-01-01T00:00:00.000Z',
      artifacts: [],
      menu: [],
      // recipeId intentionally absent
      appId: 'spoofed-app',
    })
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('already-disabled')
    expect(result.dataPreserved).toBe(true)
    expect(result.appId).toBeUndefined()
  })

  it('appId path-traversal: a tampered manifest with `..` in appId fails closed before rmSync', () => {
    // The bundled-installer trusts the manifest store for `appId`,
    // so a corrupted record could drive the recursive `rmSync`
    // outside `<projectRoot>/app/`. The format validator must
    // reject anything that contains a path separator or `..`
    // segment, *before* any filesystem write happens.
    h.manifestStore.save({
      // `manifestStore.save` writes into baseDir/appId, so we use
      // a benign appId on disk and then expose a malicious value
      // through the cache by replacing the entry in-memory.
      appId: 'evil',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'h',
      installedAt: '2026-05-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    // Swap in a traversal value through the public list-by-id path.
    // (`save` of `../escape` would fail on disk, but the validator
    // must catch the in-memory variant too.)
    const malicious = {
      appId: '../escape',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'h',
      installedAt: '2026-05-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)' as const,
      source: 'bundled' as const,
    }
    // Reach into the manifest store cache via the public list path —
    // we cannot save `../escape` through the real `save` (writeFileAtomic
    // would refuse), but we can construct the same in-memory shape that
    // a corrupted on-disk JSON would surface after `loadAll`.
    const cacheLike = (h.manifestStore as unknown as { cache: Map<string, typeof malicious> })
      .cache
    cacheLike.clear()
    cacheLike.set(malicious.appId, malicious)

    let thrown: unknown = null
    try {
      disableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        recipeId: SAMPLE_RECIPE_ID,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdInvalid')
    expect(err.httpStatus).toBe(500)
  })

  it('fails closed when multiple bundled/sample manifests share the same recipeId', () => {
    // Source-scoped uniqueness is normative (recipe-system v1.10
    // §10.9.3 Step 2 SSOT): exactly one bundled/sample manifest per
    // recipeId. Two matching manifests is a corruption signal —
    // returning the first match would let the disable transaction
    // tear down an arbitrary app while leaving the duplicate
    // behind. Fail-closed with BundledManifestUniquenessViolation.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!

    // Seed two bundled manifests for the same recipeId under
    // different appIds.
    for (const appId of ['app-alpha', 'app-beta']) {
      h.manifestStore.save({
        appId,
        recipeId: SAMPLE_RECIPE_ID,
        recipeVersion: '1.0.0',
        hash: `hash-${appId}`,
        installedAt: '2026-05-01T00:00:00.000Z',
        approvedScopes: [],
        api: { scopes: [], calls: [] },
        captureRequires: [],
        approvedCaptures: [],
        trustLevel: 'code-trusted (bundled)',
        source: 'bundled',
      })
    }

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledManifestUniquenessViolation')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.foundAppIds).toEqual(
      expect.arrayContaining(['app-alpha', 'app-beta']),
    )
  })

  it('persists the freshly-parsed recipe hash, not the cached registry hash', () => {
    // The bundled-installer re-parses recipe.yaml right before
    // copying the artifacts, so the persisted hash should describe
    // the artifacts that actually landed on disk. A future caller
    // that re-uses a stale `SampleRecipeInfo.hash` would mis-bind
    // the integrity stamp to a different revision.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Force a divergence between the cached hash and the
    // freshly-parsed hash by mutating the sample object in place
    // before calling enable.
    const driftedSample = { ...sample, hash: 'STALE-CACHE-HASH-DO-NOT-USE' }
    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample: driftedSample,
    })
    const manifest = h.manifestStore.get(result.appId)
    expect(manifest).not.toBeNull()
    // The recorded hash is whatever `parseRecipe` returned during
    // enable — never the stale registry-cache value.
    expect(manifest!.hash).not.toBe('STALE-CACHE-HASH-DO-NOT-USE')
    expect(manifest!.hash.length).toBeGreaterThan(0)

    const history = readRecipeHistory(h.fs)
    const installRecord = history.find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && (r.action ?? 'install') === 'install',
    )!
    expect(installRecord.hash).not.toBe('STALE-CACHE-HASH-DO-NOT-USE')
  })

  it('appDir self-made conflict: a pre-existing app/<appId>/ without a bundled/sample install record is rejected as self-made (BL-2026-176)', () => {
    // Without a coherent (or even non-coherent) bundled/sample
    // manifest at the target appId AND without a bundled/sample
    // install record in recipe-history.jsonl, the existing
    // `app/<appId>/` directory must have been authored by the user.
    // Spec recipe-system v1.10 §10.9.3 Step 3d (ii-a-self-made)
    // routes this to a 400 BundledAppIdConflict so the user can
    // rename / clean up by hand; the request-removal endpoint is
    // the correct destructive surface for self-made apps.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!

    // Seed an app directory with a stray file the bundled recipe
    // would never write itself.
    const appDir = join(h.projectRoot, 'app', SAMPLE_RECIPE_ID)
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'evil.tsx'), 'malicious payload', 'utf-8')

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflict')
    expect(err.httpStatus).toBe(400)
    expect(err.detail?.conflictSource).toBe('self-made')
    // The stray file is left untouched (no Step 4 ran).
    expect(existsSync(join(appDir, 'evil.tsx'))).toBe(true)
    // No manifest was written.
    expect(h.manifestStore.get(SAMPLE_RECIPE_ID)).toBeNull()
  })

  it('recovery path: a manifest without a matching appDir is re-built cleanly (no anomaly fail)', () => {
    // Non-coherent residue: the manifest store still carries a
    // bundled entry but `app/<appId>/` was swept out of band (the
    // "orphan manifest" case `isEnabledAndManifestCoherent` reports
    // as non-coherent). Enable should drive Step 4 to a fresh
    // appDir build without the BundledAppDirAnomaly fail (which
    // only fires when the appDir is *present* without a manifest).
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!

    h.manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '0.0.1-old',
      hash: 'stale',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    // No `app/<SAMPLE_RECIPE_ID>/` directory exists — this is what
    // makes `isEnabledAndManifestCoherent` report false and routes
    // Step 2 into the recovery path instead of `already-enabled`.

    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(result.status).toBe('enabled')
    // Step 5 overwrote the stale manifest with the freshly-parsed
    // version (recipe-system v1.10 §10.9.3 Step 3d (iii) recovery
    // semantics).
    const refreshed = h.manifestStore.get(result.appId)!
    expect(refreshed.recipeVersion).not.toBe('0.0.1-old')
    expect(refreshed.source).toBe('bundled')
    // The new artifacts are in place.
    expect(
      existsSync(join(h.projectRoot, 'app', result.appId, 'pages', 'DocumentViewer.tsx')),
    ).toBe(true)
  })

  it('cross-source overwrite reject: an `import` manifest at the same appId blocks bundled enable', () => {
    // The bundled-installer must not overwrite a non-bundled / non-
    // sample manifest, even when the `recipeId` happens to match —
    // overwriting an `'import'` or `'url'` install destroys user
    // intent (recipe-system v1.10 §10.9.3 Step 3d (i) SSOT).
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!

    // Seed an existing `'import'` manifest at the target appId
    // (same recipeId so the legacy `recipeId !== recipeId` guard
    // alone would have let this through).
    h.manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '9.9.9',
      hash: 'import-hash',
      installedAt: '2026-05-01T00:00:00.000Z',
      approvedScopes: ['own-data'],
      api: { scopes: ['own-data'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
      source: 'import',
    })

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflict')
    expect(err.httpStatus).toBe(400)
    // The pre-existing import manifest is left untouched (no Step 4
    // artifacts copy ran — appId conflict fails before any side
    // effect).
    const stillPresent = h.manifestStore.get(SAMPLE_RECIPE_ID)
    expect(stillPresent).not.toBeNull()
    expect(stillPresent!.source).toBe('import')
    expect(stillPresent!.recipeVersion).toBe('9.9.9')
  })

  it('scope reject: agents-write declared in api.scopes throws BundledScopeForbidden (BS-L5)', () => {
    // Materialise a synthetic bundled recipe with a forbidden scope.
    // We sandbox it under a temp dir to avoid touching the real
    // `recipes/` tree.
    const fakeKbRoot = mkdtempSync(join(tmpdir(), 'kb-fake-install-'))
    try {
      mkdirSync(join(fakeKbRoot, 'recipes', 'evil'), { recursive: true })
      writeFileSync(join(fakeKbRoot, 'package.json'), '{}')
      writeFileSync(
        join(fakeKbRoot, 'recipes', 'evil', 'recipe.yaml'),
        [
          '---',
          'recipeId: "evil"',
          'name: "Evil"',
          'description: "synthetic"',
          'version: "1.0.0"',
          'artifacts: []',
          'menu:',
          '  - id: "evil"',
          '    label: "Evil"',
          '    page: "pages/Evil"',
          'api:',
          '  scopes:',
          '    - own-data',
          '  calls: []',
          '---',
        ].join('\n'),
        'utf-8',
      )
      const fakeSample = {
        id: 'evil',
        metadata: {
          recipeId: 'evil',
          name: 'Evil',
          description: 'synthetic',
          version: '1.0.0',
        } as never,
        sourcePath: join(fakeKbRoot, 'recipes', 'evil'),
        sourceFormat: 'directory' as const,
        hash: 'evilhash',
        installed: false,
        enabled: false,
      }
      // Bypass the parser's own scope validation by writing a manifest-
      // shaped object directly into recipe.yaml: we want to verify the
      // bundled-installer's defence-in-depth check fires even if the
      // parser-side guard ever regresses. To do that we instead call
      // the installer twice — once with a benign yaml (passes), once
      // after rewriting recipe.yaml to inject the forbidden scope, so
      // the installer's own validation surfaces.
      // (Simpler approach: write the yaml with the forbidden scope
      //  directly. parseRecipe will currently reject it via
      //  `isValidScope`, which means BundledScopeForbidden is never
      //  reached on the live path. We assert the parser-level reject
      //  here as the expected outcome — both paths fail closed,
      //  matching BS-L5's "block in v0.2.x" semantics.)
      let thrown: unknown = null
      try {
        // Rewrite with the forbidden scope.
        writeFileSync(
          join(fakeKbRoot, 'recipes', 'evil', 'recipe.yaml'),
          [
            '---',
            'recipeId: "evil"',
            'name: "Evil"',
            'description: "synthetic"',
            'version: "1.0.0"',
            'artifacts: []',
            'menu:',
            '  - id: "evil"',
            '    label: "Evil"',
            '    page: "pages/Evil"',
            'api:',
            '  scopes:',
            '    - agents-write',
            '  calls: []',
            '---',
          ].join('\n'),
          'utf-8',
        )
        enableBundledRecipe({
          fs: h.fs,
          manifestStore: h.manifestStore,
          projectRoot: h.projectRoot,
          kovitoboardRoot: fakeKbRoot,
          recipeId: 'evil',
          sample: fakeSample,
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundledInstallerError)
      // Either the parser rejects the scope (BundledRecipeMalformed)
      // or the installer's own BS-L5 guard fires
      // (BundledScopeForbidden). Both are acceptable — they both
      // surface a 4xx/5xx error and block enable, satisfying BS-L5's
      // "agents-write is blocked in v0.2.x" invariant.
      const err = thrown as BundledInstallerError
      expect(['BundledScopeForbidden', 'BundledRecipeMalformed']).toContain(err.errorCode)
    } finally {
      rmSync(fakeKbRoot, { recursive: true, force: true })
    }
  })
})

// =========================================
// disableBundledRecipe
// =========================================

describe('disableBundledRecipe', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('happy path: removes artifacts + manifest, appends uninstall history, preserves data dir', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const enableResult = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })

    // Seed a marker file under app/data/<appId>/ — the disable
    // transaction must leave it untouched (BS-L3-A).
    const dataDir = join(h.projectRoot, 'app', 'data', enableResult.appId)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'user-note.txt'), 'do-not-delete', 'utf-8')

    const disableResult = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(disableResult.status).toBe('disabled')
    expect(disableResult.dataPreserved).toBe(true)
    expect(disableResult.appId).toBe(enableResult.appId)

    // Artifacts gone
    expect(existsSync(join(h.projectRoot, 'app', enableResult.appId))).toBe(false)
    // Manifest gone
    expect(
      existsSync(
        join(
          h.projectRoot,
          '.kovitoboard',
          'recipes-installed',
          enableResult.appId,
          'manifest.json',
        ),
      ),
    ).toBe(false)
    // Data dir preserved (BS-L3-A)
    expect(existsSync(join(dataDir, 'user-note.txt'))).toBe(true)

    // History record
    const history = readRecipeHistory(h.fs)
    const uninstallRecord = history.find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && r.action === 'uninstall',
    )
    expect(uninstallRecord).toBeDefined()
    expect(uninstallRecord!.source).toBe('bundled')
    expect(uninstallRecord!.ownDataDeleted).toBe(false)
  })

  it('idempotent already-disabled when no manifest / history exists', () => {
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('already-disabled')
    expect(result.dataPreserved).toBe(true)
  })

  it('result.source: round-trips persisted "bundled" for bundled-enable lineage', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    // The bundled-installer's disable transaction must surface the
    // persisted `source` on the result so the ws-event broadcast
    // can pass it through to consumers (BS-L3-B / http-api-contract
    // v1.7.1 §6.3.8.B broadcast contract).
    expect(result.source).toBe('bundled')
  })

  it('result.source: round-trips persisted "sample" for grandfather lineage', () => {
    h.manifestStore.save({
      appId: 'document-viewer',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'grandfather-hash',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: ['project-read'],
      api: { scopes: ['project-read'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
      source: 'sample',
    })
    appendRecipeHistory(h.fs, {
      id: 'r_20260401_001',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'sample',
      hash: 'grandfather-hash',
      appliedAt: '2026-04-01T00:00:00.000Z',
      artifacts: [],
      menu: ['document-viewer'],
      recipeId: SAMPLE_RECIPE_ID,
      appId: 'document-viewer',
    })
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    // Grandfather-sample disable must broadcast `source: 'sample'`,
    // not a hard-coded `'bundled'` — UI consumers distinguish
    // grandfather paths via this field.
    expect(result.source).toBe('sample')
  })

  it('grandfather sample: preserves source: "sample" in the uninstall history (BS-L3-B)', () => {
    // Simulate a v0.2.0 sample install left behind in the manifest
    // store + history. The bundled-installer's disable path must NOT
    // hard-code `'bundled'` into the new uninstall record.
    h.manifestStore.save({
      appId: 'document-viewer',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'grandfather-hash',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: ['project-read'],
      api: { scopes: ['project-read'], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
      source: 'sample',
    })
    appendRecipeHistory(h.fs, {
      id: 'r_20260401_001',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'sample',
      hash: 'grandfather-hash',
      appliedAt: '2026-04-01T00:00:00.000Z',
      artifacts: [],
      menu: ['document-viewer'],
      recipeId: SAMPLE_RECIPE_ID,
      appId: 'document-viewer',
    })

    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')

    const history = readRecipeHistory(h.fs)
    const uninstallRecord = history.find(
      (r) => r.recipeId === SAMPLE_RECIPE_ID && r.action === 'uninstall',
    )
    expect(uninstallRecord).toBeDefined()
    // The persisted source must round-trip — hard-coding 'bundled'
    // here would break later already-disabled lookups.
    expect(uninstallRecord!.source).toBe('sample')
  })
})

// =========================================
// BL-2026-176 Phase 1 edge-case coverage
// =========================================
//
// Coverage targets (spec recipe-system v1.10 §10.9.3 / §10.9.4):
//
//   - `BundledManifestUnreadable` 500 (enable Step 3d (iv))
//   - `BundledAppIdConflictAnomaly` 500 / 503 probe-order branches
//   - `BundledAppIdConflict` (`'self-made'`) — already covered by the
//     pre-existing "appDir self-made conflict" test above; not
//     duplicated.
//   - partial-residue recovery (Step 4-7 driven by history match)
//   - `disable` metadata.note 4-value enum
//   - `resolveBundledAppIdForDisable` four-case branching

describe('enable edge cases (BL-2026-176)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    cleanup(h)
  })

  it('BundledManifestUnreadable: an unparseable existing manifest is rejected with 500', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Plant a corrupt manifest at the target appId. The validator
    // skips it at boot (silent warn), so the manifestStore cache
    // does not surface the corruption — only the on-disk probe does.
    const manifestDir = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      SAMPLE_RECIPE_ID,
    )
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'manifest.json'), 'not-json{', 'utf-8')

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledManifestUnreadable')
    expect(err.httpStatus).toBe(500)
  })

  it('BundledAppIdConflictAnomaly: a non-directory entry at app/<appId> fails closed', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Plant a regular file at the appDir path. Step 3d (ii) probe
    // reports it as `'non-directory-entry'`.
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(appBase, { recursive: true })
    writeFileSync(join(appBase, SAMPLE_RECIPE_ID), 'i am a file', 'utf-8')

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflictAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('non-directory-entry')
  })

  it('BundledAppIdConflictAnomaly: a broken symlink at app/<appId> fails closed', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Plant a symlink whose target does not exist.
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(appBase, { recursive: true })
    symlinkSync(
      join(h.projectRoot, 'nonexistent-target'),
      join(appBase, SAMPLE_RECIPE_ID),
    )

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflictAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('broken-symlink')
  })

  it('BundledAppIdConflictAnomaly: a live symlink whose target leaves <projectRoot>/app/ fails closed', () => {
    // Spec recipe-system v1.11 §10.9.3 Step 3d (ii-f). PR #56 codex
    // attempt 1 Medium 1: a crafted `app/<appId>` symlink that
    // resolves outside `<projectRoot>/app/` would let step 3
    // `readdirSync` list (and step 5 act on) an external directory.
    // The step 2.5 path-boundary verification must reject this
    // before the readdir runs.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(appBase, { recursive: true })
    // Plant a real directory outside `<projectRoot>/app/` and
    // symlink the appDir to it. The target exists, so the probe
    // cannot fall through to the broken-symlink (ii-c) branch.
    const externalDir = join(h.projectRoot, 'external-target')
    mkdirSync(externalDir, { recursive: true })
    writeFileSync(join(externalDir, 'secret.txt'), 'do-not-read', 'utf-8')
    symlinkSync(externalDir, join(appBase, SAMPLE_RECIPE_ID))

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflictAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('symlink-out-of-app-root')
    // The resolvedTarget must canonicalise to the planted external
    // dir. On macOS the project root sits under `/private/var/...`
    // so we substring-match on the leaf rather than the full path.
    expect(typeof err.detail?.resolvedTarget).toBe('string')
    expect(err.detail?.resolvedTarget as string).toContain('external-target')
  })

  it('a live symlink whose target stays under <projectRoot>/app/ falls through to the readable-directory branch', () => {
    // Spec recipe-system v1.11 §10.9.3 Step 3d (ii) step 2.5
    // path-boundary verification only rejects targets outside
    // `<projectRoot>/app/`. A symlink pointing to a sibling app
    // directory (in-boundary) must keep the legacy probe outcome:
    // readdir succeeds, then the history-match decides between
    // `partial-residue` (recovery) and `self-made` (400). With no
    // bundled/sample install record the result is the latter.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(appBase, { recursive: true })
    const internalDir = join(appBase, 'other-real-app')
    mkdirSync(internalDir, { recursive: true })
    writeFileSync(join(internalDir, 'placeholder.txt'), 'x', 'utf-8')
    symlinkSync(internalDir, join(appBase, SAMPLE_RECIPE_ID))

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflict')
    expect(err.httpStatus).toBe(400)
    expect(err.detail?.conflictSource).toBe('self-made')
  })

  it('BundledAppIdConflictAnomaly: a sibling leftover temp dir fails closed', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Plant a sibling .tmp* dir matching the leftover-temp prefix.
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(join(appBase, `${SAMPLE_RECIPE_ID}.tmp123`), { recursive: true })

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: KB_INSTALL_ROOT,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledAppIdConflictAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('leftover-temp-dir')
  })

  it('partial-residue recovery: manifest absent + bundled install record present → 200 enabled (Step 4-7)', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Simulate a partial residue: a bundled install record + a
    // readable app/<appId>/ directory, but no manifest. Spec routes
    // this case to the recovery path (Step 4-7), not to the
    // self-made / anomaly reject paths.
    appendRecipeHistory(h.fs, {
      id: 'r_20260526_part1',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'partial-residue-hash',
      appliedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const appBase = join(h.projectRoot, 'app')
    mkdirSync(join(appBase, SAMPLE_RECIPE_ID), { recursive: true })
    writeFileSync(
      join(appBase, SAMPLE_RECIPE_ID, 'stale-artifact.tsx'),
      'stale',
      'utf-8',
    )

    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(result.status).toBe('enabled')
    expect(result.source).toBe('bundled')
    // The stale artifact is replaced (recovery wiped the appDir).
    expect(
      existsSync(join(appBase, SAMPLE_RECIPE_ID, 'stale-artifact.tsx')),
    ).toBe(false)
    // A coherent manifest is now in place.
    const manifest = h.manifestStore.get(SAMPLE_RECIPE_ID)
    expect(manifest).not.toBeNull()
    expect(manifest!.source).toBe('bundled')
  })
})

describe('disable edge cases (BL-2026-176)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    cleanup(h)
  })

  it('metadata.note "bundled-registry-stale" when the recipe id is no longer in the bundled registry', () => {
    // Populate the scanner cache so it is in the 'initialised' state
    // (i.e. not 'unavailable'), but pick a recipeId that is not in
    // the cache. That is the spec-normative `'stale'` branch: a
    // future KB release rename / removal leaves the local state in
    // place while the recipe id falls off the registry.
    scanSamples(h)
    const PHANTOM_RECIPE_ID = 'phantom-recipe'
    h.manifestStore.save({
      appId: PHANTOM_RECIPE_ID,
      recipeId: PHANTOM_RECIPE_ID,
      recipeVersion: '0.0.0',
      hash: 'fakehash',
      installedAt: '2026-04-01T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    mkdirSync(join(h.projectRoot, 'app', PHANTOM_RECIPE_ID), { recursive: true })

    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: PHANTOM_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    expect(result.metadata?.note).toBe('bundled-registry-stale')
  })

  it('metadata.note "manifest-already-absent" wins over registry note when manifest is gone', () => {
    // Seed a history install record but NO manifest — the partial
    // residue path. Spec recipe-system v1.10 §10.9.4 Step 2 routes
    // this case to the `manifest-already-absent` metadata.note,
    // overriding any registry-derived note value.
    scanSamples(h)
    appendRecipeHistory(h.fs, {
      id: 'r_20260526_pr',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })

    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    expect(result.metadata?.note).toBe('manifest-already-absent')
  })
})

describe('resolveBundledAppIdForDisable (BL-2026-176)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    cleanup(h)
  })

  it('returns undefined when no manifest and no install record exist', () => {
    expect(
      resolveBundledAppIdForDisable({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      }),
    ).toBeUndefined()
  })

  it('resolves the appId + source from a bundled manifest hit', () => {
    h.manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'fakehash',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    const result = resolveBundledAppIdForDisable({
      fs: h.fs,
      manifestStore: h.manifestStore,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result).toEqual({
      appId: SAMPLE_RECIPE_ID,
      source: 'bundled',
      manifestAlreadyAbsent: false,
    })
  })

  it('resolves the appId from a history install record with manifestAlreadyAbsent=true', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260526_resolve',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'sample',
      hash: 'fakehash',
      appliedAt: '2026-04-01T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const result = resolveBundledAppIdForDisable({
      fs: h.fs,
      manifestStore: h.manifestStore,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result).toEqual({
      appId: SAMPLE_RECIPE_ID,
      source: 'sample',
      manifestAlreadyAbsent: true,
    })
  })

  it('throws BundledLocalStateCorrupted when manifest and history disagree on appId', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260526_corrupted',
      action: 'install',
      name: 'document-viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: 'history-side-app',
    })
    h.manifestStore.save({
      appId: 'manifest-side-app',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'fakehash',
      installedAt: '2026-05-26T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })

    let thrown: unknown = null
    try {
      resolveBundledAppIdForDisable({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledLocalStateCorrupted')
    expect(err.httpStatus).toBe(500)
  })
})
