/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent management tests
 *
 * Test targets:
 * - Agent list is displayed correctly
 * - Agent information is returned correctly via API
 * - Agent information contains required fields
 *
 * Note:
 * Since AD-2/AD-3 (DEC-024) the read-only banner has been replaced by an
 * Edit banner on the agent detail page (non-system agents only). The system
 * default agent ("Claude (default)", id `__claude_default__`) remains
 * non-editable; bundled/user agents like kovito-concierge surface the
 * Edit banner. An empty array is returned if no agent definitions exist
 * in .claude/agents/.
 */
import { test, expect } from './helpers/l1-per-test-setup'

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
    const agents = await res.json() as Array<{ id: string; displayName: string }>

    // Pick a stable, well-known agent (the bundled concierge) instead of
    // agents[0]. agents[0] could be a leftover test agent (e.g. an
    // `s9-test-*` from 30min-experience S9 if cross-test cleanup raced
    // against the next test's API call), and we cannot guarantee that
    // such an agent is registered as editable. The concierge is shipped
    // with every fixture that has any agents at all and is non-system,
    // so its detail page consistently renders the Edit banner.
    const target = agents.find((a) => a.id === 'kovito-concierge')
    test.skip(!target, 'concierge エージェントが存在しないためスキップ')
    if (!target) return

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click the card containing the concierge's display name
    const agentCard = page.locator('button').filter({ hasText: target.displayName }).first()
    await agentCard.click()
    await page.waitForTimeout(500)

    // Agent information is displayed on the detail screen
    const content = await page.textContent('body')
    expect(content).toContain(target.displayName)
    // Edit banner is displayed (AD-2/AD-3 / DEC-024 replaced the legacy
    // read-only banner with an Edit affordance for non-system agents).
    // The L1 page fixture seeds `kb.locale='ja'` via addInitScript, but
    // the project setting.json may pin `en`. Match against either copy
    // so the assertion is locale-agnostic.
    expect(content).toMatch(/Edit display name, personality, tone, and extra instructions|表示名・性格・口調・追加指示を編集できます/)
  })
})
