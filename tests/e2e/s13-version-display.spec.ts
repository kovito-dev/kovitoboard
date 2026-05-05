/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * S13: Version Display — UI 統合テスト
 *
 * @see docs/specs/v0.1.0-version-display.md（kovitoboard-dev リポ）
 *
 * 検証対象（Phase B / C UI 動作 + Phase A API レスポンス形状）:
 *   - ヘッダー警告バッジが初期に出ない（playwright.config.l1.ts で
 *     `KOVITO_NO_VERSION_CHECK=1` を設定しているため、disabledBy=env
 *     状態。spec §2.2 に従い badge は非表示）
 *   - StatusIndicator popover を開くと Versions セクションが表示
 *   - 無効化中は disabledByEnv メッセージ + recheck ボタン非表示
 *   - GET /api/version の最低限のレスポンス形状
 *
 * メッセージ送信を伴うアップデートフロー（Phase C
 * `POST /api/version/start-upgrade`）は、Fake Claude セッション起動
 * + 確認モーダル + ナビゲーションを連結する複合シナリオで、本 spec
 * のスコープ外。手動テスト（T1, kovito-hq architect 担当）でカバー。
 */
import { test, expect, type Page } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

/** CSS selector that matches the StatusIndicator button regardless of
 *  locale (ja: 'サーバステータス' / en: 'Server Status'). The L1 fixture
 *  is locale=en after `bootstrapLocaleFromSetting`, but the L1 page
 *  fixture also seeds kb.locale=ja; either path can win depending on
 *  bootstrap ordering, so match against both. */
const STATUS_INDICATOR_BUTTON =
  'button[title="サーバステータス"], button[title="Server Status"]'

async function openHomeAndWait(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // TitleBar mounts the StatusIndicator + version badge unconditionally;
  // wait until the indicator button exists before asserting.
  await page.waitForSelector(STATUS_INDICATOR_BUTTON, { state: 'attached' })
}

test.describe('S13: Version Display', () => {
  test.describe('Phase A: API responses', () => {
    test('S13-A1: GET /api/version returns the spec §4.5 shape', async ({ request }) => {
      const res = await request.get(`${API_BASE}/api/version`)
      expect(res.ok(), `unexpected status ${res.status()}: ${await res.text()}`).toBe(true)
      const body = await res.json()

      // Top-level blocks
      expect(body).toHaveProperty('kb')
      expect(body).toHaveProperty('claudeCode')
      expect(body).toHaveProperty('config')

      // KB block: version string + cache fields
      expect(typeof body.kb.current).toBe('string')
      expect(body.kb.current.length).toBeGreaterThan(0)

      // Claude Code block: tier always present
      expect(['primary', 'best-effort', 'out-of-range', 'unknown']).toContain(body.claudeCode.tier)
      expect(typeof body.claudeCode.primaryTested).toBe('string')

      // Config block: env switch is honored — the L1 webServer sets
      // KOVITO_NO_VERSION_CHECK=1, so disabledBy must be 'env'.
      expect(body.config.versionCheckEnabled).toBe(false)
      expect(body.config.disabledBy).toBe('env')
    })

    test('S13-A2: POST /api/version/recheck returns 403 when disabled', async ({ request }) => {
      const res = await request.post(`${API_BASE}/api/version/recheck`)
      expect(res.status()).toBe(403)
      const body = await res.json()
      expect(body.disabledBy).toBe('env')
    })

    test('S13-A3: POST /api/version/start-upgrade rejects empty agentId', async ({ request }) => {
      const res = await request.post(`${API_BASE}/api/version/start-upgrade`, { data: {} })
      // Either 400 (validation) or 409 (no cached release info) is
      // acceptable here — the contract is "doesn't 200 without an
      // agentId". With KOVITO_NO_VERSION_CHECK=1 there is no cache,
      // so 400 is the expected path.
      expect([400, 409]).toContain(res.status())
    })
  })

  test.describe('Phase B: UI surfaces', () => {
    test('S13-B1: header badge is not rendered when disabled', async ({ page }) => {
      await openHomeAndWait(page)
      // Spec §2.3: disabled mode never renders the header badge.
      await expect(page.locator('[data-testid="version-header-badge"]')).toHaveCount(0)
    })

    test('S13-B2: opening StatusIndicator surfaces the Versions panel', async ({ page }) => {
      await openHomeAndWait(page)
      // Click the indicator dot to open the popover.
      await page.locator(STATUS_INDICATOR_BUTTON).first().click()
      // VersionPanel renders three states (loading/error/ready) all with
      // the same testid; we want the resolved one for the assertions
      // that follow.
      const panel = page.locator('[data-testid="version-panel"][data-state="ready"]')
      await expect(panel).toBeVisible({ timeout: 10_000 })

      // KB current version is rendered in monospace.
      const kbCurrent = panel.locator('[data-testid="version-panel-kb-current"]')
      await expect(kbCurrent).toBeVisible()
      await expect(kbCurrent).toHaveText(/^v.+/)

      // Recheck button is hidden when disabled (spec: "no point").
      await expect(panel.locator('[data-testid="version-panel-recheck"]')).toHaveCount(0)

      // Upgrade button is hidden when disabled (no `outdated` state).
      await expect(panel.locator('[data-testid="version-panel-upgrade-button"]')).toHaveCount(0)
    })

    test('S13-B3: Claude Code section renders a status line', async ({ page }) => {
      await openHomeAndWait(page)
      await page.locator(STATUS_INDICATOR_BUTTON).first().click()
      // Wait for the panel itself before drilling into the Claude line.
      await expect(page.locator('[data-testid="version-panel"][data-state="ready"]')).toBeVisible({ timeout: 10_000 })

      const status = page.locator('[data-testid="version-panel-claude-status"]')
      await expect(status).toBeVisible()
      // Tier value reaches the DOM via data-tier; assert it's one of
      // the four valid states. The exact value depends on the test
      // host's claude binary, so we don't pin it.
      const tier = await status.getAttribute('data-tier')
      expect(['primary', 'best-effort', 'out-of-range', 'unknown']).toContain(tier ?? '')
    })
  })
})
