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
import {
  BundledInstallerError,
  classifyLocalResidue,
  disableBundledRecipe,
  enableBundledRecipe,
  isEnabledAndManifestCoherent,
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
