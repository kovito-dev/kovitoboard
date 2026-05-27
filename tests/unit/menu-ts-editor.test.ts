/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `menu-ts-editor` module.
 *
 * The editor is the surgical-edit path used by `/api/recipes/uninstall`
 * to drop a single entry from `app/menu.ts`. These tests exercise:
 *   - Removing one entry from the canonical recipe-applicator template
 *     shape (multiple-entry array, single-entry array, leading entry,
 *     trailing entry, middle entry).
 *   - Tolerance for whitespace / quote-style variation that hand
 *     edits might introduce.
 *   - "Not found" returns when the entry id is absent.
 *   - "Parse failed" returns when the file does not declare
 *     `menuEntries` at all.
 *   - Round-trip soundness: the rewritten file still parses with
 *     `menu-extractor.parseMenuTs`.
 */
import { describe, expect, it } from 'vitest'
import {
  appendMenuEntry,
  buildEmptyMenuTs,
  MenuTsParseFailedError,
  removeMenuEntry,
} from '../../src/server/services/menu-ts-editor'
import { parseMenuTs } from '../../src/server/services/menu-extractor'

const HEAD = `import type { AppMenuEntry } from '../src/renderer/types/app-types'\n\n`

function buildMenuTs(entries: Array<{ id: string; label: string; icon: string; page: string }>): string {
  const items = entries
    .map(
      (e) =>
        `  {\n    id: '${e.id}',\n    label: '${e.label}',\n    icon: '${e.icon}',\n    component: () => import('./${e.page}'),\n  }`,
    )
    .join(',\n')
  return `${HEAD}export const menuEntries: AppMenuEntry[] = [\n${items},\n]\n`
}

describe('removeMenuEntry', () => {
  it('removes the only entry and leaves an empty array', () => {
    const src = buildMenuTs([{ id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' }])
    const result = removeMenuEntry(src, 'todo')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      expect(parseMenuTs(result.content)).toEqual([])
      // The empty body should not leave any stray "{}" or comma.
      expect(result.content).toMatch(/menuEntries:\s*AppMenuEntry\[\]\s*=\s*\[\s*\]/)
    }
  })

  it('removes the leading entry of a 3-entry array', () => {
    const src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' },
      { id: 'doc', label: 'Docs', icon: 'content', page: 'pages/DocViewer' },
      { id: 'rr', label: 'RR', icon: 'content', page: 'pages/ResearchReports' },
    ])
    const result = removeMenuEntry(src, 'todo')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      const parsed = parseMenuTs(result.content)
      expect(parsed.map((e) => e.id)).toEqual(['doc', 'rr'])
    }
  })

  it('removes a middle entry without disturbing the others', () => {
    const src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' },
      { id: 'doc', label: 'Docs', icon: 'content', page: 'pages/DocViewer' },
      { id: 'rr', label: 'RR', icon: 'content', page: 'pages/ResearchReports' },
    ])
    const result = removeMenuEntry(src, 'doc')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      const parsed = parseMenuTs(result.content)
      expect(parsed.map((e) => e.id)).toEqual(['todo', 'rr'])
    }
  })

  it('removes the trailing entry without leaving a dangling comma', () => {
    const src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' },
      { id: 'doc', label: 'Docs', icon: 'content', page: 'pages/DocViewer' },
    ])
    const result = removeMenuEntry(src, 'doc')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      const parsed = parseMenuTs(result.content)
      expect(parsed.map((e) => e.id)).toEqual(['todo'])
      // The result must not contain ",,".
      expect(result.content).not.toContain(',,')
    }
  })

  it('returns not-found when the entry id is absent', () => {
    const src = buildMenuTs([{ id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' }])
    const result = removeMenuEntry(src, 'ghost-recipe')
    expect(result).toEqual({ kind: 'not-found' })
  })

  it('returns parse-failed when the file lacks a menuEntries declaration', () => {
    const result = removeMenuEntry('// menu.ts that someone hand-edited into rubble\n', 'todo')
    expect(result.kind).toBe('parse-failed')
    if (result.kind === 'parse-failed') {
      expect(result.reason).toMatch(/menuEntries/)
    }
  })

  it('tolerates double-quoted ids', () => {
    const src = `${HEAD}export const menuEntries: AppMenuEntry[] = [\n  {\n    id: "todo",\n    label: "TODO",\n    icon: "content",\n    component: () => import("./pages/TodoPage"),\n  },\n]\n`
    const result = removeMenuEntry(src, 'todo')
    expect(result.kind).toBe('removed')
  })

  it('tolerates non-canonical indentation', () => {
    const src = `${HEAD}export const menuEntries: AppMenuEntry[] = [\n{ id: 'todo', label: 'TODO', icon: 'content', component: () => import('./pages/TodoPage') }\n]\n`
    const result = removeMenuEntry(src, 'todo')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      expect(parseMenuTs(result.content)).toEqual([])
    }
  })

  it('survives a recursive call that removes two entries one after the other', () => {
    let src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'pages/TodoPage' },
      { id: 'doc', label: 'Docs', icon: 'content', page: 'pages/DocViewer' },
      { id: 'rr', label: 'RR', icon: 'content', page: 'pages/ResearchReports' },
    ])
    const r1 = removeMenuEntry(src, 'todo')
    expect(r1.kind).toBe('removed')
    if (r1.kind !== 'removed') return
    src = r1.content
    const r2 = removeMenuEntry(src, 'rr')
    expect(r2.kind).toBe('removed')
    if (r2.kind !== 'removed') return
    expect(parseMenuTs(r2.content).map((e) => e.id)).toEqual(['doc'])
  })

  it('tolerates entries laid out on a single line', () => {
    const src = `${HEAD}export const menuEntries: AppMenuEntry[] = [{ id: 'todo', label: 'TODO', icon: 'content', component: () => import('./pages/TodoPage') }, { id: 'doc', label: 'Docs', icon: 'content', component: () => import('./pages/DocViewer') }]\n`
    const result = removeMenuEntry(src, 'todo')
    expect(result.kind).toBe('removed')
    if (result.kind === 'removed') {
      expect(parseMenuTs(result.content).map((e) => e.id)).toEqual(['doc'])
    }
  })
})

describe('buildEmptyMenuTs', () => {
  it('produces a parseable empty menu.ts', () => {
    const src = buildEmptyMenuTs()
    expect(parseMenuTs(src)).toEqual([])
    expect(src).toContain("import type { AppMenuEntry } from '../src/renderer/types/app-types'")
    expect(src).toContain('export const menuEntries: AppMenuEntry[] = []')
  })
})

// =========================================
// Phase 1.5 — appendMenuEntry (v1.12 BL-2026-179)
// =========================================

describe('appendMenuEntry', () => {
  it('appends a single entry to an empty menu.ts and round-trips through parseMenuTs', () => {
    const src = buildEmptyMenuTs()
    const result = appendMenuEntry(src, {
      id: 'document-viewer',
      label: 'ドキュメント',
      icon: 'content',
      page: 'document-viewer/pages/DocumentViewer',
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    const parsed = parseMenuTs(result.content)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('document-viewer')
    expect(parsed[0].label).toBe('ドキュメント')
    expect(parsed[0].icon).toBe('content')
    expect(parsed[0].page).toBe('document-viewer/pages/DocumentViewer')
  })

  it('appends a second entry without disturbing the first', () => {
    const src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'todo/pages/TodoPage' },
    ])
    const result = appendMenuEntry(src, {
      id: 'document-viewer',
      label: 'Docs',
      icon: 'content',
      page: 'document-viewer/pages/DocumentViewer',
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    const parsed = parseMenuTs(result.content)
    expect(parsed.map((e) => e.id)).toEqual(['todo', 'document-viewer'])
  })

  it('returns already-present when the appId entry exists (idempotent no-op, BS-L2)', () => {
    const src = buildMenuTs([
      { id: 'todo', label: 'TODO', icon: 'content', page: 'todo/pages/TodoPage' },
      { id: 'document-viewer', label: 'Docs', icon: 'content', page: 'document-viewer/pages/DocumentViewer' },
    ])
    const result = appendMenuEntry(src, {
      id: 'document-viewer',
      label: 'Different Label',
      icon: 'box',
      page: 'document-viewer/pages/Other',
    })
    expect(result).toEqual({ kind: 'already-present' })
  })

  it('throws MenuTsParseFailedError when the menuEntries array is missing', () => {
    expect(() =>
      appendMenuEntry('// menu.ts mauled by a hand edit\n', {
        id: 'document-viewer',
        label: 'Docs',
        icon: 'content',
        page: 'document-viewer/pages/DocumentViewer',
      }),
    ).toThrow(MenuTsParseFailedError)
  })

  it('escapes single quotes / backslashes in label so the output is a valid TypeScript string literal', () => {
    // `parseMenuTs` uses a permissive regex that only matches simple
    // `[^'"]+` literals (it does not handle escaped quotes), so we
    // verify the escape contract at the source-string level instead
    // of round-tripping through the parser. The bundled samples
    // (`document-viewer` / `todo`) do not declare labels with quotes
    // in their recipe.yaml, so the regex's limit is not a problem in
    // practice — but `appendMenuEntry` still has to emit a well-
    // formed TypeScript source for the rare hand-edited / imported
    // case where a label does contain an apostrophe.
    const src = buildEmptyMenuTs()
    const result = appendMenuEntry(src, {
      id: 'document-viewer',
      label: "Doc's",
      icon: 'content',
      page: 'document-viewer/pages/DocumentViewer',
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    // The emitted source must contain the escaped form so the TS
    // module loader parses it as a single-quoted literal containing
    // an apostrophe rather than as a syntax error.
    expect(result.content).toContain(`label: 'Doc\\'s'`)
    // A trailing backslash inside the label must double up so the
    // surrounding single quote does not get escaped accidentally.
    const second = appendMenuEntry(result.content, {
      id: 'with-backslash',
      label: 'ends-with-\\',
      icon: 'box',
      page: 'with-backslash/Index',
    })
    expect(second.kind).toBe('appended')
    if (second.kind !== 'appended') return
    expect(second.content).toContain(`label: 'ends-with-\\\\'`)
  })

  it('tolerates a single-line `[ {...}, {...} ]` body and appends without breaking it', () => {
    const src = `${HEAD}export const menuEntries: AppMenuEntry[] = [{ id: 'todo', label: 'TODO', icon: 'content', component: () => import('./todo/pages/TodoPage') }]\n`
    const result = appendMenuEntry(src, {
      id: 'document-viewer',
      label: 'Docs',
      icon: 'content',
      page: 'document-viewer/pages/DocumentViewer',
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    const parsed = parseMenuTs(result.content)
    expect(parsed.map((e) => e.id)).toEqual(['todo', 'document-viewer'])
  })
})
