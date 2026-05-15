/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E coverage for the cwd allow-list gate
 * (spec `cwd-allowlist.md` v1.0 §9.5).
 *
 * The point of this suite is to prove that the gate runs against a
 * real KB server (with real setting.json persistence) and that the
 * §6.4 / §6.2.2 envelopes match the spec. Per-reason failure paths
 * (probe_failed, symlink_loop, permission_denied) are exercised in
 * the unit tests under `tests/unit/cwdValidator.test.ts`; here we
 * concentrate on the system-level wiring through the Express stack.
 *
 * Project: kb-e2e-shared-default (project root is a writable tempdir
 * provisioned by the L1 fixture, so cwds inside it are legitimately
 * allow-listed).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

test.describe('cwd allow-list — POST /api/sessions/new', () => {
  test('rejects /etc with cwd_not_allowed (denylist anchor)', async ({ request, kbFixture }) => {
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/sessions/new`, {
      data: { message: 'denied', cwd: '/etc' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('cwd_not_allowed')
    expect(body.requested_cwd).toBe('/etc')
    expect(Array.isArray(body.allowed_roots)).toBe(true)
    // /etc itself is denylisted -> CTA must be suppressed.
    expect(body.addToAllowListPossible).toBe(false)
  })

  test('rejects a missing path with cwd_not_found', async ({ request, kbFixture }) => {
    const missing = `/tmp/kb-cwd-test-missing-${Date.now()}`
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/sessions/new`, {
      data: { message: 'denied', cwd: missing },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('cwd_not_found')
    expect(body.requested_cwd).toBe(missing)
  })

  test('rejects a non-string cwd with a basic 400', async ({ request, kbFixture }) => {
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/sessions/new`, {
      data: { message: 'denied', cwd: 12345 },
    })
    expect(res.status()).toBe(400)
  })
})

test.describe('cwd allow-list — POST /api/tmux/start-agent', () => {
  test('rejects /etc with cwd_not_allowed', async ({ request, kbFixture }) => {
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/tmux/start-agent`, {
      data: { agentId: 'cwd-test-agent', cwd: '/etc' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('cwd_not_allowed')
  })

  test('rejects a missing path with cwd_not_found', async ({ request, kbFixture }) => {
    const missing = `/tmp/kb-tmux-test-missing-${Date.now()}`
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/tmux/start-agent`, {
      data: { agentId: 'cwd-test-agent', cwd: missing },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('cwd_not_found')
  })
})

test.describe('/api/work-roots — GET / POST / DELETE round-trip', () => {
  test('GET returns an empty list initially, POST adds a root, DELETE removes it', async ({ request, kbFixture }) => {
    // GET (fresh state).
    const initial = await request.get(`${kbFixture.apiBaseUrl}/api/work-roots`)
    expect(initial.status()).toBe(200)
    const initialBody = await initial.json()
    expect(initialBody.additionalWorkRoots).toEqual([])

    // POST a new root. The fixture's project root is on a tempfs we
    // can write into, so we create a sibling directory and feed it
    // as an absolute path.
    const sibling = mkdtempSync(join(tmpdir(), 'kb-cwd-e2e-add-'))
    try {
      const added = await request.post(`${kbFixture.apiBaseUrl}/api/work-roots`, {
        data: { path: sibling },
      })
      expect(added.status()).toBe(200)
      const addedBody = await added.json()
      expect(addedBody.addedPath).toBeTruthy()
      expect(addedBody.additionalWorkRoots).toContain(addedBody.addedPath)

      // GET reflects the new state.
      const afterAdd = await request.get(`${kbFixture.apiBaseUrl}/api/work-roots`)
      const afterAddBody = await afterAdd.json()
      expect(afterAddBody.additionalWorkRoots).toContain(addedBody.addedPath)

      // DELETE the same path (canonical form from POST response).
      const removed = await request.delete(`${kbFixture.apiBaseUrl}/api/work-roots`, {
        data: { path: addedBody.addedPath },
      })
      expect(removed.status()).toBe(200)
      const removedBody = await removed.json()
      expect(removedBody.removedPath).toBe(addedBody.addedPath)
      expect(removedBody.additionalWorkRoots).not.toContain(addedBody.addedPath)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('POST rejects /etc with denylisted_root (endpoint envelope)', async ({ request, kbFixture }) => {
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/work-roots`, {
      data: { path: '/etc' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('denylisted_root')
    expect(body.path).toBe('/etc')
  })

  test('POST rejects a relative path with not_absolute', async ({ request, kbFixture }) => {
    const res = await request.post(`${kbFixture.apiBaseUrl}/api/work-roots`, {
      data: { path: 'relative/path' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_absolute')
  })

  test('DELETE returns 404 for an unknown path', async ({ request, kbFixture }) => {
    const res = await request.delete(`${kbFixture.apiBaseUrl}/api/work-roots`, {
      data: { path: '/tmp/never-added-via-test' },
    })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('not_found')
  })
})

test.describe('Work Roots page renders', () => {
  test('navigating to /work-roots shows the page heading', async ({ page, kbFixture }) => {
    await page.goto(`${kbFixture.apiBaseUrl}/work-roots`)
    // The page heading is i18n-driven; we check for the test-id
    // marker on the empty-state to confirm the page mounted.
    await expect(page.locator('[data-testid="work-roots-empty"]')).toBeVisible({
      timeout: 10_000,
    })
  })
})

