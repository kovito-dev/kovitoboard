/**
 * Agent management tests
 *
 * Test targets:
 * - Agent list is displayed correctly
 * - Agent information is returned correctly via API
 * - Agent information contains required fields
 *
 * Note:
 * In KovitoBoard v0.1.0, agents are read-only.
 * An empty array is returned if no agent definitions exist in .claude/agents/.
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
    // Only validate fields when agents exist
    for (const agent of agents) {
      expect(agent).toHaveProperty('id')
      expect(agent).toHaveProperty('displayName')
      expect(agent).toHaveProperty('description')
      expect(agent).toHaveProperty('color')
    }
  })

  test('エージェントが存在する場合、カードが表示される', async ({ page, request }) => {
    // Get agent count from API
    const res = await request.get(`${API_BASE}/api/agents`)
    const agents = await res.json()

    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    if (agents.length > 0) {
      // The first agent's displayName is shown on screen
      const content = await page.textContent('body')
      expect(content).toContain(agents[0].displayName)
    } else {
      // Either a guidance message or the welcome banner is displayed
      const content = await page.textContent('body')
      const hasGuidance =
        content?.includes('エージェントが見つかりません') ||
        content?.includes('エージェント定義ファイルを作成')
      expect(hasGuidance).toBe(true)
    }
  })

  test('エージェントカードをクリックすると詳細が表示される', async ({ page, request }) => {
    const res = await request.get(`${API_BASE}/api/agents`)
    const agents = await res.json()

    // Skip if no agents exist
    test.skip(agents.length === 0, 'エージェント定義が存在しないためスキップ')

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click the card containing the first agent's name
    const firstAgent = agents[0]
    const agentCard = page.locator('button').filter({ hasText: firstAgent.displayName }).first()
    await agentCard.click()
    await page.waitForTimeout(500)

    // Agent information is displayed on the detail screen
    const content = await page.textContent('body')
    expect(content).toContain(firstAgent.displayName)
    // Read-only banner is displayed
    expect(content).toContain('読み取り専用')
  })
})
