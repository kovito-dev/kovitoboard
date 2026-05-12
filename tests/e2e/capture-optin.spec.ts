/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E — capture endpoint opt-in mechanism (v0.2.0 Phase 1 ①).
 *
 * Walks the canonical verification paths from
 * `http-api-contract.md` v1.4 §10.6.3 through the running
 * KovitoBoard server. v1.6 added the per-recipe-page capture-token
 * mechanism (`X-KB-Capture-Token` header), so the tests now mint
 * tokens via `/api/app/capture-token/issue` before invoking
 * `/api/app/capture/<kind>`.
 *
 * Path coverage:
 *   - Both layers approved → 204
 *   - captureRequires has the kind, approvedCaptures does not → 403 not-approved (step 4)
 *   - captureRequires omits the kind → 403 not-declared (step 3)
 *   - unknown literal kind path segment → 403 not-declared (step 1)
 *   - X-KB-Capture-Token header missing → 403 capture-token-missing
 *   - grandfather recipe (captureRequires=[]) → token issuance skipped → fail-fast
 *   - **I-CR4 cross-app capability theft** — token bound to recipe-A
 *     authorises a11y under recipe-A even when the body lies and
 *     claims `appId: 'recipe-b'`
 *
 * @see docs/specs/recipe-system.md v1.6 §6.10.6
 * @see docs/specs/http-api-contract.md v1.4 §10.6
 * @see docs/specs/app-directory-extension.md v1.3 §10.5.2
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const TEST_RECIPE_ID = 'e2e-capture-optin'

interface InstallParams {
  appId?: string
  captureRequires?: ('a11y' | 'exposed-context')[]
  approvedCaptures?: ('a11y' | 'exposed-context')[]
}

async function installCaptureRecipe(
  request: import('@playwright/test').APIRequestContext,
  params: InstallParams = {},
): Promise<void> {
  const scopes = ['own-data']
  const apiSection = { scopes, calls: [] }
  const recipeHash = `e2e-capture-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const captureRequires = params.captureRequires ?? []
  const approvedCaptures = params.approvedCaptures ?? []
  const appId = params.appId ?? TEST_RECIPE_ID

  await request.post(`${API_BASE}/api/recipes/_test/clear-manifest`, {
    data: { appId },
  })
  const nonceRes = await request.post(`${API_BASE}/api/recipes/_test/issue-nonce`, {
    data: {
      recipeId: appId,
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
    `${API_BASE}/api/recipes/${appId}/mark-installed`,
    {
      data: {
        appId,
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

async function issueCaptureToken(
  request: import('@playwright/test').APIRequestContext,
  appId: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/app/capture-token/issue`, {
    data: { appId },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as {
    token: string | null
    expiresAt: number | null
    reason: string | null
  }
  expect(body.token).not.toBeNull()
  expect(body.token).toMatch(/^[0-9a-f]{32}$/)
  return body.token as string
}

test.describe('Capture opt-in (v0.2.0 / spec v1.6 capture-token mechanism)', () => {
  test('approves a kind that the recipe declares and the user accepted (with token)', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const token = await issueCaptureToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: { 'x-kb-capture-token': token },
      data: {},
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
    const token = await issueCaptureToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: { 'x-kb-capture-token': token },
      data: {},
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
    await installCaptureRecipe(request, {
      captureRequires: ['exposed-context'],
      approvedCaptures: ['exposed-context'],
    })
    const token = await issueCaptureToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: { 'x-kb-capture-token': token },
      data: {},
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
    // Unknown kind short-circuits before the token check; no
    // token needed here.
    const res = await request.post(`${API_BASE}/api/app/capture/camera`, {
      data: {},
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('CaptureNotDeclared')
  })

  test('rejects a missing X-KB-Capture-Token header (capture-token-missing)', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      data: {},
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('NoActiveRecipe')
    expect(body.details?.reason).toBe('capture-token-missing')
  })

  test('grandfather recipe — capture-token issuance returns null and skips mint', async ({
    request,
  }) => {
    // captureRequires=[] simulates a v0.1.x install migrated under
    // v0.2.0 / v1.5 grandfather rules. The token endpoint MUST
    // return token=null so the client fails fast without consuming
    // a store slot.
    await installCaptureRecipe(request, {
      captureRequires: [],
      approvedCaptures: [],
    })

    const issueRes = await request.post(
      `${API_BASE}/api/app/capture-token/issue`,
      { data: { appId: TEST_RECIPE_ID } },
    )
    expect(issueRes.status()).toBe(200)
    const issueBody = (await issueRes.json()) as {
      token: string | null
      reason: string | null
    }
    expect(issueBody.token).toBeNull()
    expect(issueBody.reason).toBe('grandfather-no-capture')
  })

  test('I-CR4 cross-app capability theft — token bound to recipe-A authorises recipe-A even when body lies about appId', async ({
    request,
  }) => {
    // Install two recipes:
    //   recipe-a: a11y declared + approved
    //   recipe-b: only exposed-context declared, not a11y
    //
    // The attacker page on recipe-a mints recipe-a's token, then
    // posts `body: { appId: 'recipe-b' }` to /api/app/capture/a11y
    // hoping the server will check recipe-b's manifest (which
    // would reject it as not-declared). I-CR4 mandates the server
    // ignore `body.appId` and route the call through recipe-a's
    // manifest — recipe-a HAS a11y approved, so the call returns
    // 204. The 204 result IS the proof that the server discarded
    // the lie; if it had honoured `body.appId`, we would see a
    // 403 CaptureNotDeclared instead.
    await installCaptureRecipe(request, {
      appId: 'recipe-a',
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    await installCaptureRecipe(request, {
      appId: 'recipe-b',
      captureRequires: ['exposed-context'],
      approvedCaptures: ['exposed-context'],
    })

    const tokenA = await issueCaptureToken(request, 'recipe-a')

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: { 'x-kb-capture-token': tokenA },
      // Attacker lies: claims to be recipe-b. The server MUST
      // ignore this field and resolve appId from the token.
      data: { appId: 'recipe-b' },
    })
    expect(res.status()).toBe(204)
  })

  test('capture-token revoke — second revoke is idempotent', async ({ request }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const token = await issueCaptureToken(request, TEST_RECIPE_ID)

    const first = await request.post(
      `${API_BASE}/api/app/capture-token/revoke`,
      { headers: { 'x-kb-capture-token': token } },
    )
    expect(first.status()).toBe(200)
    expect((await first.json()).revoked).toBe(true)

    const second = await request.post(
      `${API_BASE}/api/app/capture-token/revoke`,
      { headers: { 'x-kb-capture-token': token } },
    )
    expect(second.status()).toBe(200)
    expect((await second.json()).revoked).toBe(false)
  })
})
