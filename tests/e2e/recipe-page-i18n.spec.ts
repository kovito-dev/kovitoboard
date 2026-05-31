/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe page body i18n — `/@fs` live-mount E2E tests
 * (BL-208 T2, implementation-request §5.3 / §5.5).
 *
 * Verifies that the two bundled recipe pages localize their own UI
 * copy by `window.kb.locale`, per
 *   docs/specs/app-directory-extension.md v1.7.1 §5.4.1 / §5.4.2 / §5.4.4
 *   docs/specs/i18n-architecture.md v1.1 §10.5
 *
 * A recipe page lives outside the host build graph (`/@fs` dynamic
 * import) and cannot reach the host `t()` catalog, so it carries its
 * own per-locale STRINGS set (`pages/strings.ts`) and selects the one
 * matching `window.kb.locale`. The host bridge (`injectKb`) snapshots
 * `getLocale()` at recipe-page mount time, so the page paints the
 * active host locale on (re)mount.
 *
 * Locale control in L1 — drive the SERVER locale, not localStorage:
 *   The renderer resolves its locale at boot via
 *   `bootstrapLocaleFromSetting()` (main.tsx), which fetches the
 *   server `setting.json:locale` and `setLocale()`s it BEFORE App
 *   mounts — overriding the `localStorage 'kb.locale'` seed the
 *   l1-per-test-setup page fixture writes. The recipe-scoped
 *   `injectKb` bridge then snapshots that server-resolved locale at
 *   mount. So the recipe page body locale tracks `setting.json:locale`.
 *   These tests edit `setting.json` on disk before the first
 *   navigation (the per-test snapshot/restore rolls it back).
 *
 * Expected copy is asserted against literals owned by this test layer
 * (NOT imported from the recipe's own `pages/strings.ts`): importing
 * the implementation's table would make the assertions tautological —
 * a wrong edit to `strings.ts` (e.g. a ja/en swap) would flow into the
 * expectation and still pass. The literals below mirror
 * `recipes/<id>/pages/strings.ts` and must be updated together with an
 * intentional copy change.
 *
 * Navigation is decoupled from the nav-label localization under test in
 * recipe-nav-label-i18n.spec.ts: the sidebar entry is selected by its
 * stable, locale-independent `data-testid` (`nav-entry-ext/<appId>`)
 * rather than by its localized title. A nav-label regression therefore
 * fails T1 (its dedicated spec) rather than masking a body-i18n
 * failure here.
 *
 * Coverage:
 *   - T2-a DocumentViewer body renders Japanese copy (locale=ja).
 *   - T2-b DocumentViewer body renders English copy (locale=en).
 *   - T2-c TodoPage body renders Japanese copy (locale=ja).
 *   - T2-d TodoPage body renders English copy (locale=en).
 */
import { test, expect, type Page } from './helpers/l1-per-test-setup'
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

// Spec-owned expected copy, mirrored from recipes/<id>/pages/strings.ts.
// Defined here (not imported) so a wrong edit to the implementation's
// table cannot silently satisfy these assertions.
const EXPECTED = {
  doc: {
    ja: {
      subtitle:
        'Markdown / HTML ファイルのビューアです。機能の追加・変更は、右側のサイドパネルからエージェントに依頼してください。',
      selectFile: '左のパネルからファイルを選択してください',
    },
    en: {
      subtitle:
        'A viewer for Markdown and HTML files. To add or change features, ask the agent from the side panel on the right.',
      selectFile: 'Select a file from the left panel to view',
    },
  },
  todo: {
    ja: {
      subtitle:
        'シンプルな ToDo アプリです。機能の追加・変更は、右側のサイドパネルからエージェントに依頼してください。',
    },
    en: {
      subtitle:
        'A simple to-do app. To add or change features, ask the agent from the side panel on the right.',
    },
  },
} as const

/**
 * Land on /agents (full reload — boots the locale from setting.json),
 * wait for menu-entries, then click the recipe's nav entry (selected by
 * its stable `data-testid`, NOT its localized title) to route to
 * /ext/<appId> via the in-app router (no reload, so the dynamic route
 * stays registered). Mirrors s12-ambient-sidebar's `openExtAppWithSidebar`
 * navigation contract, but keyed by app identity for locale independence.
 */
async function openRecipePage(page: Page, appId: string): Promise<void> {
  await page.goto('/agents')
  // Deterministic UI wait: the ext-app nav entry only renders after
  // `loadUserMenuEntries()` resolves and React paints it, so waiting for
  // the button is a strictly stronger signal than a `waitForResponse`
  // attached post-navigation (which can miss a response that completes
  // before the waiter subscribes — a known E2E flake source).
  // App.tsx prefixes user menu entry ids with `ext/`, so the nav button
  // testid is `nav-entry-ext/<appId>`.
  const navButton = page.getByTestId(`nav-entry-ext/${appId}`)
  await navButton.waitFor({ state: 'visible', timeout: 10_000 })
  await navButton.click()
  await page.waitForURL(`**/ext/${appId}`)
  await page.waitForLoadState('networkidle')
}

test.describe('Recipe page body i18n (BL-208 T2)', () => {
  let originalMenuTs: string | null = null

  test.beforeEach(async ({ request, kbFixture }) => {
    originalMenuTs = rewriteMenuTsForEnable(kbFixture.projectRoot)
    for (const recipeId of [DOC_RECIPE_ID, TODO_RECIPE_ID]) {
      expect(
        (
          await request.post(
            `${kbFixture.apiBaseUrl}/api/recipes/sample/${recipeId}/enable`,
          )
        ).status(),
      ).toBe(200)
    }
  })

  test.afterEach(async ({ kbFixture }) => {
    for (const appId of [DOC_APP_ID, TODO_APP_ID]) {
      cleanupAppDir(kbFixture.projectRoot, appId)
      removeAppDataDir(kbFixture.projectRoot, appId)
    }
    if (originalMenuTs !== null) {
      restoreMenuTs(kbFixture.projectRoot, originalMenuTs)
      originalMenuTs = null
    }
  })

  test('T2-a DocumentViewer body renders Japanese copy (locale=ja)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    await openRecipePage(page, DOC_APP_ID)
    await expect(page.getByTestId('docviewer')).toBeVisible()
    await expect(page.getByText(EXPECTED.doc.ja.subtitle)).toBeVisible()
    await expect(page.getByText(EXPECTED.doc.ja.selectFile)).toBeVisible()
  })

  test('T2-b DocumentViewer body renders English copy (locale=en)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    await openRecipePage(page, DOC_APP_ID)
    await expect(page.getByTestId('docviewer')).toBeVisible()
    await expect(page.getByText(EXPECTED.doc.en.subtitle)).toBeVisible()
    await expect(page.getByText(EXPECTED.doc.en.selectFile)).toBeVisible()
  })

  test('T2-c TodoPage body renders Japanese copy (locale=ja)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    await openRecipePage(page, TODO_APP_ID)
    await expect(page.getByTestId('todo')).toBeVisible()
    await expect(page.getByText(EXPECTED.todo.ja.subtitle)).toBeVisible()
  })

  test('T2-d TodoPage body renders English copy (locale=en)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    await openRecipePage(page, TODO_APP_ID)
    await expect(page.getByTestId('todo')).toBeVisible()
    await expect(page.getByText(EXPECTED.todo.en.subtitle)).toBeVisible()
  })
})
