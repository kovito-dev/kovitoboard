/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe handler E2E tests — Phase L
 *
 * Verifies the full path: install -> WebSocket kb-call -> response validation.
 *
 * L1: Recipe installation (/api/recipes/install)
 * L2: write-file + list-files calls -> create files in own-data and list them
 * L3: read-file call -> verify file content in own-data
 * L4: Excluded paths / undeclared callId / path traversal -> error responses
 *
 * Tests are self-contained within the own-data scope, so they do not
 * depend on the server's projectRoot, ensuring stable verification.
 *
 * @see recipe-backend-implementation-plan.md Phase L
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const WS_URL = 'ws://127.0.0.1:3001/api/ws'

const TEST_RECIPE_NAME = 'E2E Test Viewer'
const TEST_RECIPE_ID = 'e2e-test-viewer'

/**
 * Helper that issues a kb-call via WebSocket and returns the response.
 * Runs inside Playwright's page.evaluate().
 */
async function sendKbCall(
  page: import('@playwright/test').Page,
  params: { recipeId: string; callId: string; input: Record<string, unknown> },
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  return page.evaluate(
    // The wire field is `appId` post-DEC-024 (the dispatcher routes
    // by KB-local identifier). The test signature still calls it
    // `recipeId` for narrative clarity, since for the
    // single-instance install pattern this suite uses, recipeId and
    // appId carry the same string.
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
            appId: recipeId,
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
            // Ignore other messages
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
 * Helper to seed the dispatcher manifest for the test recipe.
 *
 * v2.0 (DEC-024 #2 / spec §3.2): the install endpoint hands the
 * recipe to an agent for placement and no longer writes the
 * `recipes-installed/<appId>/manifest.json` itself. Tests that only
 * need the dispatcher state (handler routing) bypass the agent
 * dialog by calling `mark-installed` directly — that is the surface
 * that persists the manifest and history record.
 */
async function installTestRecipe(
  request: import('@playwright/test').APIRequestContext,
  overrides?: {
    scopes?: string[]
    calls?: Array<{ id: string; handler: string; args?: Record<string, unknown> }>
  },
): Promise<void> {
  const scopes = overrides?.scopes ?? ['project-read', 'own-data']
  const calls = overrides?.calls ?? [
    { id: 'list-own-files', handler: 'list-files', args: { path: `app/data/${TEST_RECIPE_ID}` } },
    { id: 'read-own-file', handler: 'read-file', args: { path: '${input.path}' } },
    { id: 'write-own-file', handler: 'write-file', args: { path: '${input.path}', content: '${input.content}', createDirs: true } },
    { id: 'read-project-file', handler: 'read-file', args: { path: '${input.path}' } },
  ]
  const res = await request.post(
    `${API_BASE}/api/recipes/${TEST_RECIPE_ID}/mark-installed`,
    {
      data: {
        appId: TEST_RECIPE_ID,
        approvedScopes: scopes,
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
        recipeHash: `e2e-test-hash-${Date.now()}`,
        api: { scopes, calls },
      },
    },
  )
  expect(res.ok()).toBeTruthy()
}

// =========================================
// L1: Recipe installation
// =========================================

test.describe('Recipe handler E2E', () => {
  test('L1: /api/recipes/:recipeId/mark-installed で manifest を登録できる', async ({ request }) => {
    // v2.0 entry point for setting up the dispatcher state. The
    // legacy install API path that wrote the manifest synchronously
    // was retired in DEC-024 #2 (spec §3.2) — install now hands the
    // recipe to an agent. Tests that exercise the dispatcher use
    // mark-installed directly.
    const res = await request.post(
      `${API_BASE}/api/recipes/${TEST_RECIPE_ID}/mark-installed`,
      {
        data: {
          appId: TEST_RECIPE_ID,
          approvedScopes: ['project-read', 'own-data'],
          recipeVersion: '1.0.0',
          recipeSource: 'sample',
          recipeHash: 'e2e-test-hash-001',
          api: {
            scopes: ['project-read', 'own-data'],
            calls: [
              { id: 'list-own-files', handler: 'list-files', args: { path: `app/data/${TEST_RECIPE_ID}` } },
              { id: 'read-own-file', handler: 'read-file', args: { path: '${input.path}' } },
            ],
          },
        },
      },
    )

    expect(res.ok()).toBeTruthy()
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  // =========================================
  // L2: write-file + list-files own-data operations
  // =========================================

  test('L2: write-file で own-data にファイルを作成し list-files で確認', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Write a file to own-data
    const writeResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'write-own-file',
      input: {
        path: `app/data/${TEST_RECIPE_ID}/test-doc.md`,
        content: '# E2E Test Document\n\nCreated by handler test.',
      },
    })
    expect(writeResult.ok).toBe(true)

    // Retrieve file list in own-data via list-files
    const listResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'list-own-files',
      input: {},
    })

    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return

    const data = listResult.data as { entries: Array<{ name: string; isDirectory: boolean }> }
    expect(Array.isArray(data.entries)).toBe(true)

    // The written file should appear in the listing
    const names = data.entries.map((e: { name: string }) => e.name)
    expect(names).toContain('test-doc.md')
  })

  // =========================================
  // L3: read-file to verify own-data file content
  // =========================================

  test('L3: write-file で書いたファイルを read-file で読み取れる', async ({ page }) => {
    await installTestRecipe(page.request)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const testContent = `# Test Report ${Date.now()}\n\nGenerated by E2E test.`
    const filePath = `app/data/${TEST_RECIPE_ID}/report.txt`

    // Write a file
    const writeResult = await sendKbCall(page, {
      recipeId: TEST_RECIPE_ID,
      callId: 'write-own-file',
      input: { path: filePath, content: testContent },
    })
    expect(writeResult.ok).toBe(true)

    // Read the file back
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
  // L4: Security test — excluded paths
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
  // L4: Security test — undeclared callId
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
  // L4: Security test — path traversal
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
