/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe reinstall flow — E2E tests (DEC-024 #4, spec §8.2 S15-a〜e).
 *
 * Strategy: stub `/api/recipes/sample`, `/api/recipes/parse`, and
 * `/api/recipes/install` so the renderer flow can be exercised
 * without a real claude-bridge / tmux session. The server-side
 * `buildRecipePrompt` reinstall-detection section is covered by
 * tests/unit/recipe-applicator-prompt.test.ts.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const SAMPLE_INSTALLED_RECIPE = {
  id: 'document-viewer',
  metadata: {
    name: 'Document Viewer',
    description: 'Browse Markdown documents in the project.',
    version: '1.1.0',
    author: 'kovito-test',
  },
  sourcePath: '/tmp/recipes/document-viewer',
  sourceFormat: 'directory',
  hash: 'sha256:reinstall-fixture',
  installed: true,
  historyEntry: {
    id: 'r_20260503_001',
    appliedAt: '2026-05-03T00:00:00.000Z',
    recipeId: 'document-viewer',
    menu: ['document-viewer'],
  },
}

const SAMPLE_AVAILABLE_RECIPE = {
  id: 'todo-manager',
  metadata: {
    name: 'TODO Manager',
    description: 'Manage TODO items.',
    version: '1.0.0',
    author: 'kovito-test',
  },
  sourcePath: '/tmp/recipes/todo-manager',
  sourceFormat: 'directory',
  hash: 'sha256:available-fixture',
  installed: false,
}

async function stubSampleList(page: import('@playwright/test').Page) {
  await page.route('**/api/recipes/sample', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([SAMPLE_INSTALLED_RECIPE, SAMPLE_AVAILABLE_RECIPE]),
    })
  })
}

async function stubParse(
  page: import('@playwright/test').Page,
  options: { pureDeclarative: boolean },
) {
  await page.route('**/api/recipes/parse', async (route) => {
    const recipe = {
      metadata: {
        recipeId: 'document-viewer',
        name: 'Document Viewer',
        description: 'Browse Markdown documents in the project.',
        version: '1.1.0',
        author: 'kovito-test',
      },
      artifacts: [],
      menu: [
        {
          id: 'document-viewer',
          label: 'Documents',
          icon: 'sessions',
          page: 'pages/IndexPage',
        },
      ],
      hash: 'sha256:reinstall-fixture',
      sourceFormat: 'directory',
      sourcePath: '/tmp/recipes/document-viewer',
    }
    const inspection = {
      verdict: 'safe',
      findings: [],
      pureDeclarative: options.pureDeclarative,
      detectedNonDeclarativePatterns: options.pureDeclarative
        ? []
        : ['express-router', 'direct-fetch'],
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recipe, inspection }),
    })
  })
}

async function stubInstall(page: import('@playwright/test').Page) {
  await page.route('**/api/recipes/install', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        agentId: 'kovito-concierge',
        via: 'tmux',
        windowName: 'kovito-concierge',
      }),
    })
  })
}

async function gotoRecipes(page: import('@playwright/test').Page) {
  await page.goto('/recipes')
  await page.waitForLoadState('networkidle')
}

test.describe('Recipe reinstall flow (DEC-024 #4)', () => {
  test('S15-a: installed cards expose a "Reinstall" button', async ({ page }) => {
    await stubSampleList(page)
    await gotoRecipes(page)
    await expect(
      page.getByTestId(`recipe-reinstall-button-${SAMPLE_INSTALLED_RECIPE.id}`),
    ).toBeVisible()
  })

  test('S15-b: installed cards no longer expose an "Uninstall" button', async ({ page }) => {
    await stubSampleList(page)
    await gotoRecipes(page)
    // The legacy uninstall button was retired in DEC-024 D-6 — app
    // deletion now goes through the NavMenu Remove App button.
    await expect(
      page.getByTestId(`recipe-uninstall-button-${SAMPLE_INSTALLED_RECIPE.id}`),
    ).toHaveCount(0)
    // Available-section cards continue to show the install button.
    await expect(
      page.getByTestId(`recipe-install-button-${SAMPLE_AVAILABLE_RECIPE.id}`),
    ).toBeVisible()
  })

  test('S15-c: reinstall click -> warning -> picker -> install POST -> navigate (non-pure)', async ({ page }) => {
    await stubSampleList(page)
    await stubParse(page, { pureDeclarative: false })
    await stubInstall(page)
    const installPromise = page.waitForRequest('**/api/recipes/install')

    await gotoRecipes(page)
    await page
      .getByTestId(`recipe-reinstall-button-${SAMPLE_INSTALLED_RECIPE.id}`)
      .click()

    // Warning dialog opens because the parse stub returned pureDeclarative=false.
    await expect(page.getByTestId('recipe-install-warning-dialog')).toBeVisible()
    await expect(
      page.getByTestId('recipe-install-warning-pattern-express-router'),
    ).toBeVisible()
    await page.getByTestId('recipe-install-warning-continue').click()

    // Agent picker appears with kovito-concierge from blank-onboarded.
    await expect(page.getByTestId('recipe-install-agent-picker')).toBeVisible()
    await page
      .getByTestId('recipe-install-picker-option-kovito-concierge')
      .click()
    await page.getByTestId('recipe-install-picker-confirm').click()

    const req = await installPromise
    expect(req.method()).toBe('POST')
    const body = req.postDataJSON() as {
      agentId: string
      recipeSource: string
      recipe: { metadata: { recipeId: string } }
    }
    expect(body.agentId).toBe('kovito-concierge')
    expect(body.recipeSource).toBe('sample')
    expect(body.recipe.metadata.recipeId).toBe('document-viewer')

    // The race-fix in commit a86e77e appends `&awaitNewSession=1` to the URL
    // so the dashboard waits for the freshly-spawned session before opening it.
    await expect(page).toHaveURL(
      /\/agents\/kovito-concierge\?openLatestSession=1(&awaitNewSession=1)?$/,
    )
  })

  test('S15-d: pure declarative recipe skips the warning dialog', async ({ page }) => {
    await stubSampleList(page)
    await stubParse(page, { pureDeclarative: true })
    await stubInstall(page)

    await gotoRecipes(page)
    await page
      .getByTestId(`recipe-reinstall-button-${SAMPLE_INSTALLED_RECIPE.id}`)
      .click()

    // Picker shows directly without surfacing the warning dialog.
    await expect(page.getByTestId('recipe-install-agent-picker')).toBeVisible()
    await expect(page.getByTestId('recipe-install-warning-dialog')).toHaveCount(0)
  })

  // The reinstall-detection section's content is verified at the
  // unit level (tests/unit/recipe-applicator-prompt.test.ts §
  // "buildRecipePrompt — reinstall detection (DEC-024 #4)"). An L1
  // assertion would require capturing the actual prompt the server
  // sends to tmux, which is outside the renderer-only mocking
  // strategy used here. Tracked for tester to wire once Phase H's
  // /ext/<id> race is also resolved.
  test.fixme('S15-e: reinstall section appears in the prompt (server-side capture)', async () => {
    /* covered by unit tests until L1 prompt-capture infra lands */
  })
})
