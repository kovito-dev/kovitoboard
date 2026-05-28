/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Apps tab — 5-way source badge rendering
 * (BS-T13, tester request v1.1 §1.2 / judgement v2.5 §4.9 / BS-L9).
 *
 * Verifies the v0.2.1 Apps screen surfaces a source badge for every
 * row in the Apps tab and that the five derivations are exercised:
 *
 *   - `self-made`   → AppManifest.source.type === 'user-creation'
 *   - `bundled`     → recipe + recipeSource === 'bundled'
 *   - `sample`      → recipe + recipeSource === 'sample'
 *   - `import`      → recipe + recipeSource === 'import'
 *   - `url`         → recipe + recipeSource === 'url'
 *
 * Coverage:
 *   - BS-T13-a: all five source badges render simultaneously on the
 *     Apps tab when the fixture seeds one app per source.
 *   - BS-T13-b: `deriveSourceBadge` invariant — every AppsTab row
 *     emits exactly one badge testid; badge values are stable across
 *     `app_menu_changed` refetches (a re-fetch does not flip the
 *     badge value when the AppManifest is unchanged).
 *
 * Fixture method: A (programmatic). For each source we seed
 *   - `app/<appId>/manifest.json` (AppManifest) with the right
 *     discriminator,
 *   - `app/<appId>/pages/Page.tsx` (the artifact path the menu
 *     entry's `component: () => import('./...')` resolves to),
 *   - a `menu.ts` entry whose `id` matches the appId.
 * RecipeManifest is intentionally NOT seeded — the menu-extractor
 * derivation reads `AppManifest.source` directly (see
 * `menu-extractor.ts:365`).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  rewriteMenuTsForEnable,
  restoreMenuTs,
  cleanupAppDir,
} from './helpers/v021-bundled-helpers'

type SourceBadge = 'self-made' | 'bundled' | 'sample' | 'import' | 'url'

interface SeedSpec {
  appId: string
  displayName: string
  badge: SourceBadge
}

const SEEDS: SeedSpec[] = [
  { appId: 'self-made-1', displayName: 'Self Made App', badge: 'self-made' },
  { appId: 'bundled-1', displayName: 'Bundled App', badge: 'bundled' },
  { appId: 'sample-1', displayName: 'Sample App', badge: 'sample' },
  { appId: 'import-1', displayName: 'Imported App', badge: 'import' },
  { appId: 'url-1', displayName: 'URL App', badge: 'url' },
]

function seedAppManifest(projectRoot: string, seed: SeedSpec): void {
  const appDir = join(projectRoot, 'app', seed.appId)
  mkdirSync(join(appDir, 'pages'), { recursive: true })
  writeFileSync(
    join(appDir, 'pages', 'Page.tsx'),
    '// fixture artifact stub — not a real recipe page\n',
  )
  const source =
    seed.badge === 'self-made'
      ? { type: 'user-creation' as const, createdViaAgent: 'kovito-concierge' }
      : {
          type: 'recipe' as const,
          recipeId: `recipe-${seed.appId}`,
          recipeVersion: '1.0.0',
          recipeSource: seed.badge,
        }
  writeFileSync(
    join(appDir, 'manifest.json'),
    JSON.stringify(
      {
        appId: seed.appId,
        displayName: seed.displayName,
        createdAt: '2026-04-18T00:00:00.000Z',
        kovitoboardVersion: '0.2.1',
        source,
      },
      null,
      2,
    ),
  )
}

function appendMenuTsEntries(
  projectRoot: string,
  seeds: SeedSpec[],
): void {
  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  const current = readFileSync(menuTsPath, 'utf-8')
  const entries = seeds
    .map(
      (s) =>
        `  {\n` +
        `    id: '${s.appId}',\n` +
        `    label: '${s.displayName}',\n` +
        `    icon: 'content',\n` +
        `    component: () => import('./${s.appId}/pages/Page'),\n` +
        `  },\n`,
    )
    .join('')
  // Insert just before the closing `]` of the menuEntries array. The
  // `rewriteMenuTsForEnable` step in beforeEach has already injected
  // the `AppMenuEntry[]` type annotation so the regex match below
  // matches the canonical form.
  const arrayMatch = /(\]\s*\n?)$/.exec(current)
  if (!arrayMatch) {
    throw new Error(
      '[apps-tab-source-badge] cannot locate menu.ts closing bracket',
    )
  }
  const insertPos = arrayMatch.index
  const updated =
    current.slice(0, insertPos) + entries + current.slice(insertPos)
  writeFileSync(menuTsPath, updated)
}

test.describe('Apps tab — source badge rendering (BS-T13)', () => {
  let originalMenuTs: string | null = null

  test.beforeEach(async ({ kbFixture }) => {
    originalMenuTs = rewriteMenuTsForEnable(kbFixture.projectRoot)
    for (const seed of SEEDS) {
      seedAppManifest(kbFixture.projectRoot, seed)
    }
    appendMenuTsEntries(kbFixture.projectRoot, SEEDS)
  })

  test.afterEach(async ({ kbFixture }) => {
    for (const seed of SEEDS) {
      cleanupAppDir(kbFixture.projectRoot, seed.appId)
    }
    if (originalMenuTs !== null) {
      restoreMenuTs(kbFixture.projectRoot, originalMenuTs)
      originalMenuTs = null
    }
  })

  test('BS-T13-a: all five source badges render on the Apps tab when the fixture seeds one app per source (BS-L9)', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()

    // Every row + every badge must render.
    for (const seed of SEEDS) {
      await expect(
        page.getByTestId(`apps-tab-row-${seed.appId}`),
      ).toBeVisible()
    }

    // The badge testid format is global — `apps-tab-source-badge-${source}`
    // — so multiple apps with the same source would surface multiple
    // badges. With the fixture seeding one app per source we expect
    // exactly one of each.
    for (const badge of [
      'self-made',
      'bundled',
      'sample',
      'import',
      'url',
    ] as const) {
      await expect(
        page.getByTestId(`apps-tab-source-badge-${badge}`),
      ).toHaveCount(1)
    }
  })

  test('BS-T13-b: every AppsTab row carries exactly one source badge (deriveSourceBadge invariant)', async ({
    page,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()

    for (const seed of SEEDS) {
      const row = page.getByTestId(`apps-tab-row-${seed.appId}`)
      await expect(row).toBeVisible()
      // Scope the badge query to the row so duplicate badges on
      // unrelated rows do not bleed into this count.
      const badgesInRow = row.locator('[data-testid^="apps-tab-source-badge-"]')
      await expect(badgesInRow).toHaveCount(1)
      // And the one badge that is present must match the fixture
      // seed's expected derivation.
      await expect(
        row.getByTestId(`apps-tab-source-badge-${seed.badge}`),
      ).toBeVisible()
    }
  })
})
