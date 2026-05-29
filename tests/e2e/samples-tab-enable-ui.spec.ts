/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sample apps tab — Enable toggle UI flow
 * (BS-T8, tester request v1.1 §1.2 / judgement v2.5 §4.1 / BS-L1).
 *
 * Verifies the end-to-end UI flow that lets a user enable a bundled
 * sample recipe via the Sample apps tab:
 *
 *   1. Click the Enable button on a sample card.
 *   2. The renderer fires `POST /api/recipes/sample/:recipeId/enable`
 *      and surfaces the success state inline (the card grows a
 *      `samples-tab-card-${id}-enabled-badge`).
 *   3. Switching back to the Apps tab shows the newly bundled app as
 *      a row in the Apps tab list.
 *
 * Coverage:
 *   - BS-T8-a: Enable button click materialises the bundled-enabled
 *     state on the Sample card (badge + manage-hint) and exposes the
 *     newly enabled app on the Apps tab.
 *   - BS-T8-b: the click does NOT fire `POST /api/recipes/install`
 *     (the legacy 7-layer install path is gone in v0.2.x).
 *
 * Fixture note: the L1 fixture's `app/menu.ts` omits the type
 * annotation that `appendMenuEntry` requires, so the bundled enable
 * fails with 500 `EnableMenuTsAppendFailed` unless we patch the
 * annotation in beforeEach. The workaround is reverted in afterEach.
 * See Phase 1 escalate finding #1 for the upstream cleanup.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import {
  rewriteMenuTsForEnable,
  restoreMenuTs,
  cleanupAppDir,
} from './helpers/v021-bundled-helpers'

const RECIPE_ID = 'document-viewer'
const APP_ID = 'document-viewer'

test.describe('Sample apps tab — Enable toggle UI (BS-T8)', () => {
  let originalMenuTs: string | null = null

  test.beforeEach(async ({ kbFixture }) => {
    originalMenuTs = rewriteMenuTsForEnable(kbFixture.projectRoot)
  })

  test.afterEach(async ({ kbFixture }) => {
    cleanupAppDir(kbFixture.projectRoot, APP_ID)
    if (originalMenuTs !== null) {
      restoreMenuTs(kbFixture.projectRoot, originalMenuTs)
      originalMenuTs = null
    }
  })

  test('BS-T8-a: clicking Enable on a sample card materialises the badge + surfaces the app on the Apps tab (BS-L1)', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('apps-screen-tab-samples').click()
    await expect(page.getByTestId('apps-screen-panel-samples')).toBeVisible()

    // Wait for the bundled samples to surface — the scan happens
    // synchronously on the renderer's first sample fetch, so we tie
    // the wait to the card testid rather than `networkidle`.
    const sampleCard = page.getByTestId(`samples-tab-card-${RECIPE_ID}`)
    await expect(sampleCard).toBeVisible()
    await expect(sampleCard).toHaveAttribute('data-enabled', 'false')

    // Listen for the wire request so we can confirm both the request
    // and its 200 response landed before we assert the UI side-effects.
    const enableRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().endsWith(`/api/recipes/sample/${RECIPE_ID}/enable`),
    )
    const enableResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith(`/api/recipes/sample/${RECIPE_ID}/enable`) &&
        resp.status() === 200,
    )

    await page
      .getByTestId(`samples-tab-card-${RECIPE_ID}-enable-button`)
      .click()

    await enableRequestPromise
    await enableResponsePromise

    // BS-L1: the renderer flips the card into the enabled state in
    // place — the badge + manage-hint surface and the enable button
    // disappears.
    await expect(
      page.getByTestId(`samples-tab-card-${RECIPE_ID}-enabled-badge`),
    ).toBeVisible()
    await expect(
      page.getByTestId(`samples-tab-card-${RECIPE_ID}-manage-hint`),
    ).toBeVisible()
    await expect(
      page.getByTestId(`samples-tab-card-${RECIPE_ID}-enable-button`),
    ).toHaveCount(0)
    await expect(sampleCard).toHaveAttribute('data-enabled', 'true')

    // Switching to the Apps tab surfaces the newly bundled app as a
    // row — the bundled-installer wrote the AppManifest + menu.ts
    // entry, and the scanner picks it up on the renderer's refetch.
    await page.getByTestId('apps-screen-tab-apps').click()
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()
    await expect(page.getByTestId(`apps-tab-row-${APP_ID}`)).toBeVisible()
  })

  test('BS-T8-b: Enable click does NOT fire POST /api/recipes/install (legacy path retired)', async ({
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
    await page.getByTestId('apps-screen-tab-samples').click()

    const sampleCard = page.getByTestId(`samples-tab-card-${RECIPE_ID}`)
    await expect(sampleCard).toBeVisible()
    const enableResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith(`/api/recipes/sample/${RECIPE_ID}/enable`) &&
        resp.status() === 200,
    )
    await page
      .getByTestId(`samples-tab-card-${RECIPE_ID}-enable-button`)
      .click()
    await enableResponsePromise

    await page.waitForTimeout(200)
    expect(installCalls).toEqual([])
  })
})
