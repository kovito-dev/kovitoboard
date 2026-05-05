/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `buildRecipePrompt` — the v2.0 install handover
 * prompt builder. The agent relies on the section headings as
 * anchors, so this suite pins:
 *
 *   - The stable header line `KovitoBoard Recipe Installation Request`.
 *   - Presence of the five top-level sections in order: Recipe
 *     Information / Recipe Contents / Your Task / Constraints /
 *     補足.
 *   - The 7-step playbook headings under "Your Task".
 *   - Inspection result reflection (yes/no + non-declarative
 *     pattern listing).
 *   - The presence of the recipeId in the mark-installed curl
 *     example so the agent issues the URL with the correct path.
 *   - Sanitization of the author note (uses `sanitizeInstruction`
 *     under the hood).
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.4
 */
import { describe, expect, it } from 'vitest'
import {
  RECIPE_INSTALL_HEADER,
  buildRecipePrompt,
} from '../../src/server/recipe-applicator'
import type {
  ArtifactWithContent,
  InspectionResult,
  ParsedRecipe,
} from '../../src/shared/recipe-types'

function makeRecipe(overrides: Partial<ParsedRecipe> = {}): ParsedRecipe {
  const artifact: ArtifactWithContent = {
    path: 'pages/Page.tsx',
    type: 'page',
    content: 'export default function Page() { return null }',
    sizeBytes: 50,
  }
  return {
    metadata: {
      recipeId: 'todo-manager',
      name: 'TODO Manager',
      description: 'Sample recipe for tests',
      version: '1.0.0',
      author: 'kovito-test',
    },
    artifacts: [artifact],
    menu: [
      {
        id: 'todo-manager',
        label: 'TODO',
        icon: 'sessions',
        page: 'pages/Page',
      },
    ],
    instruction: undefined,
    api: undefined,
    hash: 'sha256:abcdef',
    sourceFormat: 'directory',
    sourcePath: '/tmp/recipes/todo-manager',
    ...overrides,
  }
}

function makeInspection(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    verdict: 'safe',
    findings: [],
    pureDeclarative: true,
    detectedNonDeclarativePatterns: [],
    ...overrides,
  }
}

describe('buildRecipePrompt (v2.0)', () => {
  it('keeps the stable header anchor inside the v2.0 rule-line sentinel envelope', () => {
    // SS-3 / Q4 dual-write (v2.0): the prompt now opens with a
    // `━━━━━ KovitoBoard:recipe-install … ━━━━━` rule-line sentinel
    // so the sentinel-aware parser can chip-collapse it. Rule-line
    // markers carry no syntactic meaning in Markdown / programming
    // languages, leaving the model with no incentive to interpret
    // the inner identifier as a directive — see spec §2 v2.0. The
    // legacy header anchor stays inside the body so older renderers
    // (and replayed JSONLs from before the sentinel rollout) still
    // match their existing detection.
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    expect(prompt.startsWith('━━━━━ KovitoBoard:recipe-install')).toBe(true)
    expect(prompt.endsWith('━━━━━ KovitoBoard:end ━━━━━')).toBe(true)
    expect(prompt).toContain(RECIPE_INSTALL_HEADER)
    expect(RECIPE_INSTALL_HEADER).toBe('KovitoBoard Recipe Installation Request')
  })

  it('emits the five top-level sections in order', () => {
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    const order = [
      '## Recipe Information',
      '## Recipe Contents',
      '## Your Task (Agent)',
      '## Constraints (厳守)',
      '## 補足（レシピ作者からのメモ）',
    ]
    let cursor = 0
    for (const heading of order) {
      const idx = prompt.indexOf(heading, cursor)
      expect(idx, `heading ${heading} not found after position ${cursor}`).toBeGreaterThanOrEqual(0)
      cursor = idx + heading.length
    }
  })

  it('emits the 7-step playbook headings', () => {
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    const expectedSteps = [
      '### Step 1: 状況確認',
      '### Step 2: appId 採番',
      '### Step 3: scope 説明とユーザー承認',
      '### Step 4: artifacts 配置',
      '### Step 5: app/menu.ts への登録',
      '### Step 6: manifest 配置',
      '### Step 7: KB に完了報告',
    ]
    for (const step of expectedSteps) {
      expect(prompt).toContain(step)
    }
  })

  it('reflects pureDeclarative=true with no warning callout', () => {
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    expect(prompt).toContain('- pure declarative: yes')
    expect(prompt).toContain('- non-declarative patterns: なし')
    expect(prompt).not.toContain('declarative handler の枠を超える実装パターン')
  })

  it('reflects non-declarative patterns and surfaces a Step 3 callout', () => {
    const prompt = buildRecipePrompt(
      makeRecipe(),
      makeInspection({
        pureDeclarative: false,
        detectedNonDeclarativePatterns: ['express-router', 'direct-fetch'],
      }),
    )
    expect(prompt).toContain('- pure declarative: no')
    expect(prompt).toContain('- non-declarative patterns: express-router, direct-fetch')
    expect(prompt).toContain('declarative handler の枠を超える実装パターン')
    expect(prompt).toContain('express-router, direct-fetch')
  })

  it('embeds the recipeId in the mark-installed curl URL', () => {
    const prompt = buildRecipePrompt(
      makeRecipe({ metadata: { ...makeRecipe().metadata, recipeId: 'kovito-dev/document-viewer' } }),
      makeInspection(),
    )
    expect(prompt).toContain('/api/recipes/kovito-dev/document-viewer/mark-installed')
  })

  it('renders artifact content under app/<path> headings', () => {
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    expect(prompt).toContain('#### app/pages/Page.tsx')
    expect(prompt).toContain('export default function Page()')
  })

  it('renders the api section when present', () => {
    const prompt = buildRecipePrompt(
      makeRecipe({
        api: {
          scopes: ['project-read', 'own-data'],
          calls: [
            { id: 'list-todos', handler: 'list-files', args: { path: 'todo/' } },
          ],
        },
      }),
      makeInspection(),
    )
    expect(prompt).toContain('### api section (declarative handler)')
    expect(prompt).toContain('- project-read')
    expect(prompt).toContain('- own-data')
    expect(prompt).toContain('list-todos')
    expect(prompt).toContain('list-files')
  })

  it('falls back to "（未指定）" when author is missing', () => {
    const recipe = makeRecipe()
    const prompt = buildRecipePrompt(
      { ...recipe, metadata: { ...recipe.metadata, author: undefined } },
      makeInspection(),
    )
    expect(prompt).toContain('### author\n\n（未指定）')
  })

  it('blockquotes a sanitized author note in the 補足 section', () => {
    const prompt = buildRecipePrompt(
      makeRecipe({ instruction: 'Please be careful around documentation.\nThanks!' }),
      makeInspection(),
    )
    expect(prompt).toContain('## 補足（レシピ作者からのメモ）')
    expect(prompt).toContain('> Please be careful around documentation.')
    expect(prompt).toContain('> Thanks!')
  })

  it('emits "（補足なし）" placeholder when instruction is empty', () => {
    const prompt = buildRecipePrompt(
      makeRecipe({ instruction: undefined }),
      makeInspection(),
    )
    expect(prompt).toContain('> （補足なし）')
  })

  it('warns when the author note contained dangerous patterns', () => {
    const prompt = buildRecipePrompt(
      makeRecipe({ instruction: 'Use npm install lodash and call eval()' }),
      makeInspection(),
    )
    // sanitizeInstruction strips `npm install`; the prompt surfaces
    // the removal count under the contents > instruction section.
    expect(prompt).toContain('### instruction (sanitized)')
    expect(prompt).toMatch(/potentially unsafe pattern\(s\) were removed/)
  })
})

describe('buildRecipePrompt — reinstall detection (DEC-024 #4)', () => {
  // Minimal in-memory FileAccessLayer stub that satisfies the
  // surface `scanAppManifests` exercises (`existsSync`,
  // `readdirSync`, `readFileSync`). We don't pull in `fs-layer.ts`'s
  // real implementation because the test just needs to inject
  // pre-baked manifest contents.
  type FsStub = {
    files: Map<string, string>
    dirs: Map<string, string[]>
  }

  function makeFsStub(): { stub: FsStub; layer: Parameters<typeof buildRecipePrompt>[2] extends infer C ? C extends { fs: infer F } ? F : never : never } {
    const stub: FsStub = { files: new Map(), dirs: new Map() }
    const layer = {
      existsSync: (path: string) =>
        stub.files.has(path) || stub.dirs.has(path),
      readdirSync: (path: string) => stub.dirs.get(path) ?? [],
      readFileSync: (path: string, _enc: string) => {
        const v = stub.files.get(path)
        if (v === undefined) throw new Error(`ENOENT: ${path}`)
        return v
      },
    } as unknown as Parameters<typeof buildRecipePrompt>[2] extends infer C
      ? C extends { fs: infer F } ? F : never : never
    return { stub, layer }
  }

  function seedManifest(
    stub: FsStub,
    projectRoot: string,
    appId: string,
    manifestJson: object,
  ) {
    const dir = `${projectRoot}/app`
    const sub = `${dir}/${appId}`
    const manifestPath = `${sub}/manifest.json`
    stub.dirs.set(dir, [...(stub.dirs.get(dir) ?? []), appId])
    stub.dirs.set(sub, [])
    stub.files.set(manifestPath, JSON.stringify(manifestJson))
  }

  it('omits the reinstall section when no context is provided', () => {
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection())
    expect(prompt).not.toContain('## 再インストール検出')
  })

  it('omits the reinstall section when no app shares the recipeId', () => {
    const { stub, layer } = makeFsStub()
    const projectRoot = '/tmp/proj'
    seedManifest(stub, projectRoot, 'unrelated', {
      appId: 'unrelated',
      displayName: 'Unrelated',
      createdAt: '2026-04-01T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: {
        type: 'recipe',
        recipeId: 'other-recipe',
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
      },
    })
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection(), {
      fs: layer,
      projectRoot,
    })
    expect(prompt).not.toContain('## 再インストール検出')
  })

  it('lists each existing install with the same recipeId', () => {
    const { stub, layer } = makeFsStub()
    const projectRoot = '/tmp/proj'
    seedManifest(stub, projectRoot, 'todo-manager', {
      appId: 'todo-manager',
      displayName: 'TODO',
      createdAt: '2026-04-15T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: {
        type: 'recipe',
        recipeId: 'todo-manager',
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
      },
    })
    seedManifest(stub, projectRoot, 'todo-manager-2', {
      appId: 'todo-manager-2',
      displayName: 'TODO (Personal)',
      createdAt: '2026-04-20T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: {
        type: 'recipe',
        recipeId: 'todo-manager',
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
      },
    })

    const prompt = buildRecipePrompt(makeRecipe(), makeInspection(), {
      fs: layer,
      projectRoot,
    })
    expect(prompt).toContain('## 再インストール検出')
    expect(prompt).toContain('appId: `todo-manager`')
    expect(prompt).toContain('appId: `todo-manager-2`')
    expect(prompt).toContain('「TODO」')
    expect(prompt).toContain('「TODO (Personal)」')
    // The reinstall section sits between Recipe Contents and Your Task.
    const idxReinstall = prompt.indexOf('## 再インストール検出')
    const idxYourTask = prompt.indexOf('## Your Task (Agent)')
    const idxContents = prompt.indexOf('## Recipe Contents')
    expect(idxContents).toBeGreaterThan(0)
    expect(idxReinstall).toBeGreaterThan(idxContents)
    expect(idxYourTask).toBeGreaterThan(idxReinstall)
  })

  it('skips user-creation apps and apps with a different recipeId', () => {
    const { stub, layer } = makeFsStub()
    const projectRoot = '/tmp/proj'
    seedManifest(stub, projectRoot, 'notes', {
      appId: 'notes',
      displayName: 'Notes',
      createdAt: '2026-04-15T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: { type: 'user-creation', createdViaAgent: 'kovito-developer' },
    })
    seedManifest(stub, projectRoot, 'other-recipe', {
      appId: 'other-recipe',
      displayName: 'Other',
      createdAt: '2026-04-15T00:00:00.000Z',
      kovitoboardVersion: '0.1.0',
      source: {
        type: 'recipe',
        recipeId: 'something-else',
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
      },
    })
    const prompt = buildRecipePrompt(makeRecipe(), makeInspection(), {
      fs: layer,
      projectRoot,
    })
    expect(prompt).not.toContain('## 再インストール検出')
  })
})
