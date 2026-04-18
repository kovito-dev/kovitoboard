/**
 * Server startup and basic operation tests
 *
 * Test targets:
 * - KovitoBoard server starts and APIs respond
 * - Agents are loaded correctly
 * - Frontend renders normally
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('サーバー起動・基本動作', () => {
  test('バックエンド API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/config`)
    expect(res.ok()).toBeTruthy()

    const config = await res.json()
    // KovitoBoard config contains ui, user, agents, etc.
    expect(config).toHaveProperty('ui')
    expect(config).toHaveProperty('user')
  })

  test('エージェント一覧 API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents`)
    expect(res.ok()).toBeTruthy()

    const agents = await res.json()
    expect(Array.isArray(agents)).toBeTruthy()
  })

  test('セッション一覧 API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/sessions`)
    expect(res.ok()).toBeTruthy()

    const sessions = await res.json()
    expect(Array.isArray(sessions)).toBeTruthy()
  })

  test('設定 API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/settings/basic`)
    expect(res.ok()).toBeTruthy()

    const settings = await res.json()
    expect(settings).toBeTruthy()
  })

  test('tmux ステータス API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/tmux/status`)
    expect(res.ok()).toBeTruthy()
  })

  test('フロントエンドが表示される', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Verify that the React app is mounted
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    expect(body!.length).toBeGreaterThan(0)
  })

  test('エージェント一覧ページが表示される', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The nav menu shows the agent button
    const agentButton = page.locator('button[title="エージェント"]').first()
    await expect(agentButton).toBeVisible()
  })
})
