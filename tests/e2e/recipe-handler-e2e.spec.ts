/**
 * Recipe handler E2E テスト — Phase L
 *
 * インストール → WebSocket kb-call → レスポンス検証 のフルパスを検証する。
 *
 * L1: レシピインストール（/api/recipes/install）
 * L2: write-file + list-files 呼び出し → own-data にファイル作成・一覧取得
 * L3: read-file 呼び出し → own-data の���ァイル内容を検証
 * L4: 除外パス / 未宣言 callId / パストラバーサル → エラーレスポンス
 *
 * テストは own-data scope 内で完結させるため、サーバーの projectRoot に
 * 依存しない安定した検証になっている。
 *
 * @see recipe-backend-implementation-plan.md Phase L
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'
const WS_URL = 'ws://127.0.0.1:3001/ws'

const TEST_RECIPE_NAME = 'E2E Test Viewer'
const TEST_RECIPE_ID = 'e2e-test-viewer'

/**
 * WebSocket で kb-call を発行し、レスポンスを返すヘルパー.
 * Playwright の page.evaluate() 内で実行する。
 */
async function sendKbCall(
  page: import('@playwright/test').Page,
  params: { recipeId: string; callId: string; input: Record<string, unknown> },
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  return page.evaluate(
    async ({ wsUrl, recipeId, callId, input }) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        const requestId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('WebSocket kb-call timeout'))
        }, 10_000)

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'kb-call',
            requestId,
            recipeId,
            callId,
            input,
          }))
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string) as {
              type: string
              requestId: string
              result: { ok: boolean; data?: unknown; error?: { code: string; message: string } }
            }
            if (data.type === 'kb-call-response' && data.requestId === requestId) {
              clearTimeout(timeout)
              ws.close()
              resolve(data.result)
            }
          } catch {
            // 他のメッセージは無視
          }
        }

        ws.onerror = (err) => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error: ${err}`))
        }
      })
    },
    { wsUrl: WS_URL, ...params },
  )
}

/**
 * テスト用レシピをインストールするヘルパー.
 */
async function installTestRecipe(
  request: import('@playwright/test').APIRequestContext,
  overrides?: {
    scopes?: string[]
    calls?: Array<{ id: string; handler: string; args?: Record<string, unknown> }>
  },
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/recipes/install`, {
    data: {
      recipe: {
        metadata: {
          name: TEST_RECIPE_NAME,
          version: '1.0.0',
          description: 'E2E test recipe',
        },
        hash: `e2e-test-hash-${Date.now()}`,
        api: {
          scopes: overrides?.scopes ?? ['project-read', 'own-data'],
          calls: overrides?.calls ?? [
            { id: 'list-own-files', handler: 'list-files', args: { path: `app/data/${TEST_RECIPE_ID}` } },
            { id: 'read-own-file', handler: 'read-file', args: { path: '${input.path}' } },
            { id: 'write-own-file', handler: 'write-file', args: { path: '${input.path}', content: '${input.content}', createDirs: true } },
            { id: 'read-project-file', handler: 'read-file', args: { path: '${input.path}' } },
          ],
        },
        artifacts: [],
        menu: [],
      },
      approvedScopes: overrides?.scopes ?? ['project-read', 'own-data'],
    },
  })
  expect(res.ok()).toBeTruthy()
}

// =========================================
// L1: レシピインストール
// =========================================

test.describe('Recipe handler E2E', () => {
  test('L1: /api/recipes/install でレシピをインストールできる', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/recipes/install`, {
      data: {
        recipe: {
          metadata: {
            name: TEST_RECIPE_NAME,
            version: '1.0.0',
            description: 'E2E test recipe',
          },
          hash: 'e2e-test-hash-001',
          api: {
            scopes: ['project-read', 'own-data'],
            calls: [
              { id: 'list-own-files', handler: 'list-files', args: { path: `app/data/${TEST_RECIPE_ID}` } },
              { id: 'read-own-file', handler: 'read-file', args: { path: '${input.path}' } },
            ],
          },
          artifacts: [],
          menu: [],
        },
        approvedScopes: ['project-read', 'own-data'],
      },
    })

    expect(res.ok()).toBeTruthy()
    const body = await res.json() as { success: boolean; recipeId: string }
    expect(body.success).toBe(true)
    expect(body.recipeId).toBe(TEST_RECIPE_ID)
  })

  // =========================================
  // L2: write-file + list-files で own-data 操作
  // =========================================

  test('L2: write-file で own-data にファイルを作成し list-files で確認', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // own-data にファイルを書き込む
    const writeResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'write-own-file',
      input: {
        path: `app/data/${TEST_RECIPE_ID}/test-doc.md`,
        content: '# E2E Test Document\n\nCreated by handler test.',
      },
    })
    expect(writeResult.ok).toBe(true)

    // list-files で own-data 内のファイル一覧を取得
    const listResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'list-own-files',
      input: {},
    })

    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return

    const data = listResult.data as { entries: Array<{ name: string; isDirectory: boolean }> }
    expect(Array.isArray(data.entries)).toBe(true)

    // 書き込んだファイルが一覧に含まれる
    const names = data.entries.map((e: { name: string }) => e.name)
    expect(names).toContain('test-doc.md')
  })

  // =========================================
  // L3: read-file で own-data のファイル内容を検証
  // =========================================

  test('L3: write-file で書いたファイルを read-file で読み取れる', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const testContent = `# Test Report ${Date.now()}\n\nGenerated by E2E test.`
    const filePath = `app/data/${TEST_RECIPE_ID}/report.txt`

    // ファイル書き込み
    const writeResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'write-own-file',
      input: { path: filePath, content: testContent },
    })
    expect(writeResult.ok).toBe(true)

    // ファイル読み取り
    const readResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'read-own-file',
      input: { path: filePath },
    })

    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return

    const data = readResult.data as { content: string; size: number; encoding: string }
    expect(data.encoding).toBe('utf-8')
    expect(data.size).toBeGreaterThan(0)
    expect(data.content).toBe(testContent)
  })

  // =========================================
  // L4: セキュリティテスト — 除外パス
  // =========================================

  test('L4: 除外パス .env へのアクセスで PathForbidden が返る', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const result = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'read-project-file',
      input: { path: '.env' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error?.code).toBe('PathForbidden')
  })

  // =========================================
  // L4: セキュリティテスト — 未宣言 callId
  // =========================================

  test('L4: 未宣言 callId で HandlerNotDeclared が返る', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const result = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'nonexistent-call',
      input: {},
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error?.code).toBe('HandlerNotDeclared')
  })

  // =========================================
  // L4: セキュリティテスト — パストラバーサル
  // =========================================

  test('L4: パストラバーサル攻撃で PathOutOfScope が返る', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const result = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'read-project-file',
      input: { path: '../../etc/passwd' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error?.code).toBe('PathOutOfScope')
  })
})
