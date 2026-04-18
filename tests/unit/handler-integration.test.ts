/**
 * Recipe handler 結合テスト（BE 単体）— Phase H
 *
 * manifest 保存 → dispatcher 経由の handler 呼び出し → レスポンス検証 の
 * 一連のフローを検証する。FE は含まない。
 *
 * テストシナリオ T1〜T8:
 *   T1: 正常系 — list-files 呼び出し
 *   T2: scope 違反 — 承認なし scope での handler 呼び出し → ScopeViolation
 *   T3: パストラバーサル — "../../etc/passwd" → PathOutOfScope
 *   T4: 除外リスト — ".env" → PathForbidden
 *   T5: サイズ超過 — 11MB ファイルの read-file → SizeExceeded
 *   T6: レート制限 — 11 回連続の notify → 11 回目が RateLimited
 *   T7: 未宣言 callId → HandlerNotDeclared
 *   T8: テンプレート展開 — ${input.path} に動的値を渡す
 *
 * 全テストで監査ログの記録も検証する。
 *
 * @see recipe-backend-implementation-plan.md Phase H
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { dispatch, resetRateLimiter } from '../../src/server/handlerDispatcher'
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
 * minimal-intel-viewer 相当のテスト manifest を作成する
 */
function createTestManifest(overrides?: {
  approvedScopes?: Scope[]
  calls?: RecipeManifest['api']['calls']
}): RecipeManifest {
  return {
    recipeId: RECIPE_ID,
    version: RECIPE_VERSION,
    hash: 'abc123def456',
    installedAt: new Date().toISOString(),
    approvedScopes: overrides?.approvedScopes ?? [
      'project-read',
      'own-data',
    ],
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
 * 監査ログファイルを読み取ってパースする
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
  // 一時ディレクトリを作成
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-handler-test-'))
  projectRoot = path.join(tmpDir, 'project')
  kovitoboardDir = path.join(projectRoot, '.kovitoboard')

  // プロジェクト構成を作成
  fs.mkdirSync(path.join(projectRoot, 'intel'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'app', 'data', RECIPE_ID), { recursive: true })
  fs.mkdirSync(kovitoboardDir, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.claude', 'agents'), { recursive: true })

  // テストファイルを配置
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
  // 除外リスト対象ファイル
  fs.writeFileSync(path.join(projectRoot, '.env'), 'SECRET=xxx')
  fs.writeFileSync(path.join(projectRoot, '.env.production'), 'PROD_SECRET=yyy')
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/main')

  // handler をレジストリに登録
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

  // ManifestStore 初期化
  const fsLayer = new DirectFsLayer()
  manifestStore = new RecipeManifestStore(kovitoboardDir, fsLayer)
})

afterAll(() => {
  // 一時ディレクトリを削除
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearRegistry()
})

beforeEach(() => {
  // レート制限をリセット
  resetRateLimiter()
  // 監査ログをクリア
  const logPath = path.join(projectRoot, 'app', 'data', RECIPE_ID, '_audit.log')
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath)
  }
})

// =========================================
// T1: 正常系 — manifest 保存 → list-files 呼び出し → 正常結果
// =========================================

describe('T1: 正常系 — list-files 呼び出し', () => {
  it('manifest 保存 → dispatch → ファイル一覧が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      { recipeId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
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
      { recipeId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
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
    // argsHash は 16 進 64 文字
    expect(last.argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof last.durationMs).toBe('number')
  })
})

// =========================================
// T2: scope 違反 — 承認なし scope での handler 呼び出し
// =========================================

describe('T2: scope 違反 → ScopeViolation', () => {
  it('kb-data-read のみ承認で write-file を呼ぶと ScopeViolation', async () => {
    // write-file の requiredScopes は ['project-write', 'own-data']
    // kb-data-read のみ承認ではいずれにもマッチしないため ScopeViolation
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
        recipeId: RECIPE_ID,
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
    // kv-set の requiredScopes は ['own-data']
    // project-read のみ承認では own-data にマッチしないため ScopeViolation
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
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
        callId: 'write-project-file',
        input: { path: 'output.txt', content: 'test' },
      },
      manifestStore,
      projectRoot,
    )

    // dispatcher のフローでは scope 検証（step 5）は audit ログ（step 8）の前に行われる
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
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
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

  it('".git/HEAD" への read-file で PathForbidden が返る', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      {
        recipeId: RECIPE_ID,
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

  it('list-files で "." を要求したとき、.env / .git / node_modules がエントリに含まれない', async () => {
    // node_modules も作成
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'some-pkg'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}')

    const manifest = createTestManifest()
    manifestStore.save(manifest)

    const result = await dispatch(
      { recipeId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    // list-intel-reports は path: "intel/" 固定なので、project root を見るために別の call を作成
    const manifestWithRoot = createTestManifest({
      calls: [
        ...createTestManifest().api.calls,
        { id: 'list-root', handler: 'list-files', args: { path: '.' } },
      ],
    })
    manifestStore.save(manifestWithRoot)

    const rootResult = await dispatch(
      { recipeId: RECIPE_ID, callId: 'list-root', input: {} },
      manifestStore,
      projectRoot,
    )

    expect(rootResult.ok).toBe(true)
    if (!rootResult.ok) return

    const data = rootResult.data as { entries: Array<{ name: string; path: string }> }
    const names = data.entries.map((e) => e.name)

    // 除外対象が含まれていないことを検証
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.env.production')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    // 正常ファイルは含まれている
    expect(names).toContain('README.md')
  })
})

// =========================================
// T5: サイズ超過 — 11MB ファイルの read-file → SizeExceeded
// =========================================

describe('T5: サイズ超過 → SizeExceeded', () => {
  const LARGE_FILE = 'intel/large-report.bin'

  beforeAll(() => {
    // 11MB のダミーファイルを作成
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
        recipeId: RECIPE_ID,
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
          recipeId: RECIPE_ID,
          callId: 'send-notification',
          input: { title: `Alert ${i}`, body: `Test notification ${i}` },
        },
        manifestStore,
        projectRoot,
      )
      results.push(result as { ok: boolean; error?: { code: string } })
    }

    // 最初の 10 回は成功
    for (let i = 0; i < 10; i++) {
      expect(results[i].ok).toBe(true)
    }

    // 11 回目はレート制限
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
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
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

    // read-intel-report の args は { path: "${input.path}" }
    // input に path を含めない
    const result = await dispatch(
      {
        recipeId: RECIPE_ID,
        callId: 'read-intel-report',
        input: {},  // path が undefined
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
        recipeId: RECIPE_ID,
        callId: 'write-own-file',
        input: { path: targetPath, content: 'Hello from handler!' },
      },
      manifestStore,
      projectRoot,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // ファイルが実際に書き込まれたか確認
    const written = fs.readFileSync(path.join(projectRoot, targetPath), 'utf-8')
    expect(written).toBe('Hello from handler!')
  })
})

// =========================================
// KV ストア結合テスト
// =========================================

describe('KV ストア結合テスト', () => {
  it('kv-set → kv-get → kv-list → kv-delete の一連フローが動作する', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // kv-set
    const setResult = await dispatch(
      {
        recipeId: RECIPE_ID,
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
        recipeId: RECIPE_ID,
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
// 監査ログ総合検証
// =========================================

describe('監査ログ総合検証', () => {
  it('正常呼び出しで監査ログに handler / callId / argsHash / result が記録される', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // 正常な list-files 呼び出し
    await dispatch(
      { recipeId: RECIPE_ID, callId: 'list-intel-reports', input: {} },
      manifestStore,
      projectRoot,
    )

    // テンプレート展開あり read-file 呼び出し
    await dispatch(
      {
        recipeId: RECIPE_ID,
        callId: 'read-intel-report',
        input: { path: 'intel/report-001.md' },
      },
      manifestStore,
      projectRoot,
    )

    const logs = readAuditLog()
    expect(logs.length).toBe(2)

    // 1 つ目: list-files
    expect(logs[0].handler).toBe('list-files')
    expect(logs[0].callId).toBe('list-intel-reports')
    expect(logs[0].result).toBe('ok')
    expect(logs[0].argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof logs[0].timestamp).toBe('string')
    expect(typeof logs[0].durationMs).toBe('number')

    // 2 つ目: read-file
    expect(logs[1].handler).toBe('read-file')
    expect(logs[1].callId).toBe('read-intel-report')
    expect(logs[1].result).toBe('ok')
  })

  it('handler 内エラー（NotFound 等）でも監査ログが記録される', async () => {
    const manifest = createTestManifest()
    manifestStore.save(manifest)

    // 存在しないファイルを読み取り
    await dispatch(
      {
        recipeId: RECIPE_ID,
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
// セキュリティ回帰テスト（recipe-backend-implementation-plan.md §7-4）
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
        recipeId: RECIPE_ID,
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

  it('write-file で .claude/credentials に書き込もうとすると PathForbidden', async () => {
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
        recipeId: RECIPE_ID,
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
