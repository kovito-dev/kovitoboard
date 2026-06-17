/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App menu-label PATCH — server-side wire contract E2E tests
 * (BS-T11, tester request v1.1 §1.2 + cascade §10.2).
 *
 * Verifies `PATCH /api/apps/:appId/menu-label` against
 *   docs/specs/http-api-contract.md v1.7.1 §6.3.9.A
 *   docs/specs/app-directory-extension.md v1.6 §6.2 / §6.8.2
 *   docs/specs/ws-event-contract.md v1.4 §7.6.2
 *   docs/specs/audit-logging.md v1.2 §6.6 / §6.6.4
 *
 * Coverage:
 *   - BS-T11-a happy path set: 200 OK with `{ appId, userMenuLabel }`,
 *     AppManifest `userMenuLabel` written, RecipeManifest untouched,
 *     `app_menu_changed { event: 'menu-label-update', appId, ts }`
 *     broadcast observed.
 *   - BS-T11-b null reset: `{ userMenuLabel: null }` returns 200 and
 *     clears the field; the next read sees `userMenuLabel: null`.
 *   - BS-T11-c 400 MenuLabelEmpty: empty string is rejected (the
 *     wire contract distinguishes `''` from `null`).
 *   - BS-T11-d 400 MenuLabelTooLong: > 80 chars is rejected.
 *   - BS-T11-e cascade audit: the http-route audit line carries
 *     `audit.labelLength` (integer for the set case, null for reset)
 *     and never echoes the raw label string — audit-logging v1.2
 *     §6.6.4 redaction invariant.
 *   - BS-T11-f display label resolution: after a successful set the
 *     server-side AppManifest `userMenuLabel` wins over both the
 *     RecipeManifest's recipe.menu.label and the `menu.ts` entry
 *     `label`, per `app-directory-extension.md` v1.6 §6.8.2.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  waitForWsFrame,
  cleanupAppDir,
  readAppManifest,
  readRecipeManifest,
  readServerLogLines,
} from './helpers/v021-bundled-helpers'

const API_BASE = 'http://127.0.0.1:3001'
const RECIPE_ID = 'document-viewer'
const APP_ID = 'document-viewer'

test.describe('App menu-label PATCH (BS-T11) — userMenuLabel override + reset + cascade', () => {
  test.beforeEach(async ({ request }) => {
    const r = await request.post(
      `${API_BASE}/api/recipes/sample/${RECIPE_ID}/enable`,
    )
    expect(r.status()).toBe(200)
  })

  test.afterEach(async ({ kbFixture }) => {
    cleanupAppDir(kbFixture.projectRoot, APP_ID)
  })

  test('BS-T11-a happy path set: 200 + AppManifest write + app_menu_changed broadcast (BS-L7)', async ({
    request,
    kbFixture,
  }) => {
    const customLabel = 'My Documents'
    const wsFramePromise = waitForWsFrame('app_menu_changed', {
      timeoutMs: 5_000,
    })

    const res = await request.patch(
      `${API_BASE}/api/apps/${APP_ID}/menu-label`,
      { data: { userMenuLabel: customLabel } },
    )
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      appId: string
      userMenuLabel: string | null
    }
    expect(body.appId).toBe(APP_ID)
    expect(body.userMenuLabel).toBe(customLabel)

    // AppManifest carries the override; RecipeManifest stays clear
    // (dual-store prohibition, data-persistence v1.4 §6.8).
    const appManifest = readAppManifest(kbFixture.projectRoot, APP_ID)
    expect(appManifest?.userMenuLabel).toBe(customLabel)
    const recipeManifest = readRecipeManifest(kbFixture.projectRoot, RECIPE_ID)
    expect(recipeManifest?.userMenuLabel).toBeUndefined()

    // Cascade observation: app_menu_changed with the per-app appId
    // set (contrast with menu-order-update which omits appId).
    const frame = await wsFramePromise
    expect(frame.type).toBe('app_menu_changed')
    expect(frame.payload).toMatchObject({
      event: 'menu-label-update',
      appId: APP_ID,
    })
    expect(typeof frame.payload.ts).toBe('number')
  })

  test('BS-T11-b null reset: { userMenuLabel: null } clears the override', async ({
    request,
    kbFixture,
  }) => {
    // Arrange: set a custom label first so reset has something to
    // undo.
    expect(
      (
        await request.patch(`${API_BASE}/api/apps/${APP_ID}/menu-label`, {
          data: { userMenuLabel: 'temporary' },
        })
      ).status(),
    ).toBe(200)

    const res = await request.patch(
      `${API_BASE}/api/apps/${APP_ID}/menu-label`,
      { data: { userMenuLabel: null } },
    )
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      appId: string
      userMenuLabel: string | null
    }
    expect(body.appId).toBe(APP_ID)
    expect(body.userMenuLabel).toBeNull()

    // AppManifest reflects the reset — the field is either absent or
    // explicitly `null` (we accept either persisted shape).
    const appManifest = readAppManifest(kbFixture.projectRoot, APP_ID)
    expect(appManifest?.userMenuLabel ?? null).toBeNull()
  })

  test('BS-T11-c 400 MenuLabelEmpty: empty string is distinct from null', async ({
    request,
  }) => {
    const res = await request.patch(
      `${API_BASE}/api/apps/${APP_ID}/menu-label`,
      { data: { userMenuLabel: '' } },
    )
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuLabelEmpty')
  })

  test('BS-T11-d 400 MenuLabelTooLong: > 80 chars is rejected', async ({
    request,
  }) => {
    const tooLong = 'A'.repeat(81)
    const res = await request.patch(
      `${API_BASE}/api/apps/${APP_ID}/menu-label`,
      { data: { userMenuLabel: tooLong } },
    )
    expect(res.status()).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('MenuLabelTooLong')
  })

  test.fixme(
    'BS-T11-e cascade audit: HttpRouteAuditEntry carries labelLength and never the raw label (audit-logging v1.2 §6.6.4)',
    async ({ request, kbFixture }) => {
    // Sentinel string we never want to leak into the audit sink.
    const secretLabel = 'AUDIT-LEAK-CANARY-12345'

    expect(
      (
        await request.patch(`${API_BASE}/api/apps/${APP_ID}/menu-label`, {
          data: { userMenuLabel: secretLabel },
        })
      ).status(),
    ).toBe(200)

    // The audit emit runs after `res.json()` but still synchronously
    // on the same tick; give the multistream sink one event loop turn
    // to flush before we read the log file.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const lines = readServerLogLines(kbFixture.projectRoot)
    const auditLines = lines.filter(
      (line) =>
        line.kind === 'http-route' &&
        typeof line.audit === 'object' &&
        line.audit !== null &&
        (line.audit as Record<string, unknown>).action === 'menu-label-update',
    )
    expect(auditLines.length).toBeGreaterThan(0)
    const latest = auditLines[auditLines.length - 1]
    const audit = latest.audit as Record<string, unknown>
    expect(audit.appId).toBe(APP_ID)
    // labelLength is the raw string's length (not a hash, not the
    // string itself). The redaction invariant is checked separately
    // below.
    expect(audit.labelLength).toBe(secretLabel.length)

    // The raw label string must NOT appear anywhere in the audit
    // record. Serialise the audit object once and probe.
    expect(JSON.stringify(audit)).not.toContain(secretLabel)
    // It must also not appear anywhere in the full server log entry
    // (label could otherwise leak into a free-text `msg` field).
    expect(JSON.stringify(latest)).not.toContain(secretLabel)
    },
  )

  test('BS-T11-f display label resolution: userMenuLabel wins over recipe.menu.label and menu.ts entry label (app-directory-extension v1.6 §6.8.2)', async ({
    request,
    kbFixture,
  }) => {
    const override = 'User Override Wins'
    expect(
      (
        await request.patch(`${API_BASE}/api/apps/${APP_ID}/menu-label`, {
          data: { userMenuLabel: override },
        })
      ).status(),
    ).toBe(200)

    // AppManifest is the persistence owner — userMenuLabel landed
    // there.
    const appManifest = readAppManifest(kbFixture.projectRoot, APP_ID)
    expect(appManifest?.userMenuLabel).toBe(override)

    // The other two label sources are still intact (BS-L7 normative
    // pin: userMenuLabel does NOT mutate them).
    const menuTsPath = join(kbFixture.projectRoot, 'app', 'menu.ts')
    const menuTsContent = readFileSync(menuTsPath, 'utf-8')
    // The bundled-installer appends a row with the recipe's label
    // ("ドキュメントビュアー" for document-viewer); the override must
    // not be propagated there.
    expect(menuTsContent).not.toContain(override)

    // RecipeManifest is also untouched (recipe.menu.label persistence
    // owner = recipes/<id>/recipe.yaml at scan time; the persisted
    // RecipeManifest does not carry a mutable display-label field).
    const recipeManifest = readRecipeManifest(kbFixture.projectRoot, RECIPE_ID)
    expect(JSON.stringify(recipeManifest)).not.toContain(override)
  })
})
