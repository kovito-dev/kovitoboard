/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe page tests
 *
 * Verify recipe page UI and API endpoints.
 * Does NOT test apply/export (file-system side effects) or
 * actual recipe parsing with real files.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('Recipe page', () => {
  test('レシピページに 3 つのタブが表示される', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // DEC-024 #5: Export tab was removed from /recipes (recipe export now
    // happens from the AmbientSidebar's per-app actions popover). The
    // remaining tabs are Sample / Import / History (en), or
    // サンプルレシピ / 読み込み / 履歴 (ja). The L1 fixture is locale=en.
    const sampleTab = page.getByRole('button', { name: 'Sample recipes' })
    const importTab = page.getByRole('button', { name: 'Import' })
    const historyTab = page.getByRole('button', { name: 'History' })

    await expect(sampleTab).toBeVisible()
    await expect(importTab).toBeVisible()
    await expect(historyTab).toBeVisible()
  })

  test('タブをクリックしてコンテンツが切り替わる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The default tab is "Sample recipes" (DEC-024 #5). Switch through
    // the other two tabs and verify at least one shows different content.
    const contentArea = page.locator('.overflow-y-auto').last()
    const initialContent = await contentArea.textContent()

    // Switch to History tab
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(300)
    const historyContent = await contentArea.textContent()

    // Switch to Import tab
    await page.getByRole('button', { name: 'Import' }).click()
    await page.waitForTimeout(300)
    const importContent = await contentArea.textContent()

    // At least one tab should show different content
    // (all three being identical would indicate tabs are broken)
    const allSame = initialContent === historyContent && historyContent === importContent
    expect(allSame).toBe(false)
  })

  test('recipes/parse API が空のリクエストを拒否する', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/recipes/parse`, {
      data: { content: '' },
    })
    // Empty content should result in a 400 Bad Request
    expect(res.status()).toBe(400)
  })

  test('recipes/history API が配列を返す', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/recipes/history`)
    expect(res.ok()).toBeTruthy()

    const body = await res.json()
    expect(Array.isArray(body)).toBeTruthy()
  })

  test('recipes/app-scan API が応答する', async ({ request }) => {
    // /api/recipes/app-scan now requires an appId query parameter; an
    // empty/missing appId returns 400. Pass a stable dummy id — the
    // endpoint will scan whatever exists under app/<id>/ and reply with
    // a scan result object (empty fields are fine when the dir is absent).
    const res = await request.get(`${API_BASE}/api/recipes/app-scan?appId=l1-recipe-page-probe`)
    expect(res.ok()).toBeTruthy()

    const body = await res.json()
    // Should return an object (scan result)
    expect(typeof body).toBe('object')
  })
})
