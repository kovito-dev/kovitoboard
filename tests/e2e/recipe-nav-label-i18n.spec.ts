/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe nav menu-label locale resolution — server-side E2E tests
 * (BL-206 T1, implementation-request §5.1 / §5.2).
 *
 * Verifies the locale-aware base-label resolution added to
 * `GET /api/app/menu-entries` against
 *   docs/specs/app-directory-extension.md v1.7.1 §6.8.2 / §6.8.2.1
 *   docs/specs/i18n-architecture.md v1.1 §6.6
 *
 * Resolution chain (app-directory-extension v1.7.1 §6.8.2):
 *   userMenuLabel
 *     ?? i18n.<locale>.menu[appId].label   (recipe-source apps only)
 *     ?? top-level menu[appId].label
 *     ?? menu.ts entry.label
 *     ?? appId
 * The recipe.yaml is read from the OSS source tree
 * (`<kovitoboardRoot>/recipes/<recipeId>/recipe.yaml`), since install
 * persists only manifest.json.
 *
 * The server resolves the active locale from `setting.json:locale`
 * (`readSetting(fs)?.locale ?? 'en'`) at request time; the wire `label`
 * field carries the locale-resolved base label. These tests drive the
 * locale by editing `.kovitoboard/setting.json` on disk (the per-test
 * snapshot/restore in l1-per-test-setup rolls it back afterwards) and
 * then re-fetch menu-entries — the natural refetch path the spec pins
 * as the reflection point (§5.1).
 *
 * Coverage:
 *   - T1-a happy en: document-viewer nav label is "Documents"
 *     (i18n.en.menu override).
 *   - T1-b happy ja: same row falls back to the top-level "ドキュメント".
 *   - T1-c regression todo: "TODO" is locale-invariant (no i18n.menu
 *     axis on the todo recipe → top-level label both ways).
 *   - T1-d regression userMenuLabel: an explicit override is
 *     locale-invariant (highest precedence, locale-independent).
 *   - T1-e regression self-made: an app/menu.ts entry with no recipe
 *     lineage keeps its menu.ts label across locales (resolver skipped).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import {
  rewriteMenuTsForEnable,
  restoreMenuTs,
  cleanupAppDir,
  removeAppDataDir,
} from './helpers/v021-bundled-helpers'
import { setLocaleOnDisk } from './helpers/locale-fixture'

const DOC_RECIPE_ID = 'document-viewer'
const DOC_APP_ID = 'document-viewer'
const TODO_RECIPE_ID = 'todo'
const TODO_APP_ID = 'todo'

interface MenuEntryWire {
  id: string
  /** Locale-resolved base label (recipe.yaml resolution writes here). */
  label: string
  /** Explicit user override; `null` when unset. Locale-independent. */
  userMenuLabel: string | null
}

/**
 * Fetch the raw menu-entries wire payload as an id→entry map.
 * The wire ships the resolved base `label` and the `userMenuLabel`
 * override as separate fields; the renderer composes them
 * (`userMenuLabel ?? label ?? displayName ?? appId`, AppsTab.tsx).
 */
async function fetchMenuEntries(
  request: import('@playwright/test').APIRequestContext,
  apiBase: string,
): Promise<Record<string, MenuEntryWire>> {
  const res = await request.get(`${apiBase}/api/app/menu-entries`)
  expect(res.status()).toBe(200)
  const entries = (await res.json()) as MenuEntryWire[]
  const byId: Record<string, MenuEntryWire> = {}
  for (const e of entries) byId[e.id] = e
  return byId
}

/** Effective nav label the renderer paints: `userMenuLabel ?? label`. */
function effectiveLabel(entry: MenuEntryWire): string {
  return entry.userMenuLabel ?? entry.label
}

/** Convenience: fetch menu-entries and return id→effective-label map. */
async function fetchMenuLabels(
  request: import('@playwright/test').APIRequestContext,
  apiBase: string,
): Promise<Record<string, string>> {
  const entries = await fetchMenuEntries(request, apiBase)
  const byId: Record<string, string> = {}
  for (const id of Object.keys(entries)) byId[id] = effectiveLabel(entries[id])
  return byId
}

test.describe('Recipe nav menu-label locale resolution (BL-206 T1)', () => {
  let originalMenuTs: string | null = null

  test.beforeEach(async ({ request, kbFixture }) => {
    originalMenuTs = rewriteMenuTsForEnable(kbFixture.projectRoot)
    expect(
      (
        await request.post(
          `${kbFixture.apiBaseUrl}/api/recipes/sample/${DOC_RECIPE_ID}/enable`,
        )
      ).status(),
    ).toBe(200)
  })

  test.afterEach(async ({ kbFixture }) => {
    cleanupAppDir(kbFixture.projectRoot, DOC_APP_ID)
    removeAppDataDir(kbFixture.projectRoot, DOC_APP_ID)
    cleanupAppDir(kbFixture.projectRoot, TODO_APP_ID)
    removeAppDataDir(kbFixture.projectRoot, TODO_APP_ID)
    if (originalMenuTs !== null) {
      restoreMenuTs(kbFixture.projectRoot, originalMenuTs)
      originalMenuTs = null
    }
  })

  test('T1-a en: document-viewer nav label resolves to "Documents" (i18n.en.menu override)', async ({
    request,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    const labels = await fetchMenuLabels(request, kbFixture.apiBaseUrl)
    expect(labels[DOC_APP_ID]).toBe('Documents')
  })

  test('T1-b ja: document-viewer nav label falls back to top-level "ドキュメント"', async ({
    request,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    const labels = await fetchMenuLabels(request, kbFixture.apiBaseUrl)
    expect(labels[DOC_APP_ID]).toBe('ドキュメント')
  })

  test('T1-c regression: todo nav label "TODO" is locale-invariant (no i18n.menu axis)', async ({
    request,
    kbFixture,
  }) => {
    expect(
      (
        await request.post(
          `${kbFixture.apiBaseUrl}/api/recipes/sample/${TODO_RECIPE_ID}/enable`,
        )
      ).status(),
    ).toBe(200)

    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    expect(
      (await fetchMenuLabels(request, kbFixture.apiBaseUrl))[TODO_APP_ID],
    ).toBe('TODO')

    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    expect(
      (await fetchMenuLabels(request, kbFixture.apiBaseUrl))[TODO_APP_ID],
    ).toBe('TODO')
  })

  test('T1-d regression: userMenuLabel override is locale-invariant (highest precedence)', async ({
    request,
    kbFixture,
  }) => {
    const override = 'Mes documents'
    expect(
      (
        await request.patch(
          `${kbFixture.apiBaseUrl}/api/apps/${DOC_APP_ID}/menu-label`,
          { data: { userMenuLabel: override } },
        )
      ).status(),
    ).toBe(200)

    // The override lives on the dedicated `userMenuLabel` wire field
    // and is locale-independent — the locale resolver is gated to
    // `userMenuLabel == null` entries (§6.8.2.1), so it never rewrites
    // an overridden row. The effective label the renderer paints
    // (`userMenuLabel ?? label`) is therefore the override in both
    // locales, even though the i18n.en.menu override exists on the
    // recipe.yaml.
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    const en = (await fetchMenuEntries(request, kbFixture.apiBaseUrl))[
      DOC_APP_ID
    ]
    expect(en.userMenuLabel).toBe(override)
    expect(effectiveLabel(en)).toBe(override)

    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    const ja = (await fetchMenuEntries(request, kbFixture.apiBaseUrl))[
      DOC_APP_ID
    ]
    expect(ja.userMenuLabel).toBe(override)
    expect(effectiveLabel(ja)).toBe(override)
  })

  test('T1-e regression: self-made menu.ts entry label is locale-invariant (resolver skipped)', async ({
    request,
    kbFixture,
  }) => {
    // The blank-onboarded fixture ships a self-made `l1-fixture-app`
    // menu.ts entry with no recipe lineage (no AppManifest
    // source.type === 'recipe'), so the recipe.yaml locale resolver is
    // never entered and the menu.ts label rides through unchanged.
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    expect(
      (await fetchMenuLabels(request, kbFixture.apiBaseUrl))['l1-fixture-app'],
    ).toBe('L1 Fixture App')

    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    expect(
      (await fetchMenuLabels(request, kbFixture.apiBaseUrl))['l1-fixture-app'],
    ).toBe('L1 Fixture App')
  })
})
