/**
 * Session flow tests
 *
 * Test targets:
 * - Session list screen is displayed
 * - New session API acceptance
 * - No console errors during UI operations
 *
 * Note:
 * Does not expect Claude CLI responses. Only verifies API calls and
 * UI-side state transitions.
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

// Helper to get a menu button in the sidebar
function sidebarButton(page: import('@playwright/test').Page, label: string) {
  return page.locator(`button[title="${label}"]`).first()
}

test.describe('セッションフロー', () => {
  test('新規セッション API が受け付けられる', async ({ request }) => {
    // Get agent list
    const agentsRes = await request.get(`${API_BASE}/api/agents`)
    expect(agentsRes.ok()).toBeTruthy()
    const agents = await agentsRes.json()

    // Skip if no agents exist
    test.skip(agents.length === 0, 'エージェント定義が存在しないためスキップ')

    const firstAgent = agents[0]

    // Call the new session API
    // Process launch is attempted even without Claude CLI (does not error)
    const res = await request.post(`${API_BASE}/api/sessions/new`, {
      data: {
        agentId: firstAgent.id,
        message: 'E2Eテストメッセージ',
      },
    })
    expect(res.ok()).toBeTruthy()

    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.processId).toBeTruthy()
  })

  test('UI操作中にコンソールエラーが発生しない', async ({ page }) => {
    // Collect page errors (uncaught exceptions)
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // 1. Navigate to sessions screen
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // 2. Go back to agents screen
    await sidebarButton(page, 'エージェント').click()
    await page.waitForTimeout(500)

    // 3. Navigate to sessions screen again
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // No console errors occurred
    expect(pageErrors).toHaveLength(0)
  })

  test('セッション画面遷移後にコンテンツが表示される', async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Navigate to sessions screen
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // Screen must not be blank
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeTruthy()
    expect(bodyText!.length).toBeGreaterThan(0)

    // No console errors occurred
    expect(pageErrors).toHaveLength(0)
  })
})
