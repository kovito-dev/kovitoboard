/**
 * URL routing tests
 *
 * Verify that direct URL access, SPA fallback, and browser
 * history navigation work correctly with react-router-dom.
 */
import { test, expect } from '@playwright/test'

test.describe('URL routing', () => {
  test('/agents に直接アクセスできる', async ({ page }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    // NavMenu の「エージェント」ボタンが表示されている
    const agentButton = page.locator('button[title="エージェント"]').first()
    await expect(agentButton).toBeVisible()

    // URL が /agents のまま維持されている
    expect(page.url()).toContain('/agents')
  })

  test('/sessions に直接アクセスできる', async ({ page }) => {
    await page.goto('/sessions')
    await page.waitForLoadState('networkidle')

    const body = await page.textContent('body')
    expect(body).toBeTruthy()

    // URL が /sessions のまま維持されている
    expect(page.url()).toContain('/sessions')
  })

  test('/recipes に直接アクセスできる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // Recipe page header
    const heading = page.locator('h1').filter({ hasText: 'レシピ' })
    await expect(heading).toBeVisible()

    // 「読み込み」タブが存在する
    const importTab = page.getByRole('button', { name: '読み込み' })
    await expect(importTab).toBeVisible()
  })

  test('存在しないパスは /agents にリダイレクトされる', async ({ page }) => {
    await page.goto('/nonexistent-path')
    await page.waitForLoadState('networkidle')

    // /agents にリダイレクトされている
    expect(page.url()).toContain('/agents')
  })

  test('ブラウザの戻る/進むが動作する', async ({ page }) => {
    // 1. /agents にアクセス
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    // 2. セッションに遷移
    const sessionsButton = page.locator('button[title="セッション"]').first()
    await sessionsButton.click()
    await page.waitForURL('**/sessions')

    // 3. ブラウザの「戻る」で /agents に戻る
    await page.goBack()
    await page.waitForURL('**/agents')
    expect(page.url()).toContain('/agents')

    // 4. ブラウザの「進む」で /sessions に戻る
    await page.goForward()
    await page.waitForURL('**/sessions')
    expect(page.url()).toContain('/sessions')
  })
})
