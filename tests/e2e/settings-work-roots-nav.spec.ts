/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Work Roots → Settings modal integration (v0.2.1 §1.6 A-11).
 *
 * PR #61 moved Work Roots from a standalone side-nav page into a tab
 * inside the Settings modal. The API contract and the `/work-roots`
 * deep-link route are unchanged (covered by cwd-allowlist-deny.spec.ts);
 * this spec pins the NEW navigation path that PR #61 introduced:
 *
 *   title-bar gear → Settings modal → "Work roots" tab → SettingsWorkRoots
 *
 * Normative sources (decision doc v1.1 §3 / implementation request §2):
 *   - WR-I5  : the side-nav no longer carries a work-roots entry
 *   - WR-I7  : the six pre-existing Settings tabs are unchanged; the
 *              `workRoots` tab is additively inserted right after `basic`
 *   - §3 #2/#7: SettingsWorkRoots mounts through the modal and the new
 *              flow works end to end
 *
 * The blank-onboarded fixture pins `locale: "en"` in setting.json
 * (server-side resolution wins — see nav-rebrand.spec.ts), so the en
 * labels are the defaults asserted here. No production testid was added:
 * the gear is reachable via its `title` attribute, the tab via its
 * accessible (button) name, and the panel via the existing
 * `work-roots-*` testids already shipped in SettingsWorkRoots.tsx.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

// i18n en values (src/renderer/i18n/en.ts):
//   nav.titleBar.settings = 'Settings'
//   setting.title         = 'Settings'
//   setting.tab.*         = Basic / Work roots / Skills / Automations /
//                           Integrations / Rules / Sidebar
const SETTINGS_GEAR_TITLE = 'Settings'
const TAB_LABELS_IN_ORDER = [
  'Basic',
  'Work roots',
  'Skills',
  'Automations',
  'Integrations',
  'Rules',
  'Sidebar',
] as const

async function openSettingsModal(page: Page): Promise<void> {
  await page.goto('/agents')
  await page.waitForLoadState('networkidle')
  await page.locator(`button[title="${SETTINGS_GEAR_TITLE}"]`).click()
  // The modal heading confirms the dialog mounted before we touch tabs.
  await expect(
    page.getByRole('heading', { name: 'Settings' }),
  ).toBeVisible()
}

test.describe('Work Roots → Settings modal integration (A-11)', () => {
  test('WR-T1: the gear opens Settings with all 7 tabs, workRoots inserted right after Basic', async ({
    page,
  }) => {
    await openSettingsModal(page)

    // WR-I7: the six pre-existing tabs are still present and the
    // `workRoots` tab is added — exactly seven tab buttons.
    for (const label of TAB_LABELS_IN_ORDER) {
      await expect(
        page.getByRole('button', { name: label, exact: true }),
      ).toBeVisible()
    }

    // Decision doc §2.2 case B-1: `workRoots` sits at position 2,
    // between `basic` and `skills`. The tab bar is laid out
    // horizontally, so pin the order via left-edge x coordinates
    // rather than coupling to a brittle DOM-index selector.
    const basicBox = await page
      .getByRole('button', { name: 'Basic', exact: true })
      .boundingBox()
    const workRootsBox = await page
      .getByRole('button', { name: 'Work roots', exact: true })
      .boundingBox()
    const skillsBox = await page
      .getByRole('button', { name: 'Skills', exact: true })
      .boundingBox()
    expect(basicBox).not.toBeNull()
    expect(workRootsBox).not.toBeNull()
    expect(skillsBox).not.toBeNull()
    expect(basicBox!.x).toBeLessThan(workRootsBox!.x)
    expect(workRootsBox!.x).toBeLessThan(skillsBox!.x)
  })

  test('WR-T2: the Work roots tab mounts SettingsWorkRoots (new flow core)', async ({
    page,
  }) => {
    await openSettingsModal(page)
    await page.getByRole('button', { name: 'Work roots', exact: true }).click()

    // SettingsWorkRoots core surfaces — add input, add button, and the
    // empty-state marker (a fresh blank-onboarded project has no
    // additional work roots).
    await expect(page.getByTestId('work-roots-input')).toBeVisible()
    await expect(page.getByTestId('work-roots-add-button')).toBeVisible()
    await expect(page.getByTestId('work-roots-empty')).toBeVisible()
  })

  test('WR-T3: the side-nav no longer carries a Work roots entry (WR-I5)', async ({
    page,
  }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')
    // Side-nav entries render as `<button title="...">` (see
    // nav-rebrand.spec.ts). The Settings-modal tab is a text-content
    // button with NO title attribute, so this title selector matches
    // only a side-nav entry and never the modal tab.
    await expect(page.locator('button[title="Work roots"]')).toHaveCount(0)
  })

  test.describe('WR-T4: add → list → delete round-trip through the modal', () => {
    const createdDirs: string[] = []

    test.afterEach(() => {
      // The added work root is persisted under `.kovitoboard/` and is
      // rolled back by kbFixture's snapshot/restore; the sibling temp
      // directory lives OUTSIDE the fixture, so remove it explicitly.
      for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('adding a valid path surfaces a list item, deleting it returns to empty', async ({
      page,
    }) => {
      // A writable absolute path outside the denylist — mirrors the
      // sibling-temp-dir approach in cwd-allowlist-deny.spec.ts.
      const sibling = mkdtempSync(join(tmpdir(), 'kb-wr-ui-e2e-add-'))
      createdDirs.push(sibling)

      await openSettingsModal(page)
      await page
        .getByRole('button', { name: 'Work roots', exact: true })
        .click()
      await expect(page.getByTestId('work-roots-empty')).toBeVisible()

      // Add: type the absolute path, submit, expect a single list item.
      await page.getByTestId('work-roots-input').fill(sibling)
      await page.getByTestId('work-roots-add-button').click()
      await expect(page.getByTestId('work-roots-list')).toBeVisible()
      await expect(page.getByTestId('work-roots-item')).toHaveCount(1)

      // Delete: item delete button opens a confirm dialog. Both the
      // list button and the dialog confirm button read "Delete"
      // (common.delete), so scope the confirm click to the dialog.
      await page.getByTestId('work-roots-delete-button').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

      // Back to the empty state — the round-trip closed cleanly.
      await expect(page.getByTestId('work-roots-empty')).toBeVisible()
    })
  })
})
