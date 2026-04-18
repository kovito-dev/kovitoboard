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

    // The agent button in NavMenu is visible
    const agentButton = page.locator('button[title="エージェント"]').first()
    await expect(agentButton).toBeVisible()

    // URL remains /agents
    expect(page.url()).toContain('/agents')
  })

  test('/sessions に直接アクセスできる', async ({ page }) => {
    await page.goto('/sessions')
    await page.waitForLoadState('networkidle')

    const body = await page.textContent('body')
    expect(body).toBeTruthy()

    // URL remains /sessions
    expect(page.url()).toContain('/sessions')
  })

  test('/recipes に直接アクセスできる', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // Recipe page heading
    const heading = page.locator('h1').filter({ hasText: 'レシピ' })
    await expect(heading).toBeVisible()

    // The import tab exists
    const importTab = page.getByRole('button', { name: '読み込み' })
    await expect(importTab).toBeVisible()
  })

  test('存在しないパスは /agents にリダイレクトされる', async ({ page }) => {
    await page.goto('/nonexistent-path')
    await page.waitForLoadState('networkidle')

    // Redirected to /agents
    expect(page.url()).toContain('/agents')
  })

  test('ブラウザの戻る/進むが動作する', async ({ page }) => {
    // 1. Access /agents
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    // 2. Navigate to sessions
    const sessionsButton = page.locator('button[title="セッション"]').first()
    await sessionsButton.click()
    await page.waitForURL('**/sessions')

    // 3. Use browser "back" to return to /agents
    await page.goBack()
    await page.waitForURL('**/agents')
    expect(page.url()).toContain('/agents')

    // 4. Use browser "forward" to go back to /sessions
    await page.goForward()
    await page.waitForURL('**/sessions')
    expect(page.url()).toContain('/sessions')
  })
})
