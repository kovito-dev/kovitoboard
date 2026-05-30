/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Apps screen — 3-tab navigation + "+ Add app" jump
 * (BS-T12, tester request v1.1 §1.2 / judgement v2.5 §4'.2 / BS-L8).
 *
 * Verifies that the v0.2.1 Apps screen exposes the new 3-tab layout
 * (Apps / Sample apps / Recipes) and that the "+ Add app" affordance
 * on the Apps tab routes the user to the Sample apps tab via in-page
 * state (no `/api/recipes/install` invocation, no URL change — BS-L8
 * network silence).
 *
 * Coverage:
 *   - BS-T12-a: all three tabs render on first navigation to /recipes
 *     and the Apps tab is the default active tab.
 *   - BS-T12-b: clicking each tab swaps the active panel
 *     (`apps-screen-panel-${tabId}`).
 *   - BS-T12-c: clicking "+ Add app" on the Apps tab jumps to the
 *     Sample apps tab and fires zero `/api/recipes/install` requests.
 */
import { test, expect } from './helpers/l1-per-test-setup'

test.describe('Apps screen navigation (BS-T12)', () => {
  test('BS-T12-a: /recipes surfaces the 3-tab layout with Apps as the default active tab', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('apps-screen-tab-apps')).toBeVisible()
    await expect(page.getByTestId('apps-screen-tab-samples')).toBeVisible()
    await expect(page.getByTestId('apps-screen-tab-recipes')).toBeVisible()

    // Apps panel is the default. The other two panels are conditionally
    // mounted, so the active panel can be asserted on its testid while
    // the others stay absent.
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()
    await expect(page.getByTestId('apps-screen-panel-samples')).toHaveCount(0)
    await expect(page.getByTestId('apps-screen-panel-recipes')).toHaveCount(0)
  })

  test('BS-T12-b: clicking each tab swaps the active panel', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('apps-screen-tab-samples').click()
    await expect(page.getByTestId('apps-screen-panel-samples')).toBeVisible()
    await expect(page.getByTestId('apps-screen-panel-apps')).toHaveCount(0)
    await expect(page.getByTestId('apps-screen-panel-recipes')).toHaveCount(0)

    await page.getByTestId('apps-screen-tab-recipes').click()
    await expect(page.getByTestId('apps-screen-panel-recipes')).toBeVisible()
    await expect(page.getByTestId('apps-screen-panel-samples')).toHaveCount(0)
    await expect(page.getByTestId('apps-screen-panel-apps')).toHaveCount(0)

    await page.getByTestId('apps-screen-tab-apps').click()
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()
    await expect(page.getByTestId('apps-screen-panel-samples')).toHaveCount(0)
    await expect(page.getByTestId('apps-screen-panel-recipes')).toHaveCount(0)
  })

  test('BS-T12-c: "+ Add app" jumps to the Sample apps tab without firing /api/recipes/install (BS-L8)', async ({
    page,
  }) => {
    const installCalls: string[] = []
    await page.route('**/api/recipes/install', async (route) => {
      installCalls.push(route.request().url())
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RecipeInstallDisabled' }),
      })
    })

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()

    const urlBefore = page.url()
    await page.getByTestId('apps-tab-add-app-button').click()

    // The jump is in-page state, not a route change — the SPA stays
    // on /recipes and only the active panel switches.
    await expect(page.getByTestId('apps-screen-panel-samples')).toBeVisible()
    await expect(page.getByTestId('apps-screen-panel-apps')).toHaveCount(0)
    expect(page.url()).toBe(urlBefore)

    // BS-L8: no `/api/recipes/install` request is fired during the
    // jump (the legacy 7-layer install dialog is gone in v0.2.x).
    await page.waitForTimeout(200)
    expect(installCalls).toEqual([])
  })
})
