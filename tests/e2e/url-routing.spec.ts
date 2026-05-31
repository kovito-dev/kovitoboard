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

    // v0.2.1 (judgement doc 4'.2): the legacy "App recipes" /
    // "Sample recipes" labels were rebranded to "Apps" / "Sample
    // apps" alongside the 3-tab restructure. The route key
    // `/recipes` is preserved for backward compatibility.
    const heading = page.locator('h1').filter({ hasText: /^Apps$/i })
    await expect(heading).toBeVisible()

    // The Apps tab is the default landing tab; the Sample apps and
    // Recipes tabs are reachable from the tab bar.
    await expect(page.getByTestId('apps-screen-tab-apps')).toBeVisible()
    await expect(
      page.getByTestId('apps-screen-tab-samples'),
    ).toBeVisible()
    await expect(
      page.getByTestId('apps-screen-tab-recipes'),
    ).toBeVisible()
  })

  test('存在しないパスは /agents にリダイレクトされる', async ({ page }) => {
    await page.goto('/nonexistent-path')
    await page.waitForLoadState('networkidle')

    // Redirected to /agents
    expect(page.url()).toContain('/agents')
  })

  test('ブラウザの戻る/進むが動作する', async ({ page }) => {
    // Exercise browser back/forward across two URL-stable routes
    // (`/agents` <-> `/recipes`, the latter being the rebranded "Apps"
    // screen). `/sessions` is deliberately NOT used here: it
    // immediately auto-redirects to `/sessions/<latestId>` via
    // `<Navigate replace />` once `useIPC`'s async session load
    // resolves, and under full-suite load that pending replace-redirect
    // races `goBack()` — leaving the history stack in a non-deterministic
    // state and flaking the back/forward assertions. Both `/agents` and
    // `/recipes` settle synchronously with no follow-up navigation, so
    // the history stack is stable.

    // 1. Access /agents
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/agents$/)

    // 2. Navigate to the Apps screen (route key `/recipes` is retained)
    const appsButton = page.locator('button[title="Apps"]').first()
    await appsButton.click()
    await expect(page).toHaveURL(/\/recipes$/)

    // 3. Use browser "back" to return to /agents
    await page.goBack()
    await expect(page).toHaveURL(/\/agents$/)
    expect(page.url()).toContain('/agents')

    // 4. Use browser "forward" to return to /recipes
    await page.goForward()
    await expect(page).toHaveURL(/\/recipes$/)
    expect(page.url()).toContain('/recipes')
  })
})
