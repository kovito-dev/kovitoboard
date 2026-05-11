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
  test('レシピページに 2 つのタブが表示される', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The Export tab was retired earlier (recipe export now happens
    // from the AmbientSidebar's per-app actions popover). The Import
    // tab was retired in v0.2.x alongside the recipe install
    // temporary disable (recipe-system.md §10.6). Only Sample /
    // History remain. The L1 fixture is locale=en.
    const sampleTab = page.getByRole('button', { name: 'Sample recipes' })
    const historyTab = page.getByRole('button', { name: 'History' })
    const importTab = page.getByRole('button', { name: 'Import' })

    await expect(sampleTab).toBeVisible()
    await expect(historyTab).toBeVisible()
    await expect(importTab).toHaveCount(0)
  })

  test('タブをクリックしてコンテンツが切り替わる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The default tab is "Sample recipes". Switch to the History tab
    // and confirm the content area updates (a smoke check that the
    // remaining tabs still wire up correctly).
    const contentArea = page.locator('.overflow-y-auto').last()
    const initialContent = await contentArea.textContent()

    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(300)
    const historyContent = await contentArea.textContent()

    expect(initialContent).not.toBe(historyContent)
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
