/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * S12: Ambient Session Sidebar — UI 統合テスト
 *
 * @see docs/specs/v0.1.0-ambient-sidebar.md（kovitoboard-dev リポ）
 * @see DEC-020 v1.1
 * @see DEC-024 #3 §F7（sidebar 抑制ルートの改訂）
 *
 * 検証対象:
 *   - Phase 1: サイドバー開閉トグル + 非表示画面（/sessions, /agents, /recipes）
 *   - Phase 2: agent picker 表示 / Pin to this screen ボタン / setting.json 永続化
 *   - Phase 4: a11y snapshot 取得（unit 動作）
 *   - Phase 5: 「画面要素を選択」ボタンの存在・トグル + window.kb.exposeContext API の生存
 *
 * メッセージ送信フロー（Phase 2-C / Phase 3）は Fake Claude セッション
 * を起動して JSONL を観測する必要があるため、本 spec ではスコープ外
 * とする（既存 30min-experience.spec.ts のフローと同等の helper を
 * 使うが、サイドバー由来の origin reservation 検証は unit / 統合の
 * 別レイヤで担保する）。
 *
 * 配置画面:
 *   - DEC-024 #3 §F7 でサイドバーは /sessions, /agents, /recipes で
 *     抑制され、/ext/<id> でのみ mount される。L1 fixture
 *     (blank-onboarded) には ext app が同梱されていないため、本 spec
 *     が beforeAll で最小ダミー ext app を fixture project に書き込み、
 *     afterAll で削除する。これにより /ext/<TEST_APP_ID> 経由で
 *     サイドバーが確実に mount されることを担保する。
 */
import { test, expect, type Page } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
// The L1 `blank-onboarded` fixture ships with this ext app pre-installed
// so the AmbientSidebar (which after DEC-024 #3 §F7 only mounts on
// /ext/<appId>) has a stable host route in L1 specs.
// See tests/fixtures/projects/blank-onboarded/app/menu.ts.
const TEST_APP_ID = 'l1-fixture-app'
const TEST_APP_LABEL = 'L1 Fixture App'

/** Open the dummy ext-app page and wait for the sidebar to mount. */
async function openExtAppWithSidebar(page: Page): Promise<void> {
  // /ext/<appId> Routes are added dynamically once `loadUserMenuEntries`
  // resolves (App.tsx:462). A direct page.goto('/ext/<appId>') triggers
  // a full page reload, so userMenuEntries restarts at [] and the
  // catch-all Route bounces us to /agents before the menu-entries fetch
  // settles. Instead we land on /agents (full reload), wait for the
  // entries to load, and then click the NavMenu button for our ext app
  // to navigate via the in-app router (no reload, route is registered).
  await page.goto('/agents')
  await page.waitForResponse(
    (r) => r.url().endsWith('/api/app/menu-entries') && r.ok(),
  )
  // The NavMenu renders each user entry as a <button title="<label>">.
  // Wait for the button to actually appear (state can lag the API
  // response by a frame), then click it.
  const navButton = page.locator(`button[title="${TEST_APP_LABEL}"]`).first()
  await navButton.waitFor({ state: 'visible', timeout: 10_000 })
  await navButton.click()
  await page.waitForURL(`**/ext/${TEST_APP_ID}`)
  await page.waitForLoadState('networkidle')
  // DEC-024 #3 §F7: the sidebar mounts on /ext/<appId> (and is suppressed
  // on /sessions, /agents, /recipes). Wait until the element is in the
  // DOM before any assertion.
  await page.waitForSelector('[data-testid="ambient-sidebar"]')
}

test.describe('S12: Ambient Session Sidebar', () => {
  // The ext app this spec needs is baked into the `blank-onboarded`
  // fixture (`tests/fixtures/projects/blank-onboarded/app/`). We do not
  // install or tear it down per-spec because L1 specs share one
  // webServer, and a per-spec install would race with sibling specs
  // running in parallel against the same project root.

  // -------------------------------------------------------------
  // Phase 1: chrome (placement + toggle + suppression)
  // -------------------------------------------------------------
  test.describe('Phase 1: 配置とトグル', () => {
    test('S12-1a: /ext/<appId> ページでサイドバーが mount される（初期 closed）', async ({ page }) => {
      await openExtAppWithSidebar(page)
      const sidebar = page.locator('[data-testid="ambient-sidebar"]')
      await expect(sidebar).toBeVisible()
      // Initial state per spec §2.2 = closed
      await expect(sidebar).toHaveAttribute('data-state', 'closed')
    })

    test('S12-1b: トグルボタンで open / closed が切り替わる', async ({ page }) => {
      await openExtAppWithSidebar(page)
      const sidebar = page.locator('[data-testid="ambient-sidebar"]')
      const toggle = page.locator('[data-testid="ambient-sidebar-toggle"]')

      await expect(sidebar).toHaveAttribute('data-state', 'closed')
      await toggle.click()
      await expect(sidebar).toHaveAttribute('data-state', 'open')
      await toggle.click()
      await expect(sidebar).toHaveAttribute('data-state', 'closed')
    })

    test('S12-1c: /agents ではサイドバーが mount されない', async ({ page }) => {
      await page.goto('/agents')
      await page.waitForLoadState('networkidle')
      await expect(page.locator('[data-testid="ambient-sidebar"]')).toHaveCount(0)
    })

    test('S12-1d: /sessions ではサイドバーが mount されない', async ({ page }) => {
      await page.goto('/sessions')
      await page.waitForLoadState('networkidle')
      await expect(page.locator('[data-testid="ambient-sidebar"]')).toHaveCount(0)
    })
  })

  // -------------------------------------------------------------
  // Phase 2: agent picker + per-app pinning
  // -------------------------------------------------------------
  test.describe('Phase 2: picker + ピン留め', () => {
    test('S12-2a: 開いた状態で agent picker と Pin ボタンが表示される', async ({ page }) => {
      await openExtAppWithSidebar(page)
      await page.locator('[data-testid="ambient-sidebar-toggle"]').click()

      await expect(page.locator('[data-testid="ambient-sidebar-agent-picker"]')).toBeVisible()
      await expect(page.locator('[data-testid="ambient-sidebar-pin-button"]')).toBeVisible()
    })

    test('S12-2b: picker の選択肢に /api/agents の戻り値が反映される', async ({ page, request }) => {
      const apiAgents = await request.get(`${API_BASE}/api/agents`).then((r) => r.json())
      // Spec §2.5 "Kobi-prerequisite removal" — no hardcoded agents.
      // We only assert that whatever /api/agents returns shows up in
      // the picker, plus the always-present "(unselected)" option.
      await openExtAppWithSidebar(page)
      await page.locator('[data-testid="ambient-sidebar-toggle"]').click()

      // The picker is now a custom listbox (not a native <select>) —
      // open it to inspect options.
      const picker = page.locator('[data-testid="ambient-sidebar-agent-picker"]')
      await picker.click()
      const options = await page
        .locator('[data-testid="ambient-sidebar-agent-picker-list"] [role="option"]')
        .allTextContents()
      // First option is always "(unselected)".
      expect(options.length).toBe(apiAgents.length + 1)
    })

    test('S12-2c: 選択したエージェントを Pin → setting.json に永続化される', async ({ page, request }) => {
      const apiAgents = await request.get(`${API_BASE}/api/agents`).then((r) => r.json())
      test.skip(apiAgents.length === 0, 'No agents available to pin in this fixture')
      const targetAgentId: string = apiAgents[0].id

      await openExtAppWithSidebar(page)
      await page.locator('[data-testid="ambient-sidebar-toggle"]').click()

      // Pick an agent and click Pin (custom listbox click flow).
      await page.locator('[data-testid="ambient-sidebar-agent-picker"]').click()
      await page
        .locator(`[data-testid="ambient-sidebar-agent-picker-option-${targetAgentId}"]`)
        .click()
      await page.locator('[data-testid="ambient-sidebar-pin-button"]').click()

      // Confirm via API: setting.json now records the per-app pinned
      // agent under the active route's appId. usePinnedAgent.resolveAppId
      // prefixes ext routes with `ext/`, so the key persists as
      // `ext/<TEST_APP_ID>` (not the bare appId). The PUT is async;
      // poll briefly.
      const pinKey = `ext/${TEST_APP_ID}`
      await expect.poll(
        async () => {
          const setting = await request.get(`${API_BASE}/api/config/setting`).then((r) => r.json())
          return setting?.ambientSidebar?.pinned?.[pinKey] ?? null
        },
        { timeout: 5_000, message: `pinned[${pinKey}] was not persisted` },
      ).toBe(targetAgentId)
    })
  })

  // -------------------------------------------------------------
  // Phase 5: window.kb.exposeContext API + element picker UI
  //
  // Phase 4 (a11y snapshot module) is exercised by unit tests rather
  // than by this spec — the module is internal and exposing it through
  // `import('/src/...')` from page.evaluate fails on the Vite dev
  // server (no module URL for .ts at runtime).
  // -------------------------------------------------------------
  test.describe('Phase 5: context channels', () => {
    test('S12-5a: window.kb.exposeContext が常駐 inject されており呼び出せる', async ({ page }) => {
      await openExtAppWithSidebar(page)
      // The bridge is bootstrapped by main.tsx before React mounts, so
      // the function must already exist on first render.
      const isFunction = await page.evaluate(() => {
        return typeof (window as unknown as { kb?: { exposeContext?: unknown } })
          .kb?.exposeContext === 'function'
      })
      expect(isFunction).toBe(true)

      // Calling exposeContext must not throw on a well-formed payload.
      const callOk = await page.evaluate(() => {
        try {
          type KbWindow = Window & { kb: { exposeContext: (p: Record<string, unknown>) => void } }
          ;(window as unknown as KbWindow).kb.exposeContext({ s12: 'hello', n: 42 })
          return true
        } catch {
          return false
        }
      })
      expect(callOk).toBe(true)
    })

    test('S12-5b: 「画面要素を選択」ボタンが picker と同時に表示される', async ({ page, request }) => {
      const apiAgents = await request.get(`${API_BASE}/api/agents`).then((r) => r.json())
      test.skip(apiAgents.length === 0, 'No agents available; pick toggle requires a selected agent to enable')

      await openExtAppWithSidebar(page)
      await page.locator('[data-testid="ambient-sidebar-toggle"]').click()
      // Custom listbox click flow (was native <select>.selectOption).
      await page.locator('[data-testid="ambient-sidebar-agent-picker"]').click()
      await page
        .locator(`[data-testid="ambient-sidebar-agent-picker-option-${apiAgents[0].id}"]`)
        .click()

      const pickToggle = page.locator('[data-testid="ambient-sidebar-pick-toggle"]')
      await expect(pickToggle).toBeVisible()
      await expect(pickToggle).toBeEnabled()
    })
  })
})
