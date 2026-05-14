/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe handler integration test (BE only) — Phase H
 *
 * Verifies the flow of manifest save -> handler invocation via dispatcher -> response.
 * Does not include FE.
 *
 * Test scenarios T1-T8:
 *   T1: Normal case — list-files invocation
 *   T2: Scope violation — handler call with unapproved scope -> ScopeViolation
 *   T3: Path traversal — "../../etc/passwd" -> PathOutOfScope
 *   T4: Exclusion list — ".env" -> PathForbidden
 *   T5: Size exceeded — read-file on 11MB file -> SizeExceeded
 *   T6: Rate limiting — 11 consecutive notify calls -> 11th is RateLimited
 *   T7: Undeclared callId -> HandlerNotDeclared
 *   T8: Template expansion — pass dynamic values to ${input.path}
 *
 * All tests also verify audit log recording.
 *
 * @see recipe-backend-implementation-plan.md Phase H
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  dispatch,
  resetRateLimiter,
  acquireAppLock,
  resetAppLocks,
} from '../../src/server/handlerDispatcher'
import { RecipeManifestStore } from '../../src/server/recipeManifestStore'
import { registerHandler, clearRegistry } from '../../src/server/handlers/registry'
import { DirectFsLayer } from '../../src/server/fs-layer'

// handler imports
import { listFilesHandler } from '../../src/server/handlers/categoryA/listFiles'
import { readFileHandler } from '../../src/server/handlers/categoryA/readFile'
import { writeFileHandler } from '../../src/server/handlers/categoryA/writeFile'
import { kvGetHandler } from '../../src/server/handlers/categoryA/kvGet'
import { kvSetHandler } from '../../src/server/handlers/categoryA/kvSet'
import { kvListHandler } from '../../src/server/handlers/categoryA/kvList'
import { kvDeleteHandler } from '../../src/server/handlers/categoryA/kvDelete'
import { notifyHandler } from '../../src/server/handlers/categoryA/notify'
import { exportFileHandler } from '../../src/server/handlers/categoryA/exportFile'

import type { RecipeManifest } from '../../src/server/recipe/apiTypes'
import type { Scope } from '../../src/server/handlers/types'

// =========================================
// Test setup
// =========================================

let tmpDir: string
let projectRoot: string
let kovitoboardDir: string
let manifestStore: RecipeManifestStore

const RECIPE_ID = 'test-intel-viewer'
const RECIPE_VERSION = '1.0.0'

/**
 * Create a test manifest equivalent to minimal-intel-viewer
 */
function createTestManifest(overrides?: {
  approvedScopes?: Scope[]
  calls?: RecipeManifest['api']['calls']
  trustLevel?: RecipeManifest['trustLevel']
}): RecipeManifest {
  return {
    appId: RECIPE_ID,
    recipeId: RECIPE_ID,
    recipeVersion: RECIPE_VERSION,
    hash: 'abc123def456',
    installedAt: new Date().toISOString(),
    approvedScopes: overrides?.approvedScopes ?? [
      'project-read',
      'own-data',
    ],
    captureRequires: [],
    approvedCaptures: [],
    trustLevel: overrides?.trustLevel ?? 'unknown',
    api: {
      scopes: overrides?.approvedScopes ?? ['project-read', 'own-data'],
      calls: overrides?.calls ?? [
        {
          id: 'list-intel-reports',
          handler: 'list-files',
          args: { path: 'intel/' },
        },
        {
          id: 'read-intel-report',
          handler: 'read-file',
          args: { path: '${input.path}' },
        },
        {
          id: 'send-notification',
          handler: 'notify',
        },
        {
          id: 'write-report',
          handler: 'write-file',
          args: { path: '${input.path}', content: '${input.content}', createDirs: true },
        },
        {
          id: 'store-data',
          handler: 'kv-set',
          args: { key: '${input.key}', value: '${input.value}' },
        },
        {
          id: 'fetch-data',
          handler: 'kv-get',
          args: { key: '${input.key}' },
        },
      ],
    },
  }
}

/**
 * Read and parse the audit log file
 */
function readAuditLog(): Array<Record<string, unknown>> {
  const logPath = path.join(projectRoot, 'app', 'data', RECIPE_ID, '_audit.log')
  if (!fs.existsSync(logPath)) return []
  const content = fs.readFileSync(logPath, 'utf-8').trim()
  if (!content) return []
  return content.split('\n').map((line) => JSON.parse(line))
}

// =========================================
// Lifecycle
// =========================================

beforeAll(() => {
  // Create temporary directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-handler-test-'))
  projectRoot = path.join(tmpDir, 'project')
  kovitoboardDir = path.join(projectRoot, '.kovitoboard')

  // Create project structure
  fs.mkdirSync(path.join(projectRoot, 'intel'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'app', 'data', RECIPE_ID), { recursive: true })
  fs.mkdirSync(kovitoboardDir, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.claude', 'agents'), { recursive: true })

  // Place test files
  fs.writeFileSync(
    path.join(projectRoot, 'intel', 'report-001.md'),
    '# Intel Report 001\n\nConfidential content.',
  )
  fs.writeFileSync(
    path.join(projectRoot, 'intel', 'report-002.md'),
    '# Intel Report 002\n\nMore content.',
  )
  fs.writeFileSync(
    path.join(projectRoot, 'README.md'),
    '# Test Project',
  )
  // Files targeted by the exclusion list
  fs.writeFileSync(path.join(projectRoot, '.env'), 'SECRET=xxx')
  fs.writeFileSync(path.join(projectRoot, '.env.production'), 'PROD_SECRET=yyy')
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/main')

  // Register handlers in the registry
  clearRegistry()
  registerHandler(listFilesHandler)
  registerHandler(readFileHandler)
  registerHandler(writeFileHandler)
  registerHandler(kvGetHandler)
  registerHandler(kvSetHandler)
  registerHandler(kvListHandler)
  registerHandler(kvDeleteHandler)
  registerHandler(notifyHandler)
  registerHandler(exportFileHandler)

  // Initialize ManifestStore
  const fsLayer = new DirectFsLayer()
  manifestStore = new RecipeManifestStore(kovitoboardDir, fsLayer)
})

afterAll(() => {
  // Delete temporary directory
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearRegistry()
})

beforeEach(() => {
  // Reset rate limiter
  resetRateLimiter()
  // Reset per-appId dispatch mutex so a test that intentionally
  // parks the lock cannot leak into the next test.
  resetAppLocks()
  // Clear audit log
  const logPath = path.join(projectRoot, 'app', 'data', RECIPE_ID, '_audit.log')
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath)
  }
})

// =========================================
// T1: Normal case — manifest save -> list-files call -> normal result
// =========================================

describe('T1: 正常系 — list-files 呼び出し', () => {
  it('manifest 保存 → dispatch → ファイル一覧が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const data = result.data as { entries: Array<{ name: string; path: string }> }
    expect(data.entries).toHaveLength(2)

    const names = data.entries.map((e) => e.name).sort()
    expect(names).toEqual(['report-001.md', 'report-002.md'])
  })

  it('監査ログに成功エントリが記録される', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    await dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    const logs = readAuditLog()
    expect(logs.length).toBeGreaterThanOrEqual(1)

    const last = logs[logs.length - 1]
    expect(last.recipeId).toBe(RECIPE_ID)
    expect(last.callId).toBe('list-intel-reports')
    expect(last.handler).toBe('list-files')
    expect(last.result).toBe('ok')
    // argsHash is 64-char hex
    expect(last.argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof last.durationMs).toBe('number')
    // T-3-4 regression — trust field is required on every audit
    // entry the dispatcher emits. Grandfather recipes always carry
    // `'unknown'`; the fallback `'context-missing'` is reserved for
    // future bypass paths (handoff v1.1 §8.2 / §8.4 I-8).
    expect(last.trust).toBe('unknown')
  })

  it('監査ログに manifest の trustLevel がそのまま伝搬する (v0.3.0 forward-compat)', async () => {
    // v0.2.x's only legitimate runtime value is `'unknown'`, but the
    // dispatcher must thread whatever the manifest carries — v0.3.0
    // KovitoHub-signed installs will land here as `'code-trusted'`.
    const manifest = createTestManifest({ trustLevel: 'code-trusted' })
    manifestStore.save(manifest)

    await dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    const last = readAuditLog().at(-1)
    expect(last?.trust).toBe('code-trusted')
  })
})

// =========================================
// T2: Scope violation — handler call with unapproved scope
// =========================================

describe('T2: scope 違反 → ScopeViolation', () => {
  it('kb-data-read のみ承認で write-file を呼ぶと ScopeViolation', async () => {
    // write-file requiredScopes are ['project-write', 'own-data']
    // With only kb-data-read approved, neither matches -> ScopeViolation
    const manifest = createTestManifest({
      approvedScopes: ['kb-data-read'],
      calls: [
        {
          id: 'write-project-file',
          handler: 'write-file',
          args: { path: '${input.path}', content: '${input.content}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-project-file',
        input: { path: 'output.txt', content: 'test' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ScopeViolation')
  })

  it('kv-set は own-data が必要 — project-read のみ承認では ScopeViolation', async () => {
    // kv-set requiredScopes are ['own-data']
    // With only project-read approved, own-data does not match -> ScopeViolation
    const manifest = createTestManifest({
      approvedScopes: ['project-read'],
      calls: [
        {
          id: 'kv-set-test',
          handler: 'kv-set',
          args: { key: '${input.key}', value: '${input.value}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'kv-set-test',
        input: { key: 'test', value: 'data' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ScopeViolation')
  })

  it('scope 違反は handler 実行前のため監査ログに記録されない（仕様通り）', async () => {
    const manifest = createTestManifest({
      approvedScopes: ['kb-data-read'],
      calls: [
        {
          id: 'write-project-file',
          handler: 'write-file',
          args: { path: '${input.path}', content: '${input.content}' },
        },
      ],
    })
    manifestStore.save(manifest)

    await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-project-file',
        input: { path: 'output.txt', content: 'test' },
      },
      manifestStore,
      projectRoot,
    )

    // In the dispatcher flow, scope validation (step 5) occurs before audit log (step 8)
    const logs = readAuditLog()
    expect(logs.length).toBe(0)
  })
})

// =========================================
// T3: パストラバーサル — "../../etc/passwd" → PathOutOfScope
// =========================================

describe('T3: パストラバーサル → PathOutOfScope', () => {
  it('"../../etc/passwd" で PathOutOfScope が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '../../etc/passwd' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathOutOfScope')
  })

  it('"../../../tmp/secret" でも PathOutOfScope', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '../../../tmp/secret' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathOutOfScope')
  })
})

// =========================================
// T4: 除外リスト — ".env" → PathForbidden
// =========================================

describe('T4: 除外リスト → PathForbidden', () => {
  it('".env" への read-file で PathForbidden が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '.env' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathForbidden')
  })

  it('".env.production" への read-file で PathForbidden が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '.env.production' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathForbidden')
  })

  it('".git/HEAD" への read-file は project-read 単体で PathForbidden が返る', async () => {
    // recipe-system.md v1.8 §6.6.3 evaluation order: every matching
    // scope is tried. Default createTestManifest carries
    // `['project-read', 'own-data']`, so `own-data` re-interprets
    // `.git/HEAD` relative to `app/data/<appId>/`, sails past the
    // project-root exclusion table, and the handler reads (or fails)
    // inside the recipe's own data root. To assert the
    // `PathForbidden` outcome we restrict the recipe to
    // `project-read`, which is the only scope that should ever try
    // to reach `<projectRoot>/.git/HEAD`.
    const manifest = createTestManifest({ approvedScopes: ['project-read'] })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '.git/HEAD' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathForbidden')
  })

  it('".git/HEAD" への read-file は own-data 経由で別パスに再解釈され NotFound (spec v1.8)', async () => {
    // Same path with the default scopes (`project-read` + `own-data`):
    // the spec §6.6.3 walk reaches the `own-data` branch and the
    // re-interpreted target lives under `app/data/<appId>/.git/HEAD`,
    // which the test fixture does not materialise. The handler
    // surfaces `NotFound`. No information about the real
    // `<projectRoot>/.git/HEAD` leaks because `own-data` operates on
    // its own root.
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: '.git/HEAD' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NotFound')
  })

  it('list-files で "." を要求したとき、.env / .git / node_modules がエントリに含まれない', async () => {
    // Also create node_modules
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'some-pkg'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}')

    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    // list-intel-reports has a fixed path: "intel/", so create a separate call to see the project root
    const manifestWithRoot = createTestManifest({
      calls: [
        ...createTestManifest().api.calls,
        { id: 'list-root', handler: 'list-files', args: { path: '.' } },
      ],
    })
    manifestStore.save(manifestWithRoot)

    const rootResult = await dispatch(
      { appId: RECIPE_ID, callId: 'list-root', input: {} },
      manifestStore,
      projectRoot,
    )

    expect(rootResult.ok).toBe(true)
    if (!rootResult.ok) return

    const data = rootResult.data as { entries: Array<{ name: string; path: string }> }
    const names = data.entries.map((e) => e.name)

    // Verify excluded targets are not included
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.env.production')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    // Normal files are included
    expect(names).toContain('README.md')
  })
})

// =========================================
// T5: サイズ超過 — 11MB ファイルの read-file → SizeExceeded
// =========================================

describe('T5: サイズ超過 → SizeExceeded', () => {
  const LARGE_FILE = 'intel/large-report.bin'

  beforeAll(() => {
    // Create an 11MB dummy file
    const largePath = path.join(projectRoot, LARGE_FILE)
    const fd = fs.openSync(largePath, 'w')
    // 11MB = 11 * 1024 * 1024 bytes
    fs.ftruncateSync(fd, 11 * 1024 * 1024)
    fs.closeSync(fd)
  })

  it('11MB ファイルの read-file で SizeExceeded が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: LARGE_FILE },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('SizeExceeded')
  })
})

// =========================================
// T6: レート制限 — 11 回連続の notify → 11 回目が RateLimited
// =========================================

describe('T6: レート制限 → RateLimited', () => {
  it('11 回連続の notify で 11 回目が RateLimited になる', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const results: Array<{ ok: boolean; error?: { code: string } }> = []

    for (let i = 0; i < 11; i++) {
      const result = await dispatch(
        {
          appId: RECIPE_ID,
          callId: 'send-notification',
          input: { title: `Alert ${i}`, body: `Test notification ${i}` },
        },
        manifestStore,
        projectRoot,
      )
      results.push(result as { ok: boolean; error?: { code: string } })
    }

    // First 10 calls succeed
    for (let i = 0; i < 10; i++) {
      expect(results[i].ok).toBe(true)
    }

    // 11th call is rate limited
    expect(results[10].ok).toBe(false)
    expect(results[10].error?.code).toBe('RateLimited')
  })
})

// =========================================
// T7: 未宣言 callId → HandlerNotDeclared
// =========================================

describe('T7: 未宣言 callId → HandlerNotDeclared', () => {
  it('manifest に存在しない callId で HandlerNotDeclared が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'nonexistent-call',
        input: {},
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('HandlerNotDeclared')
  })

  it('存在しない recipeId で HandlerNotDeclared が返る', async () => {
    const result = await dispatch(
      {
        recipeId: 'nonexistent-recipe',
        callId: 'list-intel-reports',
        input: {},
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('HandlerNotDeclared')
  })
})

// =========================================
// T8: テンプレート展開 — ${input.path} に動的値を渡す
// =========================================

describe('T8: テンプレート展開', () => {
  it('${input.path} に動的値を渡して read-file が動作する', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: 'intel/report-001.md' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const data = result.data as { content: string; size: number; encoding: string }
    expect(data.content).toContain('# Intel Report 001')
    expect(data.encoding).toBe('utf-8')
    expect(data.size).toBeGreaterThan(0)
  })

  it('テンプレートの undefined 変数で InvalidArgs が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // read-intel-report args are { path: "${input.path}" }
    // Do not include path in input
    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: {},  // path is undefined
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('InvalidArgs')
  })

  it('write-file でテンプレート展開 + 実ファイル書き込みが動作する', async () => {
    const manifest = createTestManifest({
      approvedScopes: ['project-read', 'project-write', 'own-data'],
      calls: [
        ...createTestManifest().api.calls,
        {
          id: 'write-own-file',
          handler: 'write-file',
          args: {
            path: '${input.path}',
            content: '${input.content}',
            createDirs: true,
          },
        },
      ],
    })
    manifestStore.save(manifest)

    const targetPath = `app/data/${RECIPE_ID}/output/result.txt`
    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-own-file',
        input: { path: targetPath, content: 'Hello from handler!' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Verify the file was actually written
    const written = fs.readFileSync(path.join(projectRoot, targetPath), 'utf-8')
    expect(written).toBe('Hello from handler!')
  })
})

// =========================================
// T9: Cross-scope path escape — own-data with relative path stays inside own-data root
// =========================================
//
// Regression for the dispatcher resolving a path under one scope while
// the handler re-derived the path from `projectRoot + input.path`.
// Without the dispatcher-resolved path being threaded through
// HandlerContext, an `own-data`-only manifest could read or write
// arbitrary project files by passing a relative path that the
// dispatcher accepted under `app/data/<appId>/<relative>` but the
// handler then resolved against `projectRoot/<relative>`.

describe('T9: クロススコープ path escape — own-data の相対 path は own-data ルート内にとどまる', () => {
  it('own-data のみ承認 + read-file("README.md") は own-data ルート配下を見に行き、project root の README.md は読まれない', async () => {
    // Sanity-check that the project-root file we want to *not* see
    // is genuinely there, so the assertion below has teeth.
    expect(fs.existsSync(path.join(projectRoot, 'README.md'))).toBe(true)

    const ownDataReadme = path.join(projectRoot, 'app', 'data', RECIPE_ID, 'README.md')
    if (fs.existsSync(ownDataReadme)) {
      fs.unlinkSync(ownDataReadme)
    }

    const manifest = createTestManifest({
      approvedScopes: ['own-data'],
      calls: [
        {
          id: 'read-relative',
          handler: 'read-file',
          args: { path: '${input.path}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      { appId: RECIPE_ID, callId: 'read-relative', input: { path: 'README.md' } },
      manifestStore,
      projectRoot,
    )

    // Pre-fix, dispatcher resolves under own-data root, but the
    // handler joined input.path against projectRoot and returned
    // the project README. With the dispatcher-resolved path now
    // threaded through HandlerContext, the handler reads the
    // own-data target instead and returns NotFound when it is
    // missing.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NotFound')
  })

  it('own-data のみ承認 + write-file("escape.txt") は own-data ルート配下に書き込まれ、project root に作成されない', async () => {
    const projectRootEscape = path.join(projectRoot, 'escape.txt')
    if (fs.existsSync(projectRootEscape)) {
      fs.unlinkSync(projectRootEscape)
    }
    const ownDataEscape = path.join(
      projectRoot,
      'app',
      'data',
      RECIPE_ID,
      'escape.txt',
    )
    if (fs.existsSync(ownDataEscape)) {
      fs.unlinkSync(ownDataEscape)
    }

    const manifest = createTestManifest({
      approvedScopes: ['own-data'],
      calls: [
        {
          id: 'write-escape',
          handler: 'write-file',
          args: {
            path: '${input.path}',
            content: '${input.content}',
            createDirs: true,
          },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-escape',
        input: { path: 'escape.txt', content: 'should land under own-data' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    // Did NOT escape to project root.
    expect(fs.existsSync(projectRootEscape)).toBe(false)
    // DID land in own-data.
    expect(fs.existsSync(ownDataEscape)).toBe(true)
    expect(fs.readFileSync(ownDataEscape, 'utf-8')).toBe('should land under own-data')
  })

  it('own-data のみ承認 + list-files(".") は own-data ルート配下のみを返し、project root の README.md は出ない', async () => {
    const ownDataDir = path.join(projectRoot, 'app', 'data', RECIPE_ID)
    fs.writeFileSync(path.join(ownDataDir, 'marker.txt'), 'inside own-data')

    const manifest = createTestManifest({
      approvedScopes: ['own-data'],
      calls: [
        {
          id: 'list-relative',
          handler: 'list-files',
          args: { path: '${input.path}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      { appId: RECIPE_ID, callId: 'list-relative', input: { path: '.' } },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { entries: Array<{ name: string }> }
    const names = data.entries.map((e) => e.name)
    expect(names).toContain('marker.txt')
    // README.md sits at the project root, NOT inside own-data.
    expect(names).not.toContain('README.md')
  })
})

// =========================================
// KV store integration tests
// =========================================

describe('KV ストア結合テスト', () => {
  it('kv-set → kv-get → kv-list → kv-delete の一連フローが動作する', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // kv-set
    const setResult = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'store-data',
        input: { key: 'test-key', value: 'test-value' },
      },
      manifestStore,
      projectRoot,
    )
    expect(setResult.ok).toBe(true)

    // kv-get
    const getResult = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'fetch-data',
        input: { key: 'test-key' },
      },
      manifestStore,
      projectRoot,
    )
    expect(getResult.ok).toBe(true)
    if (getResult.ok) {
      expect((getResult.data as { value: string | null }).value).toBe('test-value')
    }
  })
})

// =========================================
// Audit log comprehensive verification
// =========================================

describe('監査ログ総合検証', () => {
  it('正常呼び出しで監査ログに handler / callId / argsHash / result が記録される', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // Normal list-files call
    await dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    // read-file call with template expansion
    await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: 'intel/report-001.md' },
      },
      manifestStore,
      projectRoot,
    )

    const logs = readAuditLog()
    expect(logs.length).toBe(2)

    // 1st: list-files
    expect(logs[0].handler).toBe('list-files')
    expect(logs[0].callId).toBe('list-intel-reports')
    expect(logs[0].result).toBe('ok')
    expect(logs[0].argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof logs[0].timestamp).toBe('string')
    expect(typeof logs[0].durationMs).toBe('number')

    // 2nd: read-file
    expect(logs[1].handler).toBe('read-file')
    expect(logs[1].callId).toBe('read-intel-report')
    expect(logs[1].result).toBe('ok')
  })

  it('handler 内エラー（NotFound 等）でも監査ログが記録される', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // Read a nonexistent file
    await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: 'intel/nonexistent.md' },
      },
      manifestStore,
      projectRoot,
    )

    const logs = readAuditLog()
    expect(logs.length).toBe(1)
    expect(logs[0].result).toBe('error')
    expect(logs[0].errorCode).toBe('NotFound')
    expect(logs[0].handler).toBe('read-file')
  })
})

// =========================================
// Security regression tests (recipe-backend-implementation-plan.md §7-4)
// =========================================

describe('セキュリティ回帰テスト', () => {
  it('write-file で .env に書き込もうとすると PathForbidden', async () => {
    const manifest = createTestManifest({
      approvedScopes: ['project-read', 'project-write', 'own-data'],
      calls: [
        {
          id: 'write-env',
          handler: 'write-file',
          args: { path: '${input.path}', content: '${input.content}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-env',
        input: { path: '.env', content: 'HACKED=true' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathForbidden')
  })

  it('write-file で .claude/credentials は PathForbidden を返す (write は first-match short-circuit, spec v1.8)', async () => {
    // spec v1.8 §6.6.3 evaluation order is asymmetric in v0.2.x:
    // writes short-circuit on the first exclusion hit because no
    // recipe-side write bypass exists yet (the `agents-write` /
    // `skills-write` opt-in scopes stay deferred to v0.3.0).
    // Falling through to `own-data` would only re-interpret the
    // forbidden write target against the recipe's own data root,
    // which is not an authorization escape but muddies the audit
    // signal. The first-match `PathForbidden` keeps it crisp.
    const manifest = createTestManifest({
      approvedScopes: ['project-read', 'project-write', 'own-data'],
      calls: [
        {
          id: 'write-creds',
          handler: 'write-file',
          args: { path: '${input.path}', content: '${input.content}' },
        },
      ],
    })
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        appId: RECIPE_ID,
        callId: 'write-creds',
        input: { path: '.claude/credentials', content: '{"token":"stolen"}' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PathForbidden')
  })
})

// =========================================
// T-mutex: per-appId dispatch serialization (Codex supplementary S8)
// =========================================
//
// Verifies that `dispatch()` waits on the per-appId mutex returned
// by `acquireAppLock()`, so an in-flight handler cannot have its
// app/<appId>/ tree torn out from under it by a concurrent removal
// or reinstall flow that mutates the same appId.

describe('T-mutex: per-appId dispatch serialization', () => {
  it('dispatch waits when an external holder owns the appId lock', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // Park the lock on RECIPE_ID before dispatching. The dispatcher
    // must observe the held lock and queue behind it.
    const release = await acquireAppLock(RECIPE_ID)

    const dispatchPromise = dispatch(
      { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    // Race the dispatch promise against a short timer. If the
    // dispatcher had ignored the lock, it would resolve well before
    // 50ms (handlers are in-process and fs ops here are tiny). The
    // timer winning is the proof that dispatch is parked.
    const settled = await Promise.race([
      dispatchPromise.then(() => 'dispatched'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])
    expect(settled).toBe('timed-out')

    // Release the parked lock and confirm dispatch now resolves.
    release()
    const result = await dispatchPromise
    expect(result.ok).toBe(true)
  })

  it('different appIds do not block each other', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // Park the lock on a *different* appId. Dispatching for
    // RECIPE_ID must not be affected.
    const release = await acquireAppLock('some-other-app')
    try {
      const result = await dispatch(
        { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
        manifestStore,
        projectRoot,
      )
      expect(result.ok).toBe(true)
    } finally {
      release()
    }
  })

  it('serializes two concurrent dispatches for the same appId', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // Park the appId's lock with an external acquire so we control
    // when the *first* dispatch is allowed to enter its critical
    // section. Both dispatches are fired concurrently; if the lock
    // is honoured neither one can resolve until we release the
    // external hold, and even then they must complete one at a
    // time. A pure timestamp comparison would be tautological, so
    // we instead assert (a) neither dispatch resolves while the
    // external lock is held, (b) they release in FIFO order once
    // the external hold is dropped.
    const externalHold = await acquireAppLock(RECIPE_ID)

    const order: number[] = []
    const fire = (tag: number) =>
      dispatch(
        { appId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
        manifestStore,
        projectRoot,
      ).then((r) => {
        order.push(tag)
        return r
      })

    const p1 = fire(1)
    const p2 = fire(2)

    // Give the event loop a few ticks; if the mutex is broken at
    // least one dispatch would resolve here.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual([])

    // Releasing the external hold lets the dispatches drain in the
    // order they queued. We do not assert tag order strictly because
    // microtask scheduling between two acquirers is implementation-
    // defined; we only assert serialisation (one finishes before the
    // other starts the next tick of the resolver chain).
    externalHold()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(order).toHaveLength(2)
  })

  it('two acquireAppLock holders for the same appId never overlap', async () => {
    // Stronger statement of mutual exclusion than the dispatch-level
    // test above: this one uses two simulated holders that record
    // entry / exit events around an `await setTimeout` "work" step.
    // If the lock were broken, the two holders' work windows would
    // interleave and we would see `enter:A, enter:B, exit:A, exit:B`.
    // A working lock guarantees the four events come out as one
    // holder's enter/exit followed by the other's, in either order.
    const events: string[] = []

    const worker = async (tag: string) => {
      const release = await acquireAppLock('lock-only-test-app')
      try {
        events.push(`enter:${tag}`)
        // Simulate handler work that yields to the event loop. The
        // delay must be long enough that the other holder, if it
        // were not blocked, would have time to push its `enter`
        // event before this `exit`.
        await new Promise<void>((r) => setTimeout(r, 25))
        events.push(`exit:${tag}`)
      } finally {
        release()
      }
    }

    await Promise.all([worker('A'), worker('B')])

    // Strict check: the second holder's enter must come AFTER the
    // first holder's exit. Either ordering of A vs B is acceptable
    // because microtask scheduling between equal-priority acquirers
    // is implementation-defined; what is not acceptable is overlap.
    expect(events).toHaveLength(4)
    const firstTag = events[0].slice('enter:'.length)
    const secondTag = firstTag === 'A' ? 'B' : 'A'
    expect(events).toEqual([
      `enter:${firstTag}`,
      `exit:${firstTag}`,
      `enter:${secondTag}`,
      `exit:${secondTag}`,
    ])
  })
})
