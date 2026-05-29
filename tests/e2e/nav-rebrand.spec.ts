/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sidebar nav rebrand (BS-T15, tester request v1.1 §1.2 +
 * judgement v2.5 §4'.1 + §6.1).
 *
 * Verifies that the v0.2.1 rebrand from "アプリレシピ" / "App recipes"
 * to "アプリ" / "Apps" landed on the sidebar nav entry that points at
 * the `/recipes` route (the route name itself is kept for backward
 * compatibility with persisted state — only the displayed label
 * changes).
 *
 * The label is driven by the i18n key `nav.menu.recipes`
 * (`src/renderer/i18n/ja.ts:280` = `'アプリ'`,
 * `src/renderer/i18n/en.ts:284` = `'Apps'`). The blank-onboarded
 * fixture pins `locale: "en"` in `setting.json`, so the en case is
 * the default; the ja case rewrites `setting.json` inside this spec
 * (kbFixture's `.kovitoboard/` snapshot/restore reverts the change in
 * afterEach so adjacent specs are untouched).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function setLocale(projectRoot: string, locale: 'ja' | 'en'): void {
  const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
  const raw = readFileSync(settingPath, 'utf-8')
  const data = JSON.parse(raw) as Record<string, unknown>
  data.locale = locale
  writeFileSync(settingPath, JSON.stringify(data, null, 2))
}

test.describe('Sidebar nav rebrand (BS-T15)', () => {
  test('BS-T15-a (en, default fixture locale): sidebar surfaces the rebrand "Apps" label', async ({
    page,
  }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')
    await expect(
      page.locator('button[title="Apps"]').first(),
    ).toBeVisible()
    // Legacy English copy must not resurface anywhere in the sidebar.
    await expect(
      page.locator('button[title="App recipes"]'),
    ).toHaveCount(0)
  })

  test('BS-T15-b (ja, locale switched): sidebar surfaces the rebrand "アプリ" label', async ({
    page,
    kbFixture,
  }) => {
    // Switch the on-disk fixture locale to ja before the page loads.
    // kbFixture's snapshot/restore reverts this in afterEach so the
    // next spec sees the original en pin.
    setLocale(kbFixture.projectRoot, 'ja')

    await page.goto('/agents')
    await page.waitForLoadState('networkidle')
    await expect(
      page.locator('button[title="アプリ"]').first(),
    ).toBeVisible()
    // Legacy Japanese copy "アプリレシピ" must not surface anywhere.
    await expect(
      page.locator('button[title="アプリレシピ"]'),
    ).toHaveCount(0)
  })

  test('BS-T15-c: clicking the rebrand entry navigates to /recipes (route path retained)', async ({
    page,
  }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')
    await page.locator('button[title="Apps"]').first().click()
    // The path is intentionally kept at /recipes for backward
    // compatibility with persisted state, even though the displayed
    // label changed (judgement v2.5 §4'.1 routing decision).
    await page.waitForURL('**/recipes')
    // The 3-tab AppsScreen is the landing component for /recipes —
    // its Apps tab testid surfaces as soon as routing completes.
    await expect(page.getByTestId('apps-screen-tab-apps')).toBeVisible()
  })
})
