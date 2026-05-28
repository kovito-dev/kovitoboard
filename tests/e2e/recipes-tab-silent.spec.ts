/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipes tab network silence (BS-T14, tester request v1.1 §1.2).
 *
 * Verifies the v0.2.1 invariant that displaying the Recipes tab does
 * NOT trigger any `/api/recipes/hub/*` request — the tab is a static
 * Coming-Soon mockup until v0.3.0 when KovitoHub launches
 * (`docs/specs/recipe-system.md` v1.10 §10.6, judgement v2.5 §4'.4
 * BS-L10).
 *
 * Coverage:
 *   - BS-T14-a: switching to the Recipes tab does not fire any
 *     `/api/recipes/hub/**` request during the tab's render + idle
 *     window.
 *   - BS-T14-b: clicking the disabled Install mockup buttons does
 *     not fire any `/api/recipes/hub/**` or `/api/recipes/install`
 *     request (the buttons are aria-disabled but a regression that
 *     re-enables them would otherwise slip past the network silence
 *     gate).
 */
import { test, expect } from './helpers/l1-per-test-setup'

test.describe('Recipes tab network silence (BS-T14)', () => {
  test('BS-T14-a: switching to the Recipes tab fires zero /api/recipes/hub/* requests (BS-L10)', async ({
    page,
  }) => {
    const hubRequests: string[] = []
    await page.route('**/api/recipes/hub/**', async (route) => {
      hubRequests.push(route.request().url())
      // 410 keeps any future regression deterministic (a real hub
      // endpoint would return data; a 410 surfaces the regression in
      // both UI side effects and the network log).
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RecipeHubUnavailable' }),
      })
    })

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('apps-screen-tab-recipes').click()
    // The static mockup renders synchronously; give the page a beat
    // to settle so any async hub fetch (which we don't expect) would
    // have a chance to fire before we assert silence.
    await expect(page.getByTestId('recipes-tab-banner')).toBeVisible()
    await page.waitForTimeout(300)

    expect(hubRequests).toEqual([])
  })

  test('BS-T14-b: clicking the disabled Install mockup does not fire /api/recipes/install or hub requests', async ({
    page,
  }) => {
    const blockedRequests: string[] = []
    await page.route(
      (url) =>
        url.pathname.startsWith('/api/recipes/hub/') ||
        url.pathname === '/api/recipes/install',
      async (route) => {
        blockedRequests.push(route.request().url())
        await route.fulfill({
          status: 410,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'RecipeInstallDisabled' }),
        })
      },
    )

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('apps-screen-tab-recipes').click()
    await expect(page.getByTestId('recipes-tab-banner')).toBeVisible()

    // Click every mockup install button — they are aria-disabled but
    // we still issue the click so a regression that drops the
    // `pointer-events: none` / aria-disabled gate is caught by this
    // assert. Playwright `.click({ force: true })` lets us reach a
    // visually disabled target without flakiness.
    const installButtons = page.locator(
      '[data-testid^="recipes-tab-mockup-install-"]',
    )
    const count = await installButtons.count()
    for (let i = 0; i < count; i++) {
      // `force: true` because aria-disabled + Tailwind cursor-not-allowed
      // mark the button as non-actionable from Playwright's standpoint.
      await installButtons.nth(i).click({ force: true })
    }
    await page.waitForTimeout(300)

    expect(blockedRequests).toEqual([])
  })
})
