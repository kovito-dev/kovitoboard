/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E — capture endpoint opt-in mechanism (v0.2.0 Phase 1 ①).
 *
 * Walks the canonical verification paths from
 * `http-api-contract.md` v1.5 §10.6.3 through the running
 * KovitoBoard server. v1.7 introduced the per-recipe-page mount
 * identity (`/api/app/capture-mount/{open,close}`), so the tests
 * now request a `mountId` first, then mint capture tokens against
 * it.
 *
 * The host-only endpoints require `X-KB-Internal-Auth`; we attach
 * it explicitly because the Playwright `request` fixture is
 * server-side (no DOM, no meta tag).
 *
 * Path coverage:
 *   - Both layers approved → 204
 *   - captureRequires has the kind, approvedCaptures does not → 403 not-approved
 *   - captureRequires omits the kind → 403 not-declared
 *   - unknown literal kind path segment → 403 not-declared
 *   - X-KB-Capture-Token header missing → 403 capture-token-missing
 *   - mount not found → 403 mount-not-found
 *   - grandfather recipe → /capture-mount/open returns `mountId: null`
 *   - I-CR4 capture-call cross-app theft regression
 *   - **I-CR4 issuance-gate cross-app theft regression** (PR #30
 *     attempt 4 reproducer)
 *   - host-bootstrap-verified audit emission for normal mounts
 *
 * @see docs/specs/recipe-system.md v1.7
 * @see docs/specs/http-api-contract.md v1.5
 * @see docs/specs/app-directory-extension.md v1.4
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const TEST_RECIPE_ID = 'e2e-capture-optin'

function authHeaders(): Record<string, string> {
  return {
    'X-Kovitoboard-Token': process.env.KB_LAUNCH_TOKEN ?? '',
    'X-KB-Internal-Auth': process.env.KB_INTERNAL_TOKEN ?? '',
  }
}

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
    headers: authHeaders(),
    data: { appId },
  })
  const nonceRes = await request.post(`${API_BASE}/api/recipes/_test/issue-nonce`, {
    headers: authHeaders(),
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
      headers: authHeaders(),
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

async function openMount(
  request: import('@playwright/test').APIRequestContext,
  appId: string,
): Promise<{ mountId: string | null; reason: string | null }> {
  const res = await request.post(`${API_BASE}/api/app/capture-mount/open`, {
    headers: authHeaders(),
    data: { appId },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as {
    mountId: string | null
    expiresAt: number | null
    reason: string | null
  }
  return { mountId: body.mountId, reason: body.reason }
}

async function issueToken(
  request: import('@playwright/test').APIRequestContext,
  mountId: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/app/capture-token/issue`, {
    headers: authHeaders(),
    data: { mountId },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { token: string }
  expect(body.token).toMatch(/^[0-9a-f]{32}$/)
  return body.token
}

async function provisionToken(
  request: import('@playwright/test').APIRequestContext,
  appId: string,
): Promise<{ mountId: string; token: string }> {
  const opened = await openMount(request, appId)
  if (opened.mountId === null) {
    throw new Error(`openMount returned null for ${appId}: ${opened.reason}`)
  }
  const token = await issueToken(request, opened.mountId)
  return { mountId: opened.mountId, token }
}

test.describe('Capture opt-in (v0.2.0 / spec v1.7 mountId + capture-token mechanism)', () => {
  test('approves a kind that the recipe declares and the user accepted (with token)', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const { token } = await provisionToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: {
        ...authHeaders(),
        'x-kb-capture-token': token,
      },
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
    const { token } = await provisionToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: {
        ...authHeaders(),
        'x-kb-capture-token': token,
      },
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
    const { token } = await provisionToken(request, TEST_RECIPE_ID)

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: {
        ...authHeaders(),
        'x-kb-capture-token': token,
      },
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
    // token needed here. /api/app/capture/* still goes through the
    // launch-token guard so we attach the auth headers.
    const res = await request.post(`${API_BASE}/api/app/capture/camera`, {
      headers: authHeaders(),
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
      headers: authHeaders(),
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

  test('grandfather recipe — /capture-mount/open returns mountId=null with reason=grandfather-no-capture', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: [],
      approvedCaptures: [],
    })
    const opened = await openMount(request, TEST_RECIPE_ID)
    expect(opened.mountId).toBeNull()
    expect(opened.reason).toBe('grandfather-no-capture')
  })

  test('I-CR4 capture-call cross-app theft — token bound to recipe-A authorises recipe-A even when body lies about appId', async ({
    request,
  }) => {
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
    const { token: tokenA } = await provisionToken(request, 'recipe-a')

    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: {
        ...authHeaders(),
        'x-kb-capture-token': tokenA,
      },
      data: { appId: 'recipe-b' },
    })
    expect(res.status()).toBe(204)
  })

  test('I-CR4 issuance-gate cross-app theft regression (PR #30 attempt 4) — body.appId on /capture-token/issue is ignored', async ({
    request,
  }) => {
    // recipe-a + recipe-b both installed. Attacker holds recipe-a's
    // mountId. The attempt-4 finding was that
    // `/api/app/capture-token/issue` honoured `body.appId`, letting
    // a recipe-a page mint a token under recipe-b's identity. v1.7
    // takes the appId from the mountStore record; `body.appId` is
    // not even read.
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
    const openedA = await openMount(request, 'recipe-a')
    expect(openedA.mountId).not.toBeNull()
    if (openedA.mountId === null) throw new Error('mountId nullish')

    // Issue a token using recipe-a's mountId but lie about appId.
    const issueRes = await request.post(
      `${API_BASE}/api/app/capture-token/issue`,
      {
        headers: authHeaders(),
        data: { mountId: openedA.mountId, appId: 'recipe-b' },
      },
    )
    expect(issueRes.status()).toBe(200)
    const { token } = (await issueRes.json()) as { token: string }

    // The minted token is bound to recipe-a (mountStore authority),
    // so calling /api/app/capture/exposed-context (which only
    // recipe-b has approved) MUST refuse. recipe-a does not declare
    // exposed-context.
    const res = await request.post(
      `${API_BASE}/api/app/capture/exposed-context`,
      {
        headers: {
          ...authHeaders(),
          'x-kb-capture-token': token,
        },
        data: {},
      },
    )
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('CaptureNotDeclared')
    expect(body.details?.reason).toBe('not-declared')
  })

  test('capture-token-routes / issue refuses without X-KB-Internal-Auth (host-only EP)', async ({
    request,
  }) => {
    // The host-only auth requirement is what makes the issuance
    // gate "trusted-host-mediated" (spec v1.7 §6.10.6.9). Recipe
    // code on a public path cannot get past `verifyInternalAuth`.
    const res = await request.post(
      `${API_BASE}/api/app/capture-token/issue`,
      {
        headers: { 'X-Kovitoboard-Token': process.env.KB_LAUNCH_TOKEN ?? '' },
        data: { mountId: 'a'.repeat(32) },
      },
    )
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MissingInternalAuth')
  })

  test('capture-mount close drops the mount and the bound token (H-CR4 atomic delete)', async ({
    request,
  }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const { mountId, token } = await provisionToken(request, TEST_RECIPE_ID)

    const closeRes = await request.post(
      `${API_BASE}/api/app/capture-mount/close`,
      {
        headers: authHeaders(),
        data: { mountId },
      },
    )
    expect(closeRes.status()).toBe(200)
    const closeBody = (await closeRes.json()) as { ok: boolean; closed: boolean }
    expect(closeBody.closed).toBe(true)

    // Subsequent capture call with the same token now lands on
    // mount-not-found — the token is gone too.
    const res = await request.post(`${API_BASE}/api/app/capture/a11y`, {
      headers: {
        ...authHeaders(),
        'x-kb-capture-token': token,
      },
      data: {},
    })
    expect(res.status()).toBe(403)
    const body = (await res.json()) as {
      error: string
      details?: { reason?: string }
    }
    expect(body.error).toBe('NoActiveRecipe')
    // Either capture-token-invalid (token was atomically dropped)
    // or mount-not-found (race). Both are acceptable end states for
    // a closed mount; the test only insists the call refused.
    expect([
      'capture-token-invalid',
      'mount-not-found',
    ]).toContain(body.details?.reason ?? '')
  })

  test('capture-token revoke — second revoke is idempotent', async ({ request }) => {
    await installCaptureRecipe(request, {
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const { token } = await provisionToken(request, TEST_RECIPE_ID)

    const first = await request.post(
      `${API_BASE}/api/app/capture-token/revoke`,
      {
        headers: {
          ...authHeaders(),
          'x-kb-capture-token': token,
        },
      },
    )
    expect(first.status()).toBe(200)
    expect((await first.json()).revoked).toBe(true)

    const second = await request.post(
      `${API_BASE}/api/app/capture-token/revoke`,
      {
        headers: {
          ...authHeaders(),
          'x-kb-capture-token': token,
        },
      },
    )
    expect(second.status()).toBe(200)
    expect((await second.json()).revoked).toBe(false)
  })

  test('audit-routes records a host-bootstrap-verified record (host-emitted sentinel)', async ({
    request,
  }) => {
    // The audit EP is host-only and requires X-KB-Internal-Auth.
    // This test posts directly (the renderer's `RecipePageHost`
    // does the same shape on every mount) and verifies the EP
    // accepts the record. The audit log entry persists to
    // `<projectRoot>/app/_host-bootstrap-audit.log` but L1 fixtures
    // do not assert against the on-disk file — we only confirm the
    // EP returns 204.
    const res = await request.post(
      `${API_BASE}/api/audit/host-bootstrap`,
      {
        headers: authHeaders(),
        data: {
          event: 'host-bootstrap-verified',
          recipePath: TEST_RECIPE_ID,
          appId: TEST_RECIPE_ID,
          when: 'before-recipe-render',
        },
      },
    )
    expect(res.status()).toBe(204)
  })
})
