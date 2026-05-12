/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E — capture endpoint opt-in mechanism (v0.2.0 Phase 1 ①).
 *
 * Walks the five canonical paths from `http-api-contract.md` v1.3
 * §10.6.3 through the running KovitoBoard server:
 *
 *   1. capture.requires declared + approved          → 204
 *   2. capture.requires declared + not approved      → 403 CaptureNotApproved
 *   3. capture.requires not declared (kind unknown)  → 403 CaptureNotDeclared
 *   4. no active recipe (unknown appId)              → 403 NoActiveRecipe
 *   5. grandfather recipe (approvedCaptures empty)   → 403 CaptureNotApproved
 *
 * Each test seeds the manifest store via the same KB_E2E_MODE seam
 * the recipe-handler suite uses (`_test/issue-nonce` →
 * `mark-installed`). The v0.2.x install path itself is disabled
 * (410 Gone), so the test seam is the only way to bring a manifest
 * with v0.2.0 fields into existence in the running server.
 *
 * @see docs/specs/recipe-system.md v1.4 §6.10
 * @see docs/specs/app-directory-extension.md v1.2 §10.5.2
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const TEST_RECIPE_ID = 'e2e-capture-optin'

interface InstallParams {
  approvedCaptures?: ('a11y' | 'exposed-context')[]
}

async function installCaptureRecipe(
  request: import('@playwright/test').APIRequestContext,
  params: InstallParams = {},
): Promise<void> {
  const scopes = ['own-data']
  const apiSection = { scopes, calls: [] }
  const recipeHash = `e2e-capture-hash-${Date.now()}`
  const approvedCaptures = params.approvedCaptures ?? []

  await request.post(`${API_BASE}/api/recipes/_test/clear-manifest`, {
    data: { appId: TEST_RECIPE_ID },
  })
  const nonceRes = await request.post(`${API_BASE}/api/recipes/_test/issue-nonce`, {
    data: {
      recipeId: TEST_RECIPE_ID,
      recipeHash,
      recipeVersion: '1.0.0',
      recipeSource: 'sample',
      approvedScopes: scopes,
      approvedCaptures,
      api: apiSection,
    },
  })
  expect(nonceRes.ok()).toBeTruthy()
  const { installNonce } = (await nonceRes.json()) as { installNonce: string }

  const res = await request.post(
    `${API_BASE}/api/recipes/${TEST_RECIPE_ID}/mark-installed`,
    {
      data: {
        appId: TEST_RECIPE_ID,
        approvedScopes: scopes,
        approvedCaptures,
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
        recipeHash,
        installNonce,
        api: apiSection,
      },
    },
  )
  expect(res.ok()).toBeTruthy()
}

test.describe('Capture opt-in (v0.2.0)', () => {
  test('approves a kind that the user accepted at install time', async ({ request }) => {
    await installCaptureRecipe(request, { approvedCaptures: ['a11y'] })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(204)
  })

  test('rejects a kind that is not in approvedCaptures', async ({ request }) => {
    await installCaptureRecipe(request, { approvedCaptures: ['exposed-context'] })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('CaptureNotApproved')
  })

  test('rejects an unknown kind path segment as CaptureNotDeclared', async ({ request }) => {
    await installCaptureRecipe(request, { approvedCaptures: ['a11y'] })

    const res = await request.post(`${API_BASE}/api/app/capture/camera`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('CaptureNotDeclared')
  })

  test('rejects an unknown appId as NoActiveRecipe', async ({ request }) => {
    // No install — the appId resolves to no manifest.
    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: 'never-installed-app' },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('NoActiveRecipe')
  })

  test('grandfather recipe (approvedCaptures empty) always refuses capture', async ({
    request,
  }) => {
    // Simulate a recipe installed before the v0.2.0 capture field
    // existed. The mark-installed validator defaults a missing
    // `approvedCaptures` to `[]`, matching the grandfather migration
    // on load.
    await installCaptureRecipe(request, { approvedCaptures: [] })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { trustLevel?: string; remediation?: string }
    }
    expect(body.error).toBe('CaptureNotApproved')
    expect(body.details?.trustLevel).toBe('unknown')
    expect(body.details?.remediation).toMatch(/Grandfather recipe/)
  })
})
