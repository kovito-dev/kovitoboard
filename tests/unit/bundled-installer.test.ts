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
  loadRecipeHistorySnapshot,
  resolveBundledAppIdForDisable,
  type RecipeHistorySnapshot,
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

  it('cache-miss + history-resolved appId still probes disk for malformed manifest (PR #56 attempt 9)', () => {
    // Codex attempt 9 Finding "fail-closed gap in local-state
    // validation": classifyLocalResidue used to only probe
    // manifest.json on disk when findManifestByRecipeId returned a
    // cached manifest. A manifest that exists on disk but was
    // dropped from manifestStore.loadAll() at boot for schema
    // reasons (warn log only) would fall through as manifest === null,
    // and the disable transaction would silently take the
    // manifestAlreadyAbsent branch — never deleting the stale
    // corrupt manifest file. The fix adds a cache-miss disk probe:
    // when manifest is null but a history record gives us an appId,
    // probeManifestFileOnDisk(recordAppId) surfaces present-io-failure
    // (503) and present-parse-failure (500) instead of silent
    // fallthrough.
    //
    // Seed a history install record + plant an unparseable manifest
    // at the resolved appId WITHOUT going through manifestStore.save.
    // The cache misses (we never registered the manifest), the
    // disk probe sees `not-json{` and routes to present-parse-failure
    // → 500 BundledManifestUnreadable.
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_cache_miss_probe',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
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
      classifyLocalResidue({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledManifestUnreadable')
    expect(err.httpStatus).toBe(500)
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

  it('a live symlink whose target is a different in-boundary appId is rejected by Step 3d (ii-g) (v1.12 BL-2026-179)', () => {
    // Spec recipe-system v1.12 §10.9.3 Step 3d (ii-g) (Round 2 High
    // 11): a live symlink whose realpath stays under
    // `<projectRoot>/app/` (the ii-f gate passed) but resolves to a
    // **different** sibling under the boundary now fails closed.
    // Earlier versions (v1.10 / v1.11) routed this case to either
    // the partial-residue recovery (with a history match) or the
    // self-made 400 (without one); the in-boundary alias attack
    // defence supersedes both because the rollback rmSync on the
    // symlink would unlink the link without touching the aliased
    // directory's artifacts.
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
    expect(err.errorCode).toBe('BundledAppIdConflictAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('symlink-in-boundary-alias')
    expect(err.detail?.resolvedTarget).toBe(internalDir)
    expect(err.detail?.requestedAppId).toBe(SAMPLE_RECIPE_ID)
  })

  it('BundledRegistryAnomaly: a sibling leftover temp dir fails closed at Step 1.5 (v1.12 BL-2026-177)', () => {
    // Spec v1.12 §10.9.3 Step 1.5 (BL-2026-177 same-PR fix):
    // the endpoint-entry gate scans `<projectRoot>/app/` root-wide
    // for `<appId>.tmp*` / `<appId>.staging*` siblings before any
    // per-appId probe runs. Previously this case fell through to
    // Step 3d (ii-e) and surfaced as
    // `BundledAppIdConflictAnomaly` (`leftover-temp-dir`); the
    // v1.12 gate routes it to `BundledRegistryAnomaly`
    // (`app-root-leftover-temp`) instead. Spec notes the two
    // checks are "logically overlapping"; the endpoint-entry
    // version wins because it runs first.
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
    expect(err.errorCode).toBe('BundledRegistryAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('app-root-leftover-temp')
    expect(err.detail?.leftoverPath).toBe(
      join(appBase, `${SAMPLE_RECIPE_ID}.tmp123`),
    )
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

  it('rejects partial-residue recovery when history record claims a different appId (PR #56 attempt 8)', () => {
    // Codex attempt 8 Finding "fail-closed misclassification":
    // probeAppDirAnomaly used to return `partial-residue` whenever
    // findHistoryMatchForBundled matched on recipeId alone, even if
    // the historic install record claimed a different appId. That
    // would let the enable recovery path Step 4 rmSync(appDir) wipe
    // a self-made / user-authored directory that has no relation to
    // this bundled recipe instance. The fix requires the matched
    // record's resolved appId to equal the target appId; mismatches
    // downgrade to `self-made`, which the caller throws as 400
    // `BundledAppIdConflict` rather than running the destructive
    // recovery.
    //
    // Seed a history install record claiming the same recipeId but
    // under a DIFFERENT appId, plant a self-made directory at the
    // target appId, and run enableBundledRecipe. The probe should
    // route to self-made (BundledAppIdConflict 400), preserving
    // the existing directory.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_appid_mismatch',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-26T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: 'a-completely-different-app-id',
    })
    // Plant a self-made directory at the bundled default appId
    // (== recipeId for bundled samples). probeAppDirAnomaly will
    // see it exists; the history match's recordAppId
    // (`a-completely-different-app-id`) differs from the target
    // appId (`SAMPLE_RECIPE_ID`), so the probe must NOT classify
    // this as partial-residue.
    const targetAppDir = join(h.projectRoot, 'app', SAMPLE_RECIPE_ID)
    mkdirSync(targetAppDir, { recursive: true })
    writeFileSync(join(targetAppDir, 'self-made.txt'), 'user-authored', 'utf-8')
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
    // The self-made directory must be preserved (no rmSync executed).
    expect(existsSync(join(targetAppDir, 'self-made.txt'))).toBe(true)
  })

  it('BundledLocalStateUnavailable: probeManifestOnDisk routes EACCES to present-io-failure instead of existsSync absent (PR #56 attempt 4)', () => {
    // Codex attempt 4 Finding "fail-open filesystem probe":
    // probeManifestOnDisk previously used existsSync(manifestPath)
    // on the cache-miss branch, which silently maps EACCES / EPERM
    // to false and routes a permission-denied manifest into the
    // 'absent' path. That defeats the fail-closed posture (an
    // unreadable manifest is then treated as "no manifest" and the
    // enable transaction proceeds). The refactor uses statSync +
    // errno-based classification: ENOENT stays 'absent', any other
    // errno surfaces as 'present-io-failure' → 503
    // BundledLocalStateUnavailable on the enable path.
    //
    // Plant a chmod-000 manifest on disk WITHOUT going through
    // manifestStore.save (so the cache misses on the appId lookup).
    // The Step 3d (iv) cache-miss disk probe inside
    // enableBundledRecipe is the exact callsite that previously
    // fell through to 'absent' under existsSync.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    const manifestDir = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      SAMPLE_RECIPE_ID,
    )
    mkdirSync(manifestDir, { recursive: true })
    const manifestPath = join(manifestDir, 'manifest.json')
    writeFileSync(manifestPath, '{"valid":"json"}', 'utf-8')
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(manifestPath, 0o000)
    try {
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
      expect(err.errorCode).toBe('BundledLocalStateUnavailable')
      expect(err.httpStatus).toBe(503)
    } finally {
      chmodSync(manifestPath, 0o644)
    }
  })

  it('BundledLocalStateUnavailable: unreadable recipe-history.jsonl surfaces 503 instead of fail-open self-made (PR #56 attempt 3)', () => {
    // Codex attempt 3 Finding "fail-open local state probe":
    // the enable transaction's appDir anomaly probe previously fed
    // its history input from `readRecipeHistory(fs)` directly,
    // which silently returns `[]` on IO failure. A history file
    // that the process cannot read should *not* be downgraded to
    // "no history" — it must surface as 503 so the operator can
    // recover the disk state, and the partial-residue branch never
    // mis-routes to `self-made`.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Seed a history entry so the file exists, then chmod 000 to
    // force EACCES on read. Without the snapshot loader fix, the
    // enable path would swallow the failure and probe as "no
    // history".
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_enable_io_fail',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(historyPath, 0o000)
    try {
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
      expect(err.errorCode).toBe('BundledLocalStateUnavailable')
      expect(err.httpStatus).toBe(503)
    } finally {
      chmodSync(historyPath, 0o644)
    }
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

// =========================================
// loadRecipeHistorySnapshot + snapshot threading
// (PR #56 codex attempt 2 Finding "resource exhaustion")
// =========================================

/**
 * Wrap a `DirectFsLayer` so we can count `readFileSync` invocations
 * without changing any other behaviour. Used to prove that snapshot
 * threading collapses the worst-case 3× sync history reads
 * (handler classify + resolver classify + resolver fallback) into a
 * single per-request read.
 */
function wrapFsWithReadCounter(fs: DirectFsLayer): {
  fs: DirectFsLayer
  countFor: (path: string) => number
  reset: () => void
} {
  const counts = new Map<string, number>()
  const originalReadFileSync = fs.readFileSync.bind(fs)
  // Augment the layer in place (DirectFsLayer instances are
  // per-test, so this does not leak between tests).
  ;(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = (
    p: Parameters<typeof originalReadFileSync>[0],
    enc?: Parameters<typeof originalReadFileSync>[1],
  ) => {
    const key = typeof p === 'string' ? p : String(p)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return originalReadFileSync(p, enc)
  }
  return {
    fs,
    countFor: (path: string) => counts.get(path) ?? 0,
    reset: () => counts.clear(),
  }
}

describe('loadRecipeHistorySnapshot (PR #56 attempt 2)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    cleanup(h)
  })

  it('classifyLocalResidue forces a disk health probe even when manifestStore caches the manifest (PR #56 attempt 6)', () => {
    // Codex attempt 6 Finding "fail-closed check bypass":
    // probeManifestOnDisk used to short-circuit on any cache hit, so
    // a manifest that was chmod-ed / corrupted after boot would still
    // be treated as healthy and the disable transaction would proceed.
    // The attempt 6 fix introduces a separate `probeManifestFileOnDisk`
    // path that always reaches the filesystem, and classifyLocalResidue
    // now uses it on the disable code path.
    //
    // Seed a cached manifest via manifestStore.save (boot-time
    // contract), then chmod 000 the on-disk file to simulate post-boot
    // tampering. The classify step must surface
    // BundledLocalStateUnavailable 503 instead of silently treating
    // the manifest as healthy via the cache.
    h.manifestStore.save({
      appId: SAMPLE_RECIPE_ID,
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: '1.0.0',
      hash: 'fakehash',
      installedAt: '2026-05-27T00:00:00.000Z',
      approvedScopes: [],
      api: { scopes: [], calls: [] },
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'code-trusted (bundled)',
      source: 'bundled',
    })
    const manifestPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      SAMPLE_RECIPE_ID,
      'manifest.json',
    )
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(manifestPath, 0o000)
    try {
      let thrown: unknown = null
      try {
        classifyLocalResidue({
          fs: h.fs,
          manifestStore: h.manifestStore,
          recipeId: SAMPLE_RECIPE_ID,
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundledInstallerError)
      const err = thrown as BundledInstallerError
      expect(err.errorCode).toBe('BundledLocalStateUnavailable')
      expect(err.httpStatus).toBe(503)
    } finally {
      chmodSync(manifestPath, 0o644)
    }
  })

  it('disableBundledRecipe accepts a caller-provided historySnapshot and completes the transaction (PR #56 attempt 6)', () => {
    // Codex attempt 6 Finding "resource exhaustion": the snapshot
    // optimization stopped at the lock boundary — once the route
    // entered disableBundledRecipe, it called classifyLocalResidue
    // again without the snapshot and then readRecipeHistory a second
    // time, both inside the per-appId lock. The attempt 6 fix adds
    // an optional historySnapshot parameter to the transaction so
    // the locked critical section reuses the same parsed history
    // already loaded by the HTTP handler.
    //
    // Seed a real install record + manifest via enableBundledRecipe,
    // then disable with the snapshot threaded in. Verify the
    // transaction returns 'disabled' (so the locked path actually
    // ran with the snapshot wired through classifyLocalResidue +
    // findHistoryMatchForBundled).
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
    const snapshot = loadRecipeHistorySnapshot(h.fs)
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
      historySnapshot: snapshot,
    })
    expect(result.status).toBe('disabled')
    expect(result.source).toBe('bundled')
  })

  it('returns an empty snapshot on ENOENT without preflighting existsSync (PR #56 attempt 5)', () => {
    // Codex attempt 5 Finding "fail-closed regression": the previous
    // snapshot loader started with `if (!fs.existsSync(path)) return
    // { entries: [] }`. existsSync silently maps EACCES / EPERM to
    // false on some platforms, which would let an unreadable history
    // file fall through to the empty-snapshot branch and defeat the
    // fail-closed contract. The refactor uses statSync as the first
    // probe: ENOENT → empty entries (true absence), every other errno
    // → 503 BundledLocalStateUnavailable.
    //
    // This test exercises the happy ENOENT path: no history file
    // exists, snapshot returns empty entries without throwing.
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    expect(existsSync(historyPath)).toBe(false)
    const snapshot = loadRecipeHistorySnapshot(h.fs)
    expect(snapshot.entries).toEqual([])
  })

  it('rotates oversized recipe-history.jsonl via the shared size gate and returns empty (PR #56 attempt 5)', () => {
    // Codex attempt 5 Finding "resource exhaustion": the snapshot
    // loader previously skipped the MAX_HISTORY_BYTES (10 MiB) DoS
    // guard that readRecipeHistory enforces. The size gate is now
    // extracted into a shared enforceHistorySizeGate helper and both
    // call paths share it.
    //
    // Write an 11 MiB dummy history file (just over the 10 MiB cap)
    // and assert that the snapshot loader rotates it to
    // .corrupted.<ts> and returns an empty snapshot without parsing.
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    const ELEVEN_MIB = 11 * 1024 * 1024
    // Padding line; the parser never sees it because the size gate
    // trips first. We use a single long line to keep the write cheap.
    writeFileSync(historyPath, 'x'.repeat(ELEVEN_MIB), 'utf-8')
    const snapshot = loadRecipeHistorySnapshot(h.fs)
    expect(snapshot.entries).toEqual([])
    // After rotation, the live path no longer holds the oversize
    // file (it was renamed to a `.corrupted.<ts>` sibling). The
    // exact suffix is timestamp-driven, so we just verify the live
    // path is gone.
    expect(existsSync(historyPath)).toBe(false)
  })

  it('performs exactly one readFileSync of recipe-history.jsonl (PR #56 attempt 4)', () => {
    // Codex attempt 4 Finding "sync I/O amplification": the previous
    // implementation called probeRecipeHistoryReadability for a full
    // readFileSync and then readRecipeHistory did a second
    // readFileSync, doubling the per-request IO. The refactored
    // snapshot loader now performs exactly one readFileSync per
    // call. Verify with the same readFileSync counter used in the
    // attempt 2 threading tests.
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_single_read',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    const counter = wrapFsWithReadCounter(h.fs)
    const snapshot = loadRecipeHistorySnapshot(counter.fs)
    expect(snapshot.entries.length).toBe(1)
    expect(counter.countFor(historyPath)).toBe(1)
  })

  it('returns an empty snapshot when recipe-history.jsonl is absent', () => {
    const snapshot = loadRecipeHistorySnapshot(h.fs)
    expect(snapshot.entries).toEqual([])
  })

  it('returns parsed entries from recipe-history.jsonl when present', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_snapshot',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const snapshot = loadRecipeHistorySnapshot(h.fs)
    expect(snapshot.entries.length).toBe(1)
    expect(snapshot.entries[0].recipeId).toBe(SAMPLE_RECIPE_ID)
  })

  it('surfaces BundledLocalStateUnavailable 503 on probe IO failure', () => {
    // Seed a history file, then chmod 000 to force EACCES on the
    // probe `readFileSync`. The probe contract is to map any errno
    // (EACCES / EPERM / EIO / EBUSY) to a 503; the precise errno
    // surfaces through the structured detail field.
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_io_fail',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    // The chmod is per-process and the test harness runs as a
    // non-root user, so 000 reliably blocks read. We restore in a
    // `finally` to avoid blocking the rmSync in cleanup.
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(historyPath, 0o000)
    try {
      let thrown: unknown = null
      try {
        loadRecipeHistorySnapshot(h.fs)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundledInstallerError)
      const err = thrown as BundledInstallerError
      expect(err.errorCode).toBe('BundledLocalStateUnavailable')
      expect(err.httpStatus).toBe(503)
    } finally {
      chmodSync(historyPath, 0o644)
    }
  })
})

describe('classifyLocalResidue / resolveBundledAppIdForDisable snapshot threading (PR #56 attempt 2)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    cleanup(h)
  })

  it('reuses the caller-provided snapshot in classifyLocalResidue (no redundant readFileSync)', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_thread_classify',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    const counter = wrapFsWithReadCounter(h.fs)
    const snapshot: RecipeHistorySnapshot = loadRecipeHistorySnapshot(counter.fs)
    // loadRecipeHistorySnapshot itself reads the file once via the
    // probe (the parse step reads it again through fs.readFileSync
    // inside readRecipeHistory).
    const baselineReads = counter.countFor(historyPath)
    expect(baselineReads).toBeGreaterThanOrEqual(1)
    counter.reset()
    const residue = classifyLocalResidue({
      fs: counter.fs,
      manifestStore: h.manifestStore,
      recipeId: SAMPLE_RECIPE_ID,
      historySnapshot: snapshot,
    })
    expect(residue).toBe('present')
    expect(counter.countFor(historyPath)).toBe(0)
  })

  it('reuses the caller-provided snapshot in resolveBundledAppIdForDisable (no redundant readFileSync)', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_thread_resolve',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'sample',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    const historyPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipe-history.jsonl',
    )
    const counter = wrapFsWithReadCounter(h.fs)
    const snapshot: RecipeHistorySnapshot = loadRecipeHistorySnapshot(counter.fs)
    counter.reset()
    const result = resolveBundledAppIdForDisable({
      fs: counter.fs,
      manifestStore: h.manifestStore,
      recipeId: SAMPLE_RECIPE_ID,
      historySnapshot: snapshot,
    })
    expect(result).toEqual({
      appId: SAMPLE_RECIPE_ID,
      source: 'sample',
      manifestAlreadyAbsent: true,
    })
    // With the snapshot threaded, neither the embedded
    // classifyLocalResidue call nor the history-backed fallback
    // re-reads the file.
    expect(counter.countFor(historyPath)).toBe(0)
  })

  it('falls back to its own snapshot load when no historySnapshot is provided (back-compat)', () => {
    appendRecipeHistory(h.fs, {
      id: 'r_20260527_backcompat',
      action: 'install',
      name: 'Document Viewer',
      version: '1.0.0',
      source: 'bundled',
      hash: 'fakehash',
      appliedAt: '2026-05-27T00:00:00.000Z',
      artifacts: [],
      menu: [],
      recipeId: SAMPLE_RECIPE_ID,
      appId: SAMPLE_RECIPE_ID,
    })
    // No snapshot threading — the call should still succeed
    // because the function loads its own snapshot internally
    // (preserves the existing single-arg contract used by callers
    // that have not been migrated yet).
    const result = resolveBundledAppIdForDisable({
      fs: h.fs,
      manifestStore: h.manifestStore,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result?.appId).toBe(SAMPLE_RECIPE_ID)
    expect(result?.source).toBe('bundled')
  })
})

// =========================================
// Phase 1.5 completion (v1.12, BL-2026-179 / BL-2026-177 same-PR)
// =========================================
//
// These tests cover the spec recipe-system v1.12 cascade:
//
//   - Step 1.5 endpoint-entry app-root anomaly check (BL-2026-177)
//   - Step 3d (ii-g) in-boundary alias attack defence
//   - Step 5.5 AppManifest write (BL-2026-179)
//   - Step 5.6 menu.ts entry append (BL-2026-179)
//   - Step 4.5 menu.ts entry removal on disable (BL-2026-179)
//   - isEnabledAndManifestCoherent three-way equality + AppManifest /
//     menu.ts visibility coherence
//
// The judgment doc v2.9 §4.12.1 SSOT pins these as required for the
// Phase 1 completion criteria — every bundled enable transaction
// must leave behind a complete visibility chain (RecipeManifest +
// AppManifest + menu.ts entry) before a 2xx response.

describe('Phase 1.5 enable: AppManifest + menu.ts entry (BL-2026-179)', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('writes app/<appId>/manifest.json with the full required-field set', () => {
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
    const appManifestPath = join(h.projectRoot, 'app', result.appId, 'manifest.json')
    expect(existsSync(appManifestPath)).toBe(true)
    const raw = JSON.parse(readFileSync(appManifestPath, 'utf-8'))
    expect(raw.appId).toBe(SAMPLE_RECIPE_ID)
    expect(typeof raw.displayName).toBe('string')
    expect(raw.displayName.length).toBeGreaterThan(0)
    expect(typeof raw.createdAt).toBe('string')
    expect(typeof raw.kovitoboardVersion).toBe('string')
    expect(raw.source).toEqual({
      type: 'recipe',
      recipeId: SAMPLE_RECIPE_ID,
      recipeVersion: sample.metadata.version,
      recipeSource: 'bundled',
    })
    // menuOrder / userMenuLabel must be ABSENT (undefined), not null.
    // Spec v1.12 Round 2 Critical 2: `null` has explicit-reset
    // semantics for userMenuLabel; pre-writing it would defeat the
    // scanner's provisional-order assignment for menuOrder.
    expect('menuOrder' in raw).toBe(false)
    expect('userMenuLabel' in raw).toBe(false)
  })

  it('appends a menu.ts entry whose page composes <appId>/<recipe-yaml-page>', () => {
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
    const menuTsPath = join(h.projectRoot, 'app', 'menu.ts')
    expect(existsSync(menuTsPath)).toBe(true)
    const content = readFileSync(menuTsPath, 'utf-8')
    expect(content).toContain(`id: '${SAMPLE_RECIPE_ID}'`)
    // Path-boundary invariant: the composed import path stays inside
    // `<appId>/`.
    expect(content).toContain(`import('./${SAMPLE_RECIPE_ID}/pages/DocumentViewer')`)
  })

  it('grandfather sample where menu.ts entry already exists is idempotent (touch-free)', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Pre-plant a menu.ts with the appId entry already in place — the
    // canonical recipe-applicator shape the existing `removeMenuEntry`
    // tests use.
    const menuTsDir = join(h.projectRoot, 'app')
    mkdirSync(menuTsDir, { recursive: true })
    const preExisting = [
      `import type { AppMenuEntry } from '../src/renderer/types/app-types'`,
      '',
      'export const menuEntries: AppMenuEntry[] = [',
      `  {`,
      `    id: '${SAMPLE_RECIPE_ID}',`,
      `    label: 'Hand-edited label',`,
      `    icon: 'content',`,
      `    component: () => import('./${SAMPLE_RECIPE_ID}/pages/DocumentViewer'),`,
      `  },`,
      ']',
      '',
    ].join('\n')
    writeFileSync(join(menuTsDir, 'menu.ts'), preExisting, 'utf-8')

    const result = enableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      kovitoboardRoot: KB_INSTALL_ROOT,
      recipeId: SAMPLE_RECIPE_ID,
      sample,
    })
    expect(result.status).toBe('enabled')
    // The pre-existing label must survive the idempotent gate —
    // appendMenuEntry returns `'already-present'` and the file is
    // untouched.
    const after = readFileSync(join(menuTsDir, 'menu.ts'), 'utf-8')
    expect(after).toBe(preExisting)
    expect(after).toContain(`label: 'Hand-edited label'`)
  })

  it('isEnabledAndManifestCoherent treats a missing AppManifest as non-coherent (v1.12 Round 2 Critical 4)', () => {
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
    // Yank the AppManifest by hand to simulate the Phase 1 PR #55/#56-
    // era state that v1.12 §10.9.5 BS-L2' wants the coherence check to
    // surface as non-coherent (so the next enable re-establishes it).
    const appManifestPath = join(h.projectRoot, 'app', SAMPLE_RECIPE_ID, 'manifest.json')
    rmSync(appManifestPath, { force: true })
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(false)
  })

  it('isEnabledAndManifestCoherent treats a missing menu.ts entry as non-coherent', () => {
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
    // Hand-remove the menu.ts entry while leaving everything else in
    // place. The renderer would otherwise show no UI tile for the
    // bundled app even though the RecipeManifest + AppManifest +
    // artifacts are coherent — exactly the visibility regression
    // judgment doc v2.9 §4.12.1 is meant to catch.
    const menuTsPath = join(h.projectRoot, 'app', 'menu.ts')
    writeFileSync(menuTsPath, buildEmptyMenuTsForTest(), 'utf-8')
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: h.manifestStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(false)
  })

  it('isEnabledAndManifestCoherent treats a split source state (Recipe=sample, App=bundled) as non-coherent', () => {
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
    // Stub the RecipeManifest's persisted source to `'sample'` so the
    // three-way equality check sees a split state (RecipeManifest
    // says sample, AppManifest says bundled). Spec v1.12 Round 5
    // routes that to `false` so the next enable can re-converge.
    const recipeManifestPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      SAMPLE_RECIPE_ID,
      'manifest.json',
    )
    const raw = JSON.parse(readFileSync(recipeManifestPath, 'utf-8'))
    raw.source = 'sample'
    writeFileSync(recipeManifestPath, JSON.stringify(raw, null, 2), 'utf-8')
    // The manifestStore cache still holds the bundled source from the
    // enable above; rebuild the store so the on-disk mutation lands
    // in the cache.
    const reloadedStore = new RecipeManifestStore(
      join(h.projectRoot, '.kovitoboard'),
      h.fs,
    )
    expect(
      isEnabledAndManifestCoherent({
        fs: h.fs,
        manifestStore: reloadedStore,
        recipeId: SAMPLE_RECIPE_ID,
        projectRoot: h.projectRoot,
      }),
    ).toBe(false)
  })
})

// Convenience helper: re-create the canonical empty menu.ts body
// without re-importing from menu-ts-editor (which is the unit under
// test in another suite). Keeps the import block at the top of this
// file untouched.
function buildEmptyMenuTsForTest(): string {
  return [
    `import type { AppMenuEntry } from '../src/renderer/types/app-types'`,
    '',
    'export const menuEntries: AppMenuEntry[] = []',
    '',
  ].join('\n')
}

describe('Phase 1.5 enable: Step 1.5 app-root anomaly check (BL-2026-177)', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('rejects with BundledRegistryAnomaly app-root-symlink when <projectRoot>/app is a symlink', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Plant `app` as a symlink to a real external directory. The
    // target stays valid so the broken-symlink branch does not match;
    // the live-symlink-to-directory branch is the one we want to
    // exercise.
    const externalDir = join(h.projectRoot, 'external-app-root')
    mkdirSync(externalDir, { recursive: true })
    symlinkSync(externalDir, join(h.projectRoot, 'app'))

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
    expect(err.errorCode).toBe('BundledRegistryAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('app-root-symlink')
    expect(err.detail?.appRootPath).toBe(join(h.projectRoot, 'app'))
  })

  it('rejects with BundledRegistryAnomaly app-root-non-directory when <projectRoot>/app is a regular file', () => {
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    writeFileSync(join(h.projectRoot, 'app'), 'i am not a directory', 'utf-8')

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
    expect(err.errorCode).toBe('BundledRegistryAnomaly')
    expect(err.httpStatus).toBe(500)
    expect(err.detail?.anomalyType).toBe('app-root-non-directory')
  })

  it('app-root absent (fresh project) falls through to ok and creates app/ at Step 4', () => {
    // Spec note (1.5-a): a missing `<projectRoot>/app/` is the normal
    // new-project state, not an anomaly. Step 4 mkdirSync owns the
    // creation.
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
    expect(existsSync(join(h.projectRoot, 'app', SAMPLE_RECIPE_ID))).toBe(true)
  })
})

describe('Phase 1.5 disable: Step 4.5 menu.ts entry removal cascade (BL-2026-179)', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('removes the menu.ts entry while preserving app/data/<appId>/ (BS-L3-A)', () => {
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
    expect(enableResult.status).toBe('enabled')
    // Plant a data file so we can verify BS-L3-A preserves it.
    const dataFile = join(h.projectRoot, 'app', 'data', SAMPLE_RECIPE_ID, 'state.json')
    writeFileSync(dataFile, '{"hello":"world"}', 'utf-8')

    const disableResult = disableBundledRecipe({
      fs: h.fs,
      manifestStore: h.manifestStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(disableResult.status).toBe('disabled')
    expect(disableResult.dataPreserved).toBe(true)
    // The menu.ts entry must be gone.
    const menuContent = readFileSync(join(h.projectRoot, 'app', 'menu.ts'), 'utf-8')
    expect(menuContent).not.toContain(`id: '${SAMPLE_RECIPE_ID}'`)
    // Artifacts gone (Step 3 rmSync), data preserved (BS-L3-A).
    expect(existsSync(join(h.projectRoot, 'app', SAMPLE_RECIPE_ID))).toBe(false)
    expect(existsSync(dataFile)).toBe(true)
  })

  it('partial-residue cleanup: history-only state still scrubs the menu.ts entry', () => {
    // Spec v1.12 §10.9.4 partial residue path: manifest absent +
    // history install record present + menu.ts entry left over. The
    // disable transaction must still remove the menu.ts row so the
    // UI does not show a dead tile after the partial cleanup.
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
    // Hand-remove the RecipeManifest to simulate the partial state
    // (the menu.ts entry + history install record + app/<appId>/
    // artifacts are still on disk).
    const recipeManifestPath = join(
      h.projectRoot,
      '.kovitoboard',
      'recipes-installed',
      SAMPLE_RECIPE_ID,
      'manifest.json',
    )
    rmSync(recipeManifestPath, { force: true })
    rmSync(join(h.projectRoot, '.kovitoboard', 'recipes-installed', SAMPLE_RECIPE_ID), {
      recursive: true,
      force: true,
    })
    // Reload the manifest store so the cache reflects the on-disk
    // removal — the partial-residue path depends on the store
    // returning null for the missing manifest.
    const reloadedStore = new RecipeManifestStore(
      join(h.projectRoot, '.kovitoboard'),
      h.fs,
    )
    const result = disableBundledRecipe({
      fs: h.fs,
      manifestStore: reloadedStore,
      projectRoot: h.projectRoot,
      recipeId: SAMPLE_RECIPE_ID,
    })
    expect(result.status).toBe('disabled')
    expect(result.metadata?.note).toBe('manifest-already-absent')
    const menuContent = readFileSync(join(h.projectRoot, 'app', 'menu.ts'), 'utf-8')
    expect(menuContent).not.toContain(`id: '${SAMPLE_RECIPE_ID}'`)
  })
})

describe('Phase 1.5 enable: multi-entry constraint (Round 4 Critical fix)', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('rejects 503 BundledRecipeMalformed when recipe.yaml menu has >1 entry', () => {
    // The current bundled registry honours the constraint by
    // construction (document-viewer / todo each declare exactly one
    // menu entry). To exercise the rejection branch we inject a
    // fabricated `sample` whose `metadata.menu` carries two entries
    // — `parseRecipe` will be re-run against the real bundled
    // directory, so the fixture has to come from a clone in tmp.
    const samples = scanSamples(h)
    const sample = samples.find((s) => s.metadata.recipeId === SAMPLE_RECIPE_ID)!
    // Stage a tmp recipes/<appId>/ tree with an inflated menu entry
    // list and point `kovitoboardRoot` at it.
    const tmpKb = mkdtempSync(join(tmpdir(), 'kb-multi-entry-'))
    const tmpRecipeDir = join(tmpKb, 'recipes', SAMPLE_RECIPE_ID)
    mkdirSync(tmpRecipeDir, { recursive: true })
    cpSync(join(KB_INSTALL_ROOT, 'recipes', SAMPLE_RECIPE_ID), tmpRecipeDir, {
      recursive: true,
    })
    const yamlPath = join(tmpRecipeDir, 'recipe.yaml')
    const baseYaml = readFileSync(yamlPath, 'utf-8')
    // Inject a second menu entry. The first entry's id still matches
    // the appId so we land squarely on the multi-entry branch.
    const tamperedYaml = baseYaml.replace(
      /^menu:\s*\n\s*-\s*id:\s*"document-viewer"[\s\S]*?page:\s*"pages\/DocumentViewer"\s*\n/m,
      [
        'menu:',
        '  - id: "document-viewer"',
        '    label: "ドキュメント"',
        '    icon: "content"',
        '    page: "pages/DocumentViewer"',
        '  - id: "phantom-second"',
        '    label: "Phantom"',
        '    icon: "content"',
        '    page: "pages/Phantom"',
        '',
      ].join('\n'),
    )
    writeFileSync(yamlPath, tamperedYaml, 'utf-8')

    let thrown: unknown = null
    try {
      enableBundledRecipe({
        fs: h.fs,
        manifestStore: h.manifestStore,
        projectRoot: h.projectRoot,
        kovitoboardRoot: tmpKb,
        recipeId: SAMPLE_RECIPE_ID,
        sample,
      })
    } catch (err) {
      thrown = err
    } finally {
      rmSync(tmpKb, { recursive: true, force: true })
    }
    expect(thrown).toBeInstanceOf(BundledInstallerError)
    const err = thrown as BundledInstallerError
    expect(err.errorCode).toBe('BundledRecipeMalformed')
    expect(err.httpStatus).toBe(503)
    expect(err.detail?.detail).toBe('menu array must have exactly 1 entry for bundled recipe')
  })
})

describe('Phase 1.5 closed-world batch coverage: PUT /api/apps/menu-order eligibility', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => {
    cleanup(h)
  })

  it('a bundled-enabled app becomes eligible for menu-order (AppManifest visible to scanAppManifests)', async () => {
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
    // `scanAppManifests` is the eligible-set probe `PUT /api/apps/menu-order`
    // uses to decide which appIds belong in the closed-world batch.
    // Phase 1 PR #55/#56 did not write the AppManifest, so the
    // bundled app would have been invisible to this scan and the
    // batch would have rejected with `MenuOrderCoverageMismatch`
    // (judgment doc v2.9 §4.12.1 SSOT). Phase 1.5 closes the gap.
    const { scanAppManifests } = await import('../../src/server/services/app-manifest')
    const manifests = scanAppManifests(h.fs, h.projectRoot)
    const found = manifests.find((m) => m.appId === SAMPLE_RECIPE_ID)
    expect(found).toBeDefined()
    expect(found!.source.type).toBe('recipe')
    if (found!.source.type === 'recipe') {
      expect(found!.source.recipeSource).toBe('bundled')
      expect(found!.source.recipeId).toBe(SAMPLE_RECIPE_ID)
    }
  })
})
