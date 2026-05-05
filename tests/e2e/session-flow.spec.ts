/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

// Helper to get a menu button in the sidebar
function sidebarButton(page: import('@playwright/test').Page, label: string) {
  return page.locator(`button[title="${label}"]`).first()
}

test.describe('セッションフロー', () => {
  test('新規セッション API が受け付けられる', async ({ request }) => {
    // POST /api/sessions/new spawns a child process internally; on the
    // CI runner the round-trip occasionally creeps past 30s when the
    // detector tick + tmux startup overhead pile up. The default test
    // timeout is enough locally — extend it here so the request fixture
    // is not disposed out from under the assertion.
    test.setTimeout(60_000)

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
    // Either delivery path is acceptable: tmux returns `windowName`,
    // ClaudeBridge fallback returns `processId`. The L1 fixture now
    // ships with a live tmux session so the tmux path is taken, which
    // means asserting `processId` alone would fail spuriously.
    expect(body.processId || body.windowName).toBeTruthy()
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
    await sidebarButton(page, 'Sessions').click()
    await page.waitForTimeout(500)

    // 2. Go back to agents screen
    await sidebarButton(page, 'Agents').click()
    await page.waitForTimeout(500)

    // 3. Navigate to sessions screen again
    await sidebarButton(page, 'Sessions').click()
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
    await sidebarButton(page, 'Sessions').click()
    await page.waitForTimeout(500)

    // Screen must not be blank
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeTruthy()
    expect(bodyText!.length).toBeGreaterThan(0)

    // No console errors occurred
    expect(pageErrors).toHaveLength(0)
  })
})
