/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E — recipe-page trust marker (Phase 1 ③, handoff
 * `v02x-phase1-trust-marker-preamble-warning-request.md` v1.1 §4.2).
 *
 * Coverage in this spec:
 *   - Grandfather recipe (`trustLevel: 'unknown'` mint via
 *     mark-installed) renders the gray badge + "Re-install via
 *     KovitoHub" link on `/ext/<appId>`.
 *   - Menu-entries API wire format exposes `trustLevel` so the
 *     renderer reads it without a separate manifest round-trip.
 *   - When no manifest is registered for a `menu.ts` entry, the
 *     marker stays hidden (badge is opt-in on the manifest, not on
 *     the `app/menu.ts` row itself).
 *
 * The fixture path uses `l1-fixture-app` (already registered in
 * `tests/fixtures/projects/blank-onboarded/app/menu.ts`) so the
 * spec exercises the standard `/ext/<appId>` router path. Manifest
 * lifecycle is controlled via the existing `_test/clear-manifest` +
 * `_test/issue-nonce` + `mark-installed` harness, the same path
 * `capture-optin.spec.ts` uses.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'
const APP_ID = 'l1-fixture-app'

function authHeaders(): Record<string, string> {
  return {
    'X-Kovitoboard-Token': process.env.KB_LAUNCH_TOKEN ?? '',
    'X-KB-Internal-Auth': process.env.KB_INTERNAL_TOKEN ?? '',
  }
}

async function installGrandfatherManifest(
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  const scopes = ['own-data']
  const apiSection = { scopes, calls: [] }
  const recipeHash = `e2e-trust-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`

  await request.post(`${API_BASE}/api/recipes/_test/clear-manifest`, {
    headers: authHeaders(),
    data: { appId: APP_ID },
  })
  const nonceRes = await request.post(`${API_BASE}/api/recipes/_test/issue-nonce`, {
    headers: authHeaders(),
    data: {
      recipeId: APP_ID,
      recipeHash,
      recipeVersion: '1.0.0',
      recipeSource: 'sample',
      approvedScopes: scopes,
      captureRequires: [],
      approvedCaptures: [],
      api: apiSection,
    },
  })
  expect(nonceRes.ok()).toBeTruthy()
  const { installNonce } = (await nonceRes.json()) as { installNonce: string }

  const installRes = await request.post(
    `${API_BASE}/api/recipes/${APP_ID}/mark-installed`,
    {
      headers: authHeaders(),
      data: {
        appId: APP_ID,
        approvedScopes: scopes,
        captureRequires: [],
        approvedCaptures: [],
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
        recipeHash,
        installNonce,
        api: apiSection,
      },
    },
  )
  expect(installRes.ok()).toBeTruthy()
}

test.describe('Trust marker on recipe pages (v0.2.0 / handoff v1.1 §3.2)', () => {
  test('menu-entries API surfaces trustLevel for the active manifest', async ({ request }) => {
    await installGrandfatherManifest(request)
    const res = await request.get(`${API_BASE}/api/app/menu-entries`, {
      headers: authHeaders(),
    })
    expect(res.ok()).toBeTruthy()
    const entries = (await res.json()) as Array<{
      id: string
      trustLevel: string | null
    }>
    const target = entries.find((e) => e.id === APP_ID)
    expect(target, 'menu-entries should include the fixture row').toBeDefined()
    // mark-installed always mints `trustLevel: 'unknown'` in v0.2.x
    // (the install path is structurally gated to grandfather literals).
    expect(target!.trustLevel).toBe('unknown')
  })

  /**
   * Navigate to `/ext/l1-fixture-app` via the NavMenu so the route is
   * registered by the time the test runs. A direct `page.goto('/ext/...')`
   * causes a full reload — `userMenuEntries` starts at `[]` and the
   * catch-all Route bounces to `/agents` before the menu-entries fetch
   * settles. Mirrors the pattern used in `s12-ambient-sidebar.spec.ts`.
   */
  async function openFixtureAppPage(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/agents')
    await page.waitForResponse(
      (r) => r.url().endsWith('/api/app/menu-entries') && r.ok(),
    )
    const navButton = page.locator('button[title="L1 Fixture App"]').first()
    await navButton.waitFor({ state: 'visible', timeout: 10_000 })
    await navButton.click()
    await page.waitForURL(`**/ext/${APP_ID}`)
    await page.waitForLoadState('networkidle')
  }

  test('grandfather recipe renders the unknown trust marker badge', async ({ page, request }) => {
    await installGrandfatherManifest(request)
    await openFixtureAppPage(page)

    const header = page.getByTestId('recipe-trust-header')
    await expect(header).toBeVisible()
    const badge = header.locator('[data-trust-level]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-trust-level', 'unknown')
    // The grandfather hint that nudges users onto the signed track.
    await expect(badge.getByText(/Re-install via KovitoHub/i)).toBeVisible()
  })

  test('menu entry without a manifest leaves the badge hidden', async ({ page, request }) => {
    // Drop the manifest so the menu-entries lookup returns null.
    // The route still lists `l1-fixture-app` because the entry is
    // declared in `app/menu.ts` — only the trust-axis lookup misses.
    await request.post(`${API_BASE}/api/recipes/_test/clear-manifest`, {
      headers: authHeaders(),
      data: { appId: APP_ID },
    })

    await openFixtureAppPage(page)

    const header = page.getByTestId('recipe-trust-header')
    // Header wrapper is always rendered (router-level guarantee);
    // the badge inside hides when trustLevel is null.
    await expect(header).toBeVisible()
    await expect(header.locator('[data-trust-level]')).toHaveCount(0)
  })
})
