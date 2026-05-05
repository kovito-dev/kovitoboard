/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `buildAppRemovalPrompt` — the prompt builder for
 * the v0.1.0 app removal flow (DEC-024 #3).
 *
 * Pinned behavior:
 *   - Stable header: "KovitoBoard App Removal Request".
 *   - 5-step playbook headings present.
 *   - source-line reflects the manifest discriminant
 *     (recipe / user-creation / null = unknown).
 *   - Recipe-derived apps surface the "Step 4" callout about
 *     `recipes-installed/<appId>/` and `recipe-history.json`.
 *   - Non-recipe (user-creation / null) apps skip Step 4.
 *   - displayName is fenced so backticks / `${}` cannot break the
 *     surrounding markdown.
 *   - Invalid appIds throw early.
 *
 * @see docs/specs/v0.1.0-app-removal-flow.md §5
 */
import { describe, expect, it } from 'vitest'
import { buildAppRemovalPrompt } from '../../src/shared/app-removal-prompt'
import type { AppManifest } from '../../src/shared/app-manifest-types'

function recipeManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    appId: 'document-viewer',
    displayName: 'Documents',
    createdAt: '2026-04-15T00:00:00.000Z',
    kovitoboardVersion: '0.1.0',
    source: {
      type: 'recipe',
      recipeId: 'document-viewer',
      recipeVersion: '1.1.0',
      recipeSource: 'sample',
    },
    ...overrides,
  }
}

function userManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    appId: 'notes',
    displayName: 'Notes',
    createdAt: '2026-04-20T00:00:00.000Z',
    kovitoboardVersion: '0.1.0',
    source: { type: 'user-creation', createdViaAgent: 'kovito-developer' },
    ...overrides,
  }
}

describe('buildAppRemovalPrompt', () => {
  it('opens with the stable header', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'notes',
      displayName: 'Notes',
      manifest: userManifest(),
    })
    expect(prompt.startsWith('KovitoBoard App Removal Request')).toBe(true)
  })

  it('emits the 5-step playbook headings in order', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'notes',
      displayName: 'Notes',
      manifest: userManifest(),
    })
    const expected = [
      '## 削除対象',
      '## あなた（エージェント）への依頼',
      '### Step 1: 状況確認',
      '### Step 2: 削除作業',
      '### Step 3: 触ってはいけないもの',
      '### Step 5: 完了報告',
    ]
    let cursor = 0
    for (const heading of expected) {
      const idx = prompt.indexOf(heading, cursor)
      expect(idx, `heading ${heading} not found after position ${cursor}`).toBeGreaterThanOrEqual(0)
      cursor = idx + heading.length
    }
  })

  it('shows recipe lineage and Step 4 callout for recipe-derived apps', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'document-viewer',
      displayName: 'Documents',
      manifest: recipeManifest(),
    })
    expect(prompt).toContain('レシピ「document-viewer」（v1.1.0、sample）')
    expect(prompt).toContain('### Step 4: レシピ由来アプリの注意')
    expect(prompt).toContain('recipes-installed/document-viewer/')
    expect(prompt).toContain('recipe-history.json')
    expect(prompt).toContain('再インストール』ボタンから可能')
  })

  it('skips Step 4 for user-creation apps', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'notes',
      displayName: 'Notes',
      manifest: userManifest(),
    })
    expect(prompt).toContain('独自作成（kovito-developer エージェントが作成）')
    expect(prompt).not.toContain('### Step 4: レシピ由来アプリの注意')
  })

  it('reports unknown source when manifest is null', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'legacy-app',
      displayName: 'Legacy',
      manifest: null,
    })
    expect(prompt).toContain('由来: 不明')
    expect(prompt).not.toContain('### Step 4: レシピ由来アプリの注意')
  })

  it('embeds the appId in shell snippets and references', () => {
    const prompt = buildAppRemovalPrompt({
      appId: 'notes',
      displayName: 'Notes',
      manifest: userManifest(),
    })
    expect(prompt).toContain('rm -rf app/notes/')
    expect(prompt).toContain('rm -rf app/data/notes/')
    expect(prompt).toContain('app/menu.ts')
    expect(prompt).toContain("id: 'notes'")
  })

  it('fences displayName so embedded backticks do not break markdown', () => {
    const trickyName = 'Notes ``` ${process.env.HOME}'
    const prompt = buildAppRemovalPrompt({
      appId: 'notes',
      displayName: trickyName,
      manifest: userManifest(),
    })
    // The fence must use 4 backticks (3 inside the name + 1 to escape).
    expect(prompt).toContain('````\nNotes ``` ${process.env.HOME}\n````')
  })

  it('throws when the appId violates the slug pattern', () => {
    expect(() =>
      buildAppRemovalPrompt({
        appId: 'Capitalized',
        displayName: 'Bad',
        manifest: null,
      }),
    ).toThrow(/Invalid appId/)
    expect(() =>
      buildAppRemovalPrompt({
        appId: '',
        displayName: 'Bad',
        manifest: null,
      }),
    ).toThrow(/Invalid appId/)
    expect(() =>
      buildAppRemovalPrompt({
        appId: 'with spaces',
        displayName: 'Bad',
        manifest: null,
      }),
    ).toThrow(/Invalid appId/)
  })
})
