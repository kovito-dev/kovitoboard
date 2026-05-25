/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * URL routing tests
 *
 * Verify that direct URL access, SPA fallback, and browser
 * history navigation work correctly with react-router-dom.
 */
import { test, expect } from './helpers/l1-per-test-setup'

test.describe('URL routing', () => {
  test('/agents に直接アクセスできる', async ({ page }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    // The agent button in NavMenu is visible
    const agentButton = page.locator('button[title="Agents"]').first()
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

    // Recipe page heading (en: "App recipes").
    const heading = page.locator('h1').filter({ hasText: /recipes/i })
    await expect(heading).toBeVisible()

    // The Sample tab is the default tab and stays available in
    // v0.2.x. The Import tab was retired alongside the recipe
    // install temporary disable.
    const sampleTab = page.getByRole('button', { name: 'Sample recipes' })
    await expect(sampleTab).toBeVisible()
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
    const sessionsButton = page.locator('button[title="Sessions"]').first()
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
