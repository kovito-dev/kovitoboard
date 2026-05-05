/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `recipeId` requirement enforcement in
 * `recipe-exporter.ts`.
 *
 * The exporter throws when `metadata.recipeId` is missing. The API
 * route also validates the format (`/^[A-Za-z0-9_\-./@]+$/`, 1–256
 * chars) before reaching the exporter; these tests verify the
 * exporter's own guard so a future caller that bypasses the API
 * still hits a hard fail.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { FileAccessLayer, FileStat } from '../../src/server/fs-layer'
import { exportAsMarkdown } from '../../src/server/recipe-exporter'

const PROJECT_ROOT = '/proj'

beforeEach(() => {
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})

function makeFs(files: Record<string, string>): FileAccessLayer {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  return {
    existsSync: (path: string) => path in files || dirs.has(path),
    readdirSync: (path: string) => {
      if (!dirs.has(path)) throw new Error(`ENOTDIR: ${path}`)
      const direct = new Set<string>()
      const prefix = path === '' ? '' : `${path}/`
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) direct.add(head)
      }
      return Array.from(direct)
    },
    readFileSync: ((path: string, _e?: string) => {
      const v = files[path]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    }) as FileAccessLayer['readFileSync'],
    statSync: (path: string): FileStat => {
      const v = files[path]
      if (v === undefined && !dirs.has(path)) throw new Error(`ENOENT: ${path}`)
      return { size: v ? Buffer.byteLength(v, 'utf-8') : 0, mtime: new Date(0), mtimeMs: 0 }
    },
    writeFileSync: () => {},
    readBytesSync: () => Buffer.alloc(0),
    unlinkSync: () => {},
    mkdirSync: () => {},
    watch: () => ({ close: () => {} }),
  } as unknown as FileAccessLayer
}

describe('recipe exporter — recipeId requirement', () => {
  const fs = makeFs({
    [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
  })
  const scan = {
    artifacts: [{ path: 'pages/Foo.tsx', type: 'page' as const, sizeBytes: 9 }],
    menu: [],
    totalSize: 9,
  }

  it('throws when recipeId is an empty string', () => {
    expect(() =>
      exportAsMarkdown(
        fs,
        'foo',
        scan,
        { recipeId: '', name: 'F', description: 'd', version: '1.0.0' },
        null,
      ),
    ).toThrow(/recipeId is required/)
  })

  it('writes recipeId verbatim when present', () => {
    const md = exportAsMarkdown(
      fs,
      'foo',
      scan,
      { recipeId: 'kovito-dev/foo@1.2.3', name: 'F', description: 'd', version: '1.2.3' },
      null,
    )
    expect(md).toContain('recipeId: "kovito-dev/foo@1.2.3"')
  })

  it('escapes backslash and double-quote characters in recipeId', () => {
    // `recipeId` characters are constrained by the API regex, but the
    // exporter should still escape defensively in case a future caller
    // bypasses validation and feeds us a string with quotes.
    const md = exportAsMarkdown(
      fs,
      'foo',
      scan,
      { recipeId: 'with "quote" \\and\\ slash', name: 'F', description: 'd', version: '1.0.0' },
      null,
    )
    expect(md).toContain('recipeId: "with \\"quote\\" \\\\and\\\\ slash"')
  })
})
