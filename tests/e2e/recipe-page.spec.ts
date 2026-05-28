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

    // v0.2.1 (judgement doc 4'.2): the legacy 2-tab Sample / History
    // container was replaced by the 3-tab Apps / Sample apps /
    // Recipes restructure. Import / Export / History tabs are no
    // longer present. The L1 fixture is locale=en.
    const appsTab = page.getByTestId('apps-screen-tab-apps')
    const samplesTab = page.getByTestId('apps-screen-tab-samples')
    const recipesTab = page.getByTestId('apps-screen-tab-recipes')
    const importTab = page.getByRole('button', { name: 'Import' })
    const historyTab = page.getByRole('button', { name: /^History$/ })

    await expect(appsTab).toBeVisible()
    await expect(samplesTab).toBeVisible()
    await expect(recipesTab).toBeVisible()
    await expect(importTab).toHaveCount(0)
    await expect(historyTab).toHaveCount(0)
  })

  test('タブをクリックしてコンテンツが切り替わる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The default tab is "Apps". Switch to the Sample apps tab and
    // confirm the content area updates (a smoke check that the
    // 3-tab wiring works end-to-end).
    await expect(
      page.getByTestId('apps-screen-panel-apps'),
    ).toBeVisible()

    await page.getByTestId('apps-screen-tab-samples').click()
    await expect(
      page.getByTestId('apps-screen-panel-samples'),
    ).toBeVisible()
    await expect(
      page.getByTestId('samples-tab-coming-soon-banner'),
    ).toBeVisible()
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
