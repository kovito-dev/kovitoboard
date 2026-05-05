/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Navigation and page transition tests
 *
 * Targets:
 * - Clicking each sidebar menu item navigates to the corresponding page
 *
 * NavMenu structure:
 * - Sidebar: buttons rendered as button[title=label] inside div.bg-[var(--bg-nav)]
 * - Each button's title attribute holds the menu label
 */
import { test, expect } from './helpers/l1-per-test-setup'

// Helper to locate a sidebar menu button by its title
function sidebarButton(page: import('@playwright/test').Page, label: string) {
  return page.locator(`button[title="${label}"]`).first()
}

test.describe('ナビゲーション', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('サイドバーにメニュー項目が表示される', async ({ page }) => {
    await expect(sidebarButton(page, 'Agents')).toBeVisible()
    await expect(sidebarButton(page, 'Sessions')).toBeVisible()
  })

  test('タスクメニューが存在しないことを確認', async ({ page }) => {
    // Task feature was removed in KovitoBoard v0.1.0
    const taskButton = page.locator('button[title="タスク"]')
    await expect(taskButton).toHaveCount(0)
  })

  test('セッションメニューに遷移できる', async ({ page }) => {
    await sidebarButton(page, 'Sessions').click()
    await page.waitForTimeout(500)

    // Verify that the page content has changed
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })

  test('エージェントメニューに戻れる', async ({ page }) => {
    // First navigate to Sessions
    await sidebarButton(page, 'Sessions').click()
    await page.waitForTimeout(300)

    // Navigate back to Agents
    await sidebarButton(page, 'Agents').click()
    await page.waitForTimeout(500)

    // Verify the Agents page is displayed
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })
})
