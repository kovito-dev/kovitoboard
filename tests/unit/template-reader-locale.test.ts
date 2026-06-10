/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for locale resolution in `listAgentTemplates`
 * (companion to the agent-template list locale support in
 * `src/server/template-reader.ts`).
 *
 * The list endpoint must resolve `name` / `description` per locale so the
 * agent-create template picker matches the create path:
 *
 * 1. locale 'ja' (default) reads `{id}.md` frontmatter.
 * 2. locale 'en' reads `{id}.en.md` frontmatter when present.
 * 3. locale 'en' falls back to `{id}.md` when `{id}.en.md` is absent.
 * 4. `id` / `model` always come from `{id}.md` (locale-independent SSOT).
 *
 * The directory is resolved by `getTemplatesDir`, which probes the
 * `templates/agents` candidate paths with `existsSync`; the in-memory
 * layer below answers for any path ending in `templates/agents`.
 */
import { describe, expect, it } from 'vitest'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import { listAgentTemplates } from '../../src/server/template-reader'

const TEMPLATES_DIR_SUFFIX = 'templates/agents'

function makeFs(filesByName: Record<string, string>): FileAccessLayer {
  const isTemplatesDir = (path: string) => path.endsWith(TEMPLATES_DIR_SUFFIX)
  const fileName = (path: string) => path.split('/').pop() ?? ''

  return {
    existsSync: (path: string) =>
      isTemplatesDir(path) || fileName(path) in filesByName,
    readdirSync: (path: string) => {
      if (!isTemplatesDir(path)) throw new Error(`ENOTDIR: ${path}`)
      return Object.keys(filesByName)
    },
    readFileSync: ((path: string) => {
      const v = filesByName[fileName(path)]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    }) as FileAccessLayer['readFileSync'],
  } as unknown as FileAccessLayer
}

const jaMd = (id: string, description: string, model = 'sonnet') =>
  `---\nname: ${id}\ndescription: ${description}\nmodel: ${model}\n---\nbody\n`

const enMd = (id: string, description: string) =>
  `---\nname: ${id}\ndescription: ${description}\nmodel: ignored-in-en\n---\nbody\n`

describe('listAgentTemplates locale resolution', () => {
  it('defaults to ja frontmatter when locale is omitted', () => {
    const fs = makeFs({
      'alpha.md': jaMd('alpha', 'ja-desc'),
      'alpha.en.md': enMd('alpha', 'en-desc'),
    })
    const [tpl] = listAgentTemplates(fs)
    expect(tpl.id).toBe('alpha')
    expect(tpl.description).toBe('ja-desc')
    expect(tpl.model).toBe('sonnet')
  })

  it("reads ja frontmatter for locale 'ja'", () => {
    const fs = makeFs({
      'alpha.md': jaMd('alpha', 'ja-desc'),
      'alpha.en.md': enMd('alpha', 'en-desc'),
    })
    const [tpl] = listAgentTemplates(fs, 'ja')
    expect(tpl.description).toBe('ja-desc')
  })

  it("prefers .en.md frontmatter for locale 'en'", () => {
    const fs = makeFs({
      'alpha.md': jaMd('alpha', 'ja-desc'),
      'alpha.en.md': enMd('alpha', 'en-desc'),
    })
    const [tpl] = listAgentTemplates(fs, 'en')
    expect(tpl.description).toBe('en-desc')
    // id / model stay sourced from {id}.md (locale-independent SSOT).
    expect(tpl.id).toBe('alpha')
    expect(tpl.model).toBe('sonnet')
  })

  it("falls back to .md when .en.md is absent for locale 'en'", () => {
    const fs = makeFs({
      'alpha.md': jaMd('alpha', 'ja-desc'),
      // no alpha.en.md
    })
    const [tpl] = listAgentTemplates(fs, 'en')
    expect(tpl.description).toBe('ja-desc')
    expect(tpl.model).toBe('sonnet')
  })

  it('does not enumerate .en.md files as separate entries', () => {
    const fs = makeFs({
      'alpha.md': jaMd('alpha', 'ja-desc'),
      'alpha.en.md': enMd('alpha', 'en-desc'),
    })
    const templates = listAgentTemplates(fs, 'en')
    expect(templates.map(t => t.id)).toEqual(['alpha'])
  })
})
