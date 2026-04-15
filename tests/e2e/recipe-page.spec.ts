/**
 * Recipe page tests
 *
 * Verify recipe page UI and API endpoints.
 * Does NOT test apply/export (file-system side effects) or
 * actual recipe parsing with real files.
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('Recipe page', () => {
  test('レシピページに 3 つのタブが表示される', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    const importTab = page.getByRole('button', { name: '読み込み' })
    const historyTab = page.getByRole('button', { name: '履歴' })
    const exportTab = page.getByRole('button', { name: '書き出し' })

    await expect(importTab).toBeVisible()
    await expect(historyTab).toBeVisible()
    await expect(exportTab).toBeVisible()
  })

  test('タブをクリックしてコンテンツが切り替わる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // Default tab is import — get initial content
    const contentArea = page.locator('.overflow-y-auto').last()
    const initialContent = await contentArea.textContent()

    // Switch to history tab
    await page.getByRole('button', { name: '履歴' }).click()
    await page.waitForTimeout(300)
    const historyContent = await contentArea.textContent()

    // Switch to export tab
    await page.getByRole('button', { name: '書き出し' }).click()
    await page.waitForTimeout(300)
    const exportContent = await contentArea.textContent()

    // At least one tab should show different content
    // (all three being identical would indicate tabs are broken)
    const allSame = initialContent === historyContent && historyContent === exportContent
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
    const res = await request.get(`${API_BASE}/api/recipes/app-scan`)
    expect(res.ok()).toBeTruthy()

    const body = await res.json()
    // Should return an object (scan result)
    expect(typeof body).toBe('object')
  })
})
