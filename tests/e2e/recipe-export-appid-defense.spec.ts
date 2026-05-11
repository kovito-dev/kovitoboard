/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe export `appId` boundary defence — E2E tests (v0.2.x).
 *
 * Verifies the Codex #11 v0.2.x grandfather defence:
 *
 *   - `POST /api/recipes/export` rejects an `appId` containing a path
 *     traversal segment with 400 `InvalidAppId`.
 *   - `GET /api/recipes/app-scan` rejects the same input with the same
 *     status / body shape.
 *   - Both routes also reject `RESERVED_DIRS` entries (`api`, `pages`,
 *     `styles`, `data`) even though those strings would pass the
 *     app-name regex.
 *   - The legitimate grandfather export path still functions for an
 *     existing app (the `l1-fixture-app` shipped in the
 *     `blank-onboarded` template).
 *
 * @see docs/specs/recipe-system.md §7.7 / §10.6.4 (export attack
 *      surface in grandfather paths)
 * @see docs/specs/app-directory-extension.md (app-name pattern,
 *      RESERVED_DIRS)
 */
import { test, expect } from './helpers/l1-per-test-setup'

// `recipe-install-disable.spec.ts` runs against the `l1-default`
// Playwright project (port 3001, `blank-onboarded` fixture) and that
// is also where the export grandfather path lives — sample apps are
// only seeded into the default fixture. We pin the same base URL here
// rather than reading `test.info().project.metadata.port` so an
// accidental project assignment misroute (e.g. someone adds a `@rich`
// tag) shows up as a hard 4xx instead of silently hitting a different
// server.
const API_BASE = 'http://127.0.0.1:3001'

const VALID_METADATA = {
  recipeId: 'l1-fixture-app-export',
  name: 'L1 Fixture App',
  description: 'Exported by the appId boundary defence E2E test.',
  version: '1.0.0',
}

test.describe('Recipe export appId boundary defence (v0.2.x)', () => {
  test('POST /api/recipes/export rejects path traversal appId with 400 InvalidAppId', async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/api/recipes/export`, {
      data: {
        appId: '../etc/passwd',
        metadata: VALID_METADATA,
      },
    })
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('InvalidAppId')
    // The message echoes back the validator's reason so the client can
    // surface a precise hint without having to parse the regex
    // literal client-side.
    expect(typeof body.message).toBe('string')
    expect(body.message).toMatch(/appId/)
  })

  test('GET /api/recipes/app-scan rejects path traversal appId with 400 InvalidAppId', async ({
    request,
  }) => {
    const res = await request.get(
      `${API_BASE}/api/recipes/app-scan?appId=${encodeURIComponent('../etc/passwd')}`,
    )
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('InvalidAppId')
    expect(body.message).toMatch(/appId/)
  })

  test('POST /api/recipes/export rejects RESERVED_DIR appId (api) with 400 InvalidAppId', async ({
    request,
  }) => {
    // `api` matches the app-name regex but is one of the directories
    // recipe install never creates as `app/<appId>/`; allowing it
    // here would let an exporter walk `app/api/` (a sibling tree
    // outside the recipe contract).
    const res = await request.post(`${API_BASE}/api/recipes/export`, {
      data: {
        appId: 'api',
        metadata: VALID_METADATA,
      },
    })
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('InvalidAppId')
    expect(body.message).toMatch(/reserved/)
  })

  test('GET /api/recipes/app-scan rejects RESERVED_DIR appId (data) with 400 InvalidAppId', async ({
    request,
  }) => {
    const res = await request.get(
      `${API_BASE}/api/recipes/app-scan?appId=${encodeURIComponent('data')}`,
    )
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('InvalidAppId')
    expect(body.message).toMatch(/reserved/)
  })

  test('POST /api/recipes/export still serves a 200 download for a valid existing app (grandfather path preserved)', async ({
    request,
  }) => {
    // `l1-fixture-app` ships in the `blank-onboarded` template (see
    // tests/fixtures/projects/blank-onboarded/app/l1-fixture-app/)
    // and exposes a single `pages/L1FixturePage.tsx` artifact. The
    // defence must not regress this happy path — recipe export is
    // grandfathered through the v0.2.x install freeze.
    const res = await request.post(`${API_BASE}/api/recipes/export`, {
      data: {
        appId: 'l1-fixture-app',
        metadata: {
          recipeId: 'l1-fixture-app-export',
          name: 'L1 Fixture App',
          description: 'Exported by the appId boundary defence E2E test.',
          version: '1.0.0',
        },
      },
    })
    expect(res.status()).toBe(200)
    const contentType = res.headers()['content-type'] ?? ''
    expect(contentType).toContain('text/markdown')
    const body = await res.text()
    // Sanity-check the YAML frontmatter — anything more specific
    // belongs in `tests/unit/recipe-exporter-*` (the structural
    // contract is exercised there). All we care about here is that
    // the boundary defence did not turn a legitimate export into a
    // refusal.
    expect(body.startsWith('---')).toBe(true)
    expect(body).toContain('recipeId: "l1-fixture-app-export"')
    expect(body).toContain('## artifacts/pages/L1FixturePage.tsx')
  })
})
