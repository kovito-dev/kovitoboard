/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe install temporary disable — E2E tests (v0.2.x).
 *
 * Verifies the v0.2.x disable contract from
 * `docs/specs/recipe-system.md` §10.6 and
 * `docs/specs/http-api-contract.md` §4.3.8.A:
 *
 *   - `POST /api/recipes/install` returns 410 Gone with the
 *     `RecipeInstallDisabled` body schema and does NOT side-effect
 *     install-session storage or tmux delivery.
 *   - `POST /api/recipes/apply` returns 410 Gone with the
 *     `RecipeApplyRemoved` body schema (the deprecated apply flow
 *     was physically removed).
 *   - The sample recipes page no longer surfaces install /
 *     reinstall buttons; the install-disabled notice is rendered
 *     instead, and the legacy `Import` tab is gone from the recipes
 *     page.
 *
 * Grandfather behaviour (manifest read / uninstall / export /
 * dispatcher) is covered by separate specs (recipe-handler-e2e.spec.ts
 * for the dispatcher path) and is intentionally out of scope here.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('Recipe install disable (v0.2.x)', () => {
  test('POST /api/recipes/install returns 410 Gone with RecipeInstallDisabled body', async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/api/recipes/install`, {
      data: {
        recipe: {
          metadata: { name: 'placeholder', recipeId: 'placeholder' },
        },
        agentId: 'kovito-concierge',
        recipeSource: 'sample',
      },
    })
    expect(res.status()).toBe(410)
    const body = (await res.json()) as {
      error: string
      message: string
      details: {
        endpoint: string
        kbVersion: string
        plannedReenable: string
        grandfatherDocs: string
      }
    }
    expect(body.error).toBe('RecipeInstallDisabled')
    expect(body.message).toContain('disabled in v0.2.x')
    expect(body.details.endpoint).toBe('/api/recipes/install')
    expect(body.details.kbVersion).toBe('0.2.x')
    expect(body.details.plannedReenable).toContain('v0.3.0')
    expect(body.details.grandfatherDocs).toContain('recipe-system.md')
  })

  test('POST /api/recipes/apply returns 410 Gone with RecipeApplyRemoved body', async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/api/recipes/apply`, {
      data: {
        recipe: { metadata: { name: 'placeholder' } },
        inspection: { verdict: 'safe' },
      },
    })
    expect(res.status()).toBe(410)
    const body = (await res.json()) as {
      error: string
      message: string
      details: {
        endpoint: string
        kbVersion: string
        plannedReenable: string
        grandfatherDocs: string
      }
    }
    expect(body.error).toBe('RecipeApplyRemoved')
    expect(body.message).toContain('removed in v0.2.x')
    expect(body.details.endpoint).toBe('/api/recipes/apply')
    expect(body.details.kbVersion).toBe('0.2.x')
    expect(body.details.plannedReenable).toContain('not planned')
  })

  test('Recipes page hides install / reinstall buttons and shows the disable notice', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The disable notice now lives on the v0.2.1 Sample apps tab
    // (judgement doc 4'.4). The Apps tab is the default, so we
    // switch to Sample apps first to surface the banner.
    await page.getByTestId('apps-screen-tab-samples').click()
    await expect(
      page.getByTestId('samples-tab-coming-soon-banner'),
    ).toBeVisible()

    // No card surfaces an install or reinstall button — the buttons
    // were removed in v0.2.x alongside the install endpoint disable.
    // (The v0.2.1 Sample apps tab renders an Enable button instead,
    // which goes through bundled-enable, not the install path.)
    await expect(page.locator('[data-testid^="recipe-install-button-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="recipe-reinstall-button-"]')).toHaveCount(0)
  })

  test('Recipes page no longer exposes the Import tab', async ({ page }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The Import tab was retired alongside the apply endpoint
    // removal; the v0.2.1 3-tab restructure exposes Apps / Sample
    // apps / Recipes only.
    await expect(page.getByTestId('apps-screen-tab-apps')).toBeVisible()
    await expect(
      page.getByTestId('apps-screen-tab-samples'),
    ).toBeVisible()
    await expect(
      page.getByTestId('apps-screen-tab-recipes'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /^Import$/ })).toHaveCount(0)
  })

  test('Sample install flow surfaces the disable notice without firing /api/recipes/install', async ({
    page,
  }) => {
    let installCalled = false
    await page.route('**/api/recipes/install', async (route) => {
      installCalled = true
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'RecipeInstallDisabled',
          message: 'Recipe install is disabled in v0.2.x.',
          details: {
            endpoint: '/api/recipes/install',
            kbVersion: '0.2.x',
            plannedReenable: 'v0.3.0',
            grandfatherDocs: 'docs/specs/recipe-system.md 10.6',
          },
        }),
      })
    })

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // The disable notice lives on the Sample apps tab in v0.2.1;
    // switch from the default Apps tab to surface it.
    await page.getByTestId('apps-screen-tab-samples').click()
    await expect(
      page.getByTestId('samples-tab-coming-soon-banner'),
    ).toBeVisible()

    // The renderer has no surface that can issue POST
    // /api/recipes/install anymore — confirm by asserting no install
    // request happens after the page settles. (The Sample apps tab
    // Enable button hits /api/recipes/sample/:recipeId/enable, not
    // the install endpoint.)
    await page.waitForTimeout(200)
    expect(installCalled).toBe(false)
  })
})
