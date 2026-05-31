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
 *   These tests therefore edit `setting.json` on disk before the first
 *   navigation (the per-test snapshot/restore rolls it back). This is
 *   also why the nav button label tracks the same locale.
 *
 * Coverage:
 *   - T2-a DocumentViewer body renders Japanese copy (locale=ja).
 *   - T2-b DocumentViewer body renders English copy (locale=en).
 *   - T2-c TodoPage body renders Japanese copy (locale=ja).
 *   - T2-d TodoPage body renders English copy (locale=en).
 */
import { test, expect, type Page } from './helpers/l1-per-test-setup'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  rewriteMenuTsForEnable,
  restoreMenuTs,
  cleanupAppDir,
  removeAppDataDir,
} from './helpers/v021-bundled-helpers'
import { STRINGS as DOC_STRINGS } from '../../recipes/document-viewer/pages/strings'
import { STRINGS as TODO_STRINGS } from '../../recipes/todo/pages/strings'

const API_BASE = 'http://127.0.0.1:3001'
const DOC_RECIPE_ID = 'document-viewer'
const DOC_APP_ID = 'document-viewer'
const TODO_RECIPE_ID = 'todo'
const TODO_APP_ID = 'todo'

type Locale = 'ja' | 'en'

/** The server-resolved nav label per locale (drives the button title). */
const NAV_LABEL: Record<string, Record<Locale, string>> = {
  [DOC_APP_ID]: { ja: 'ドキュメント', en: 'Documents' },
  [TODO_APP_ID]: { ja: 'TODO', en: 'TODO' },
}

/**
 * Overwrite `setting.json:locale` on disk. The renderer boots its
 * locale from this value (`bootstrapLocaleFromSetting`), so it must be
 * set before the first navigation. The per-test `.kovitoboard/`
 * snapshot/restore rolls the file back afterwards.
 */
function setLocaleOnDisk(projectRoot: string, locale: Locale): void {
  const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
  const setting = JSON.parse(readFileSync(settingPath, 'utf-8')) as Record<
    string,
    unknown
  >
  setting.locale = locale
  writeFileSync(settingPath, JSON.stringify(setting, null, 2))
}

/**
 * Land on /agents (full reload — boots the locale from setting.json),
 * wait for menu-entries, then click the recipe's nav button to route
 * to /ext/<appId> via the in-app router (no reload, so the dynamic
 * route stays registered). Mirrors s12-ambient-sidebar's
 * `openExtAppWithSidebar` navigation contract.
 */
async function openRecipePage(
  page: Page,
  appId: string,
  navLabel: string,
): Promise<void> {
  await page.goto('/agents')
  await page.waitForResponse(
    (r) => r.url().endsWith('/api/app/menu-entries') && r.ok(),
  )
  const navButton = page.locator(`button[title="${navLabel}"]`).first()
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
          await request.post(`${API_BASE}/api/recipes/sample/${recipeId}/enable`)
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
    await openRecipePage(page, DOC_APP_ID, NAV_LABEL[DOC_APP_ID].ja)
    await expect(page.getByTestId('docviewer')).toBeVisible()
    await expect(page.getByText(DOC_STRINGS.ja.subtitle)).toBeVisible()
    await expect(page.getByText(DOC_STRINGS.ja.selectFile)).toBeVisible()
  })

  test('T2-b DocumentViewer body renders English copy (locale=en)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    await openRecipePage(page, DOC_APP_ID, NAV_LABEL[DOC_APP_ID].en)
    await expect(page.getByTestId('docviewer')).toBeVisible()
    await expect(page.getByText(DOC_STRINGS.en.subtitle)).toBeVisible()
    await expect(page.getByText(DOC_STRINGS.en.selectFile)).toBeVisible()
  })

  test('T2-c TodoPage body renders Japanese copy (locale=ja)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'ja')
    await openRecipePage(page, TODO_APP_ID, NAV_LABEL[TODO_APP_ID].ja)
    await expect(page.getByTestId('todo')).toBeVisible()
    await expect(page.getByText(TODO_STRINGS.ja.subtitle)).toBeVisible()
  })

  test('T2-d TodoPage body renders English copy (locale=en)', async ({
    page,
    kbFixture,
  }) => {
    setLocaleOnDisk(kbFixture.projectRoot, 'en')
    await openRecipePage(page, TODO_APP_ID, NAV_LABEL[TODO_APP_ID].en)
    await expect(page.getByTestId('todo')).toBeVisible()
    await expect(page.getByText(TODO_STRINGS.en.subtitle)).toBeVisible()
  })
})
