/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `recipe-parser.ts`'s v0.2.1 BL-2026-206 additions:
 *
 *   - `extractI18nOverrides` extracts the `i18n.<locale>.menu[<id>].label`
 *     axis (app-directory-extension.md v1.7.1 §6.8.2.1) alongside the
 *     pre-existing `name` / `description` overrides, trimming labels
 *     and dropping blank ones so an empty override never shadows the
 *     top-level base label.
 *   - `extractMenuEntries` enforces `menu[].id` uniqueness at parse
 *     time (a duplicate id is rejected as a recipe error), which is
 *     the prerequisite for the id-keyed `id === appId` base-label
 *     resolution.
 *
 * The tests build a minimal in-memory recipe directory and exercise
 * the real `parseRecipe` entry point (mirrors the fs-mock pattern in
 * `recipe-parser-recipe-id.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileAccessLayer } from '../../src/server/fs-layer'

const recipeLoggerStub = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
vi.mock('../../src/server/logger', () => ({
  recipeLogger: recipeLoggerStub,
}))

const RECIPE_DIR = '/recipe-dir'

function makeMockFs(seed: Record<string, string>): FileAccessLayer {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>([RECIPE_DIR])
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return {
    readFileSync: (p) => {
      const f = files.get(p)
      if (f == null) throw new Error(`ENOENT: ${p}`)
      return f
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: () => {
      throw new Error('writeFileSync not supported in mock')
    },
    unlinkSync: () => {
      throw new Error('unlinkSync not supported in mock')
    },
    rmSync: () => {
      throw new Error('rmSync not supported in mock')
    },
    existsSync: (p) => files.has(p) || dirs.has(p),
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const items = new Set<string>()
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) items.add(filePath.slice(prefix.length).split('/')[0])
      }
      return [...items]
    },
    mkdirSync: () => {
      /* no-op */
    },
    symlinkSync: () => {
      throw new Error('symlinkSync not supported in mock')
    },
    realpathSync: (p) => {
      if (!files.has(p) && !dirs.has(p)) throw new Error(`ENOENT: ${p}`)
      return p
    },
    watch: () => ({ close: async () => {} }),
  }
}

function seed(recipeYaml: string): FileAccessLayer {
  return makeMockFs({
    [`${RECIPE_DIR}/recipe.yaml`]: recipeYaml,
    [`${RECIPE_DIR}/pages/DocumentViewer.tsx`]: '// stub',
  })
}

const BASE_YAML = `---
recipeId: "document-viewer"
name: "ドキュメントビュアー"
description: "test"
version: "1.0.0"
artifacts:
  - path: "pages/DocumentViewer.tsx"
    type: "page"
`

afterEach(() => vi.clearAllMocks())

describe('parseRecipe — i18n menu label axis (§6.8.2.1)', () => {
  it('extracts i18n.<locale>.menu[<id>].label into metadata.i18n', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}i18n:
  en:
    name: "Document Viewer"
    menu:
      document-viewer:
        label: "Documents"
menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    const recipe = parseRecipe(RECIPE_DIR, seed(yaml))
    expect(recipe.metadata.i18n?.en?.menu?.['document-viewer']?.label).toBe('Documents')
    // top-level base label is untouched (locale-independent fallback)
    expect(recipe.menu[0].label).toBe('ドキュメント')
  })

  it('drops a blank / whitespace-only menu label override', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}i18n:
  en:
    menu:
      document-viewer:
        label: "   "
menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    const recipe = parseRecipe(RECIPE_DIR, seed(yaml))
    // Blank override dropped: the locale entry carries no menu map
    // (and since en had no name/description either, the whole en
    // entry is dropped).
    expect(recipe.metadata.i18n?.en?.menu?.['document-viewer']?.label).toBeUndefined()
  })

  it('does not pollute Object.prototype via __proto__ locale / menu keys', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}i18n:
  __proto__:
    name: "polluted"
  en:
    menu:
      __proto__:
        label: "polluted"
      document-viewer:
        label: "Documents"
menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    const recipe = parseRecipe(RECIPE_DIR, seed(yaml))
    // Object.prototype must be untouched
    expect(({} as Record<string, unknown>).name).toBeUndefined()
    expect(({} as Record<string, unknown>).label).toBeUndefined()
    // Legitimate keys still resolve
    expect(recipe.metadata.i18n?.en?.menu?.['document-viewer']?.label).toBe('Documents')
  })

  it('keeps name/description overrides working without a menu axis', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}i18n:
  en:
    name: "Document Viewer"
    description: "A viewer."
menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    const recipe = parseRecipe(RECIPE_DIR, seed(yaml))
    expect(recipe.metadata.i18n?.en?.name).toBe('Document Viewer')
    expect(recipe.metadata.i18n?.en?.description).toBe('A viewer.')
    expect(recipe.metadata.i18n?.en?.menu).toBeUndefined()
  })
})

describe('parseRecipe — menu[].id uniqueness (§6.8.2.1 prerequisite)', () => {
  it('rejects a recipe.yaml with duplicate menu ids', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
  - id: "document-viewer"
    label: "Duplicate"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    expect(() => parseRecipe(RECIPE_DIR, seed(yaml))).toThrow(/duplicate "id"/i)
  })

  it('accepts a recipe.yaml with distinct menu ids', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = `${BASE_YAML}menu:
  - id: "document-viewer"
    label: "ドキュメント"
    icon: "content"
    page: "pages/DocumentViewer"
  - id: "other-view"
    label: "Other"
    icon: "content"
    page: "pages/DocumentViewer"
---`
    const recipe = parseRecipe(RECIPE_DIR, seed(yaml))
    expect(recipe.menu.map((m) => m.id)).toEqual(['document-viewer', 'other-view'])
  })
})
