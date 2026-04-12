/**
 * エージェント管理テスト
 *
 * テスト対象:
 * - エージェント一覧が正しく表示されるか
 * - API 経由でエージェント情報が正しく返るか
 * - エージェント情報に必須フィールドがあるか
 *
 * 注意:
 * KovitoBoard v0.1.0 ではエージェントは読み取り専用。
 * .claude/agents/ にエージェント定義がない場合は空配列が返る。
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('エージェント管理', () => {
  test('エージェント一覧 API が配列を返す', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents`)
    expect(res.ok()).toBeTruthy()

    const agents = await res.json()
    expect(Array.isArray(agents)).toBeTruthy()
  })

  test('エージェント情報に必須フィールドがある', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents`)
    expect(res.ok()).toBeTruthy()

    const agents = await res.json()
    // エージェントが存在する場合のみフィールドを検証
    for (const agent of agents) {
      expect(agent).toHaveProperty('id')
      expect(agent).toHaveProperty('displayName')
      expect(agent).toHaveProperty('description')
      expect(agent).toHaveProperty('color')
    }
  })

  test('エージェントが存在する場合、カードが表示される', async ({ page, request }) => {
    // API からエージェント数を取得
    const res = await request.get(`${API_BASE}/api/agents`)
    const agents = await res.json()

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    if (agents.length > 0) {
      // 最初のエージェントの displayName が画面に表示されている
      const content = await page.textContent('body')
      expect(content).toContain(agents[0].displayName)
    } else {
      // エージェントがない場合は案内メッセージが表示される
      const content = await page.textContent('body')
      expect(content).toContain('エージェントが見つかりません')
    }
  })

  test('エージェントカードをクリックすると詳細が表示される', async ({ page, request }) => {
    const res = await request.get(`${API_BASE}/api/agents`)
    const agents = await res.json()

    // エージェントが存在しない場合はスキップ
    test.skip(agents.length === 0, 'エージェント定義が存在しないためスキップ')

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // 最初のエージェント名を含むカードをクリック
    const firstAgent = agents[0]
    const agentCard = page.locator('button').filter({ hasText: firstAgent.displayName }).first()
    await agentCard.click()
    await page.waitForTimeout(500)

    // 詳細画面にエージェント情報が表示される
    const content = await page.textContent('body')
    expect(content).toContain(firstAgent.displayName)
    // 読み取り専用バナーが表示される
    expect(content).toContain('読み取り専用')
  })
})
