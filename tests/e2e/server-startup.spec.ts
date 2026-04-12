/**
 * サーバー起動・基本動作テスト
 *
 * テスト対象:
 * - KovitoBoard サーバーが起動し API が応答するか
 * - エージェントが正しくロードされるか
 * - フロントエンドが正常にレンダリングされるか
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('サーバー起動・基本動作', () => {
  test('バックエンド API が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/config`)
    expect(res.ok()).toBeTruthy()

    const config = await res.json()
    // KovitoBoard の config は ui, user, agents 等を含む
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

    // React アプリがマウントされていることを確認
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    expect(body!.length).toBeGreaterThan(0)
  })

  test('エージェント一覧ページが表示される', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // ナビメニューに「エージェント」が表示されている
    const agentButton = page.locator('button[title="エージェント"]').first()
    await expect(agentButton).toBeVisible()
  })
})
