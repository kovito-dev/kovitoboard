/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.1 BL-2026-206 locale-aware base-label resolution
 * in `readUserMenuEntries` (app-directory-extension.md v1.7.1
 * §6.8.2.1). The resolver reads the source-tree recipe.yaml
 * (`<kovitoboardRoot>/recipes/<recipeId>/recipe.yaml`) via the shared
 * `parseRecipe` entry point and applies the 3 exclusive cases:
 *
 *   (1) `id === appId` ∧ `i18n.<locale>.menu[appId].label` present → override
 *   (2) `id === appId` ∧ override absent → top-level `menu[appId].label`
 *   (3) no recipe.yaml / no matching entry → fall back to the menu.ts label
 *
 * It also pins the path-containment guard (a tampered `recipeId` that
 * escapes the recipes/ root must not be read) and that `userMenuLabel`
 * still wins above the resolved base label.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { serverLoggerStub } = vi.hoisted(() => ({
  serverLoggerStub: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/server/logger', () => ({
  serverLogger: serverLoggerStub,
  recipeLogger: serverLoggerStub,
  lazyChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { readUserMenuEntries } from '../../src/server/services/menu-extractor'
import type {
  AppManifestLookup,
  AppManifestLookupResult,
} from '../../src/server/services/menu-extractor'
import type { AppManifest } from '../../src/shared/app-manifest-types'
import type { FileAccessLayer } from '../../src/server/fs-layer'

const PROJECT_ROOT = '/test-project'
const KB_ROOT = '/test-kb-root'
const RECIPE_ID = 'doc-viewer'
const APP_ID = 'doc-viewer'

const MENU_TS_BODY = [
  `export const menuEntries = [`,
  `  { id: '${APP_ID}', label: 'menu-ts-label', icon: 'note', component: () => import('./${APP_ID}/pages/Index') },`,
  `]`,
].join('\n')

function recipeYaml(opts: { withEnMenu: boolean }): string {
  const lines = [
    '---',
    `recipeId: "${RECIPE_ID}"`,
    'name: "ドキュメントビュアー"',
    'description: "test"',
    'version: "1.0.0"',
  ]
  if (opts.withEnMenu) {
    lines.push('i18n:', '  en:', '    menu:', `      ${APP_ID}:`, '        label: "Documents"')
  }
  lines.push(
    'artifacts:',
    '  - path: "pages/Index.tsx"',
    '    type: "page"',
    'menu:',
    `  - id: "${APP_ID}"`,
    '    label: "ドキュメント"',
    '    icon: "content"',
    '    page: "pages/Index"',
    '---',
  )
  return lines.join('\n')
}

function makeFs(files: Record<string, string>): FileAccessLayer {
  const fileMap = new Map(Object.entries(files))
  const dirs = new Set<string>([PROJECT_ROOT, KB_ROOT])
  for (const p of fileMap.keys()) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return {
    readFileSync: (p) => {
      const v = fileMap.get(p)
      if (v == null) throw new Error(`ENOENT: ${p}`)
      return v
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: () => {
      throw new Error('not implemented')
    },
    writeFileAtomic: () => {
      throw new Error('not implemented')
    },
    existsSync: (p) => fileMap.has(p) || dirs.has(p),
    statSync: (p) => {
      if (!fileMap.has(p)) throw new Error(`ENOENT: ${p}`)
      return { size: fileMap.get(p)!.length } as unknown as ReturnType<FileAccessLayer['statSync']>
    },
    realpathSync: (p) => p,
    lstatSync: (p) =>
      ({ size: fileMap.get(p)?.length ?? 0, isSymbolicLink: false }) as unknown as ReturnType<
        FileAccessLayer['lstatSync']
      >,
    mkdirSync: () => {},
    rmdirSync: () => {},
    unlinkSync: () => {},
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const items = new Set<string>()
      for (const k of fileMap.keys()) {
        if (k.startsWith(prefix)) items.add(k.slice(prefix.length).split('/')[0])
      }
      return [...items]
    },
    renameSync: () => {},
    appendFileSync: () => {},
    watch: () => ({ close: () => {} }) as unknown as ReturnType<FileAccessLayer['watch']>,
  }
}

function recipeManifest(userMenuLabel: string | null = null): AppManifest {
  return {
    appId: APP_ID,
    displayName: 'doc-viewer display',
    createdAt: '2026-01-01T00:00:00.000Z',
    kovitoboardVersion: '0.2.1',
    source: {
      type: 'recipe',
      recipeId: RECIPE_ID,
      recipeVersion: '1.0.0',
      recipeSource: 'bundled',
    },
    ...(userMenuLabel !== null ? { userMenuLabel } : {}),
  }
}

function lookupFor(manifest: AppManifest): AppManifestLookup {
  return (appId): AppManifestLookupResult =>
    appId === APP_ID ? { state: 'present', manifest } : { state: 'missing' }
}

const PAGE_FILE = `${PROJECT_ROOT}/app/${APP_ID}/pages/Index.tsx`
const MENU_TS = `${PROJECT_ROOT}/app/menu.ts`
const RECIPE_YAML = `${KB_ROOT}/recipes/${RECIPE_ID}/recipe.yaml`
const RECIPE_ARTIFACT = `${KB_ROOT}/recipes/${RECIPE_ID}/pages/Index.tsx`

beforeEach(() => {
  vi.clearAllMocks()
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})
afterAll(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
})

describe('readUserMenuEntries — recipe locale base label (§6.8.2.1)', () => {
  it('case (1): en override resolves to the i18n.en.menu label', () => {
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
      [RECIPE_YAML]: recipeYaml({ withEnMenu: true }),
      [RECIPE_ARTIFACT]: '// stub',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(recipeManifest()),
      undefined,
      'en',
      KB_ROOT,
    )
    expect(entries.find((e) => e.id === APP_ID)?.label).toBe('Documents')
  })

  it('case (2): ja has no override → top-level recipe.yaml label', () => {
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
      [RECIPE_YAML]: recipeYaml({ withEnMenu: true }),
      [RECIPE_ARTIFACT]: '// stub',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(recipeManifest()),
      undefined,
      'ja',
      KB_ROOT,
    )
    expect(entries.find((e) => e.id === APP_ID)?.label).toBe('ドキュメント')
  })

  it('case (3): no source-tree recipe.yaml → menu.ts label retained', () => {
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
      // recipe.yaml intentionally absent
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(recipeManifest()),
      undefined,
      'en',
      KB_ROOT,
    )
    expect(entries.find((e) => e.id === APP_ID)?.label).toBe('menu-ts-label')
  })

  it('userMenuLabel override is left for the renderer (resolver skipped)', () => {
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
      [RECIPE_YAML]: recipeYaml({ withEnMenu: true }),
      [RECIPE_ARTIFACT]: '// stub',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(recipeManifest('My Docs')),
      undefined,
      'en',
      KB_ROOT,
    )
    const entry = entries.find((e) => e.id === APP_ID)
    // userMenuLabel rides separately; base label stays the menu.ts
    // value (resolver is skipped when userMenuLabel is set).
    expect(entry?.userMenuLabel).toBe('My Docs')
    expect(entry?.label).toBe('menu-ts-label')
  })

  it('omitting kovitoboardRoot keeps the legacy menu.ts label', () => {
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
      [RECIPE_YAML]: recipeYaml({ withEnMenu: true }),
      [RECIPE_ARTIFACT]: '// stub',
    })
    const entries = readUserMenuEntries(fs, undefined, lookupFor(recipeManifest()), undefined, 'en')
    expect(entries.find((e) => e.id === APP_ID)?.label).toBe('menu-ts-label')
  })

  it('path-escape recipeId is refused (no read outside recipes/)', () => {
    const tampered = recipeManifest()
    tampered.source = {
      type: 'recipe',
      recipeId: '../../etc/evil',
      recipeVersion: '1.0.0',
      recipeSource: 'bundled',
    }
    const fs = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub',
    })
    const entries = readUserMenuEntries(fs, undefined, lookupFor(tampered), undefined, 'en', KB_ROOT)
    expect(entries.find((e) => e.id === APP_ID)?.label).toBe('menu-ts-label')
    expect(serverLoggerStub.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'recipe-id-path-escape' }),
      expect.any(String),
    )
  })
})
