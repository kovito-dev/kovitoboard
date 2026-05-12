/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E — capture endpoint opt-in mechanism (v0.2.0 Phase 1 ①).
 *
 * Walks the five canonical paths from `http-api-contract.md` v1.3.1
 * §10.6.3 through the running KovitoBoard server. v1.5 separates
 * step 3 (declaration check on `manifest.captureRequires`) from
 * step 4 (consent check on `manifest.approvedCaptures`), so the
 * "not declared" / "not approved" paths are now exercised as
 * independent cases.
 *
 *   1. captureRequires + approvedCaptures both contain the kind      → 204
 *   2. captureRequires contains the kind, approvedCaptures does not  → 403 CaptureNotApproved
 *   3. captureRequires omits the kind (declared by enum only)        → 403 CaptureNotDeclared
 *   4. no active recipe (unknown appId)                              → 403 NoActiveRecipe
 *   5. grandfather recipe (captureRequires/approvedCaptures = [])    → 403 CaptureNotDeclared (step 3)
 *
 * Each test seeds the manifest store via the same KB_E2E_MODE seam
 * the recipe-handler suite uses (`_test/issue-nonce` →
 * `mark-installed`). The v0.2.x install path itself is disabled
 * (410 Gone), so the test seam is the only way to bring a manifest
 * with v0.2.0 fields into existence in the running server.
 *
 * @see docs/specs/recipe-system.md v1.5 §6.10
 * @see docs/specs/app-directory-extension.md v1.2.1 §10.5.2
 * @see docs/specs/http-api-contract.md v1.3.1 §10.6
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const TEST_RECIPE_ID = 'e2e-capture-optin'

interface InstallParams {
  captureRequires?: ('a11y' | 'exposed-context')[]
  approvedCaptures?: ('a11y' | 'exposed-context')[]
}

async function installCaptureRecipe(
  request: import('@playwright/test').APIRequestContext,
  params: InstallParams = {},
): Promise<void> {
  const scopes = ['own-data']
  const apiSection = { scopes, calls: [] }
  const recipeHash = `e2e-capture-hash-${Date.now()}`
  const captureRequires = params.captureRequires ?? []
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
      captureRequires,
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
        captureRequires,
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

test.describe('Capture opt-in (v0.2.0 / spec v1.5)', () => {
  test('approves a kind that the recipe declares and the user accepted', async ({ request }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(204)
  })

  test('rejects step 4 (CaptureNotApproved) when the kind is declared but not approved', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: [],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('CaptureNotApproved')
    expect(body.details?.reason).toBe('not-approved')
  })

  test('rejects step 3 (CaptureNotDeclared) when the kind is missing from captureRequires', async ({
    request,
  }) => {
    // captureRequires has a different kind, so the requested one
    // never even reaches the consent gate.
    await installCaptureRecipe(request, {
      captureRequires: ['exposed-context'],
      approvedCaptures: ['exposed-context'],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('CaptureNotDeclared')
    expect(body.details?.reason).toBe('not-declared')
  })

  test('rejects an unknown literal kind as CaptureNotDeclared', async ({ request }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/camera`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('CaptureNotDeclared')
  })

  test('rejects an unknown appId as NoActiveRecipe (no-active-recipe)', async ({ request }) => {
    // No install — the appId resolves to no manifest.
    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: 'never-installed-app' },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('NoActiveRecipe')
    expect(body.details?.reason).toBe('no-active-recipe')
  })

  test('grandfather recipe (captureRequires=[]) always refuses with CaptureNotDeclared', async ({
    request,
  }) => {
    // Simulate a recipe installed before the v0.2.0 capture fields
    // existed. The mark-installed validator defaults both fields
    // to `[]`, matching the grandfather migration on load.
    await installCaptureRecipe(request, {
      captureRequires: [],
      approvedCaptures: [],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: { appId: TEST_RECIPE_ID },
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { trustLevel?: string; reason?: string; remediation?: string }
    }
    expect(body.error).toBe('CaptureNotDeclared')
    expect(body.details?.reason).toBe('not-declared')
    expect(body.details?.trustLevel).toBe('unknown')
    expect(body.details?.remediation).toMatch(/Grandfather recipe/)
  })
})
