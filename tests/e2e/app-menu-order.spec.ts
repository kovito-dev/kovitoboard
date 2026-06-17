/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App menu-order PUT — server-side wire contract E2E tests
 * (BS-T10, tester request v1.1 §1.2 + cascade §10.2).
 *
 * Verifies `PUT /api/apps/menu-order` against
 *   docs/specs/http-api-contract.md v1.7.1 §6.3.9.A
 *   docs/specs/app-directory-extension.md v1.6 §6.2 / §6.8.1
 *   docs/specs/ws-event-contract.md v1.4 §7.6.2
 *   docs/specs/audit-logging.md v1.2 §6.6
 *
 * Coverage:
 *   - BS-T10-a happy path: 200 OK with `{ updated, snapshotVersion }`,
 *     `app_menu_changed { event: 'menu-order-update', ts }` broadcast,
 *     AppManifest `menuOrder` field written, RecipeManifest untouched.
 *   - BS-T10-b 400 MenuOrderCoverageMismatch — `order[]` excludes an
 *     eligible app (closed-world batch invariant).
 *   - BS-T10-c 400 MenuOrderDuplicateAppId — `order[]` contains the
 *     same appId twice.
 *   - BS-T10-d 400 MenuOrderNonContiguous — `menuOrder` values are
 *     not contiguous in [0, N-1].
 *   - BS-T10-e 409 MenuOrderSnapshotDrift — stale `snapshotVersion`
 *     supplied (optional drift detection path).
 *
 * Fixture method: A (programmatic). The blank-onboarded project root
 * starts empty of bundled apps; we enable `document-viewer` and `todo`
 * (the two KB-shipped bundled samples) inside beforeEach so the
 * eligible app set is exactly {document-viewer, todo} for every test.
 * The pre-existing `l1-fixture-app` ext app has no AppManifest and is
 * therefore not part of the eligible set (the menu-order route scans
 * `app/<appId>/manifest.json` only).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import {
  waitForWsFrame,
  cleanupAppDir,
  readAppManifest,
  readRecipeManifest,
  snapshotMenuTs,
  restoreMenuTs,
} from './helpers/v021-bundled-helpers'

const API_BASE = 'http://127.0.0.1:3001'
const RECIPE_DOCUMENT_VIEWER = 'document-viewer'
const RECIPE_TODO = 'todo'

test.describe('App menu-order PUT (BS-T10) — closed-world batch contract', () => {
  // Enabling samples appends entries to `app/menu.ts`, which lives outside
  // the `.kovitoboard/` snapshot the L1 fixture restores. Snapshot and
  // restore it per-test so the appended entries do not leak into later
  // tests in the same Playwright project.
  let menuTsSnapshot: string | null = null

  test.beforeEach(async ({ request, kbFixture }) => {
    menuTsSnapshot = snapshotMenuTs(kbFixture.projectRoot)
    // Enable both bundled samples so the eligible app set is fixed at
    // exactly {document-viewer, todo}. Each enable also appends an
    // entry to `app/menu.ts` so the closed-world coverage check has
    // two members to enumerate.
    const r1 = await request.post(
      `${API_BASE}/api/recipes/sample/${RECIPE_DOCUMENT_VIEWER}/enable`,
    )
    expect(r1.status()).toBe(200)
    const r2 = await request.post(
      `${API_BASE}/api/recipes/sample/${RECIPE_TODO}/enable`,
    )
    expect(r2.status()).toBe(200)
  })

  test.afterEach(async ({ kbFixture }) => {
    cleanupAppDir(kbFixture.projectRoot, RECIPE_DOCUMENT_VIEWER)
    cleanupAppDir(kbFixture.projectRoot, RECIPE_TODO)
    if (menuTsSnapshot !== null) {
      restoreMenuTs(kbFixture.projectRoot, menuTsSnapshot)
      menuTsSnapshot = null
    }
  })

  test('BS-T10-a happy path: 200 OK + app_menu_changed broadcast + AppManifest menuOrder write (BS-L6)', async ({
    request,
    kbFixture,
  }) => {
    // Listen for the broadcast before firing the PUT so the
    // post-commit `setImmediate` cannot fire before we subscribe.
    const wsFramePromise = waitForWsFrame('app_menu_changed', {
      timeoutMs: 5_000,
    })

    const res = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [
          { appId: RECIPE_TODO, menuOrder: 0 },
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 1 },
        ],
      },
    })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      updated: number
      snapshotVersion: string
    }
    expect(body.updated).toBe(2)
    // snapshotVersion is the 16-char hex sha256 prefix (apps-routes.ts
    // succeeds with a `string` payload — we relax the format check to
    // just non-empty so a future hashing-scheme bump does not break
    // this assertion).
    expect(typeof body.snapshotVersion).toBe('string')
    expect(body.snapshotVersion.length).toBeGreaterThan(0)

    // Cascade observation: app_menu_changed broadcast with event
    // 'menu-order-update', appId omitted (closed-world batch).
    const frame = await wsFramePromise
    expect(frame.type).toBe('app_menu_changed')
    expect(frame.payload).toMatchObject({ event: 'menu-order-update' })
    expect(typeof frame.payload.ts).toBe('number')
    // BS-T9 cascade SSOT: appId is omitted for the closed-world
    // 'menu-order-update' event (the AppMenuChangedPayload comment
    // pins this explicitly).
    expect(frame.payload.appId).toBeUndefined()

    // AppManifest write: menuOrder field landed on the per-app
    // manifest (app-directory-extension v1.6 §6.2). RecipeManifest
    // side must NOT carry menuOrder (data-persistence v1.4 §6.4
    // dual-store prohibition).
    const docViewerAppManifest = readAppManifest(
      kbFixture.projectRoot,
      RECIPE_DOCUMENT_VIEWER,
    )
    const todoAppManifest = readAppManifest(
      kbFixture.projectRoot,
      RECIPE_TODO,
    )
    expect(docViewerAppManifest).not.toBeNull()
    expect(todoAppManifest).not.toBeNull()
    expect(docViewerAppManifest?.menuOrder).toBe(1)
    expect(todoAppManifest?.menuOrder).toBe(0)

    const docViewerRecipeManifest = readRecipeManifest(
      kbFixture.projectRoot,
      RECIPE_DOCUMENT_VIEWER,
    )
    const todoRecipeManifest = readRecipeManifest(
      kbFixture.projectRoot,
      RECIPE_TODO,
    )
    expect(docViewerRecipeManifest).not.toBeNull()
    expect(todoRecipeManifest).not.toBeNull()
    expect(docViewerRecipeManifest?.menuOrder).toBeUndefined()
    expect(todoRecipeManifest?.menuOrder).toBeUndefined()
  })

  test('BS-T10-b 400 MenuOrderCoverageMismatch — order[] excludes an eligible app', async ({
    request,
  }) => {
    // Only include document-viewer; todo is eligible but missing.
    const res = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [{ appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 0 }],
      },
    })
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuOrderCoverageMismatch')
  })

  test('BS-T10-c 400 MenuOrderDuplicateAppId — order[] contains the same appId twice', async ({
    request,
  }) => {
    const res = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 0 },
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 1 },
        ],
      },
    })
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuOrderDuplicateAppId')
  })

  test('BS-T10-d 400 MenuOrderNonContiguous — menuOrder values are not contiguous in [0, N-1]', async ({
    request,
  }) => {
    // Two apps but menuOrder set is {0, 2} — gap at 1.
    const res = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 0 },
          { appId: RECIPE_TODO, menuOrder: 2 },
        ],
      },
    })
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuOrderNonContiguous')
  })

  test('BS-T10-e 409 MenuOrderSnapshotDrift — stale snapshotVersion supplied (optional drift detection)', async ({
    request,
  }) => {
    // First, set a baseline order so the server has a real
    // snapshotVersion to drift away from.
    const baseline = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [
          { appId: RECIPE_TODO, menuOrder: 0 },
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 1 },
        ],
      },
    })
    expect(baseline.status()).toBe(200)
    const baselineBody = (await baseline.json()) as { snapshotVersion: string }
    // Mutate the snapshotVersion deterministically so the server's
    // freshly computed value cannot ever match it. A 32-char hex
    // garbage string is well-formed enough to pass any shape gate
    // upstream of the drift comparison.
    const staleSnapshot =
      baselineBody.snapshotVersion.split('').reverse().join('') +
      'deadbeefdeadbeef'

    const res = await request.put(`${API_BASE}/api/apps/menu-order`, {
      data: {
        order: [
          // Same order as baseline — the only difference is the stale
          // snapshotVersion. This isolates the drift detection path
          // (otherwise an unchanged order would also be a happy-path
          // no-op).
          { appId: RECIPE_DOCUMENT_VIEWER, menuOrder: 0 },
          { appId: RECIPE_TODO, menuOrder: 1 },
        ],
        snapshotVersion: staleSnapshot,
      },
    })
    expect(res.status()).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuOrderSnapshotDrift')
  })
})
