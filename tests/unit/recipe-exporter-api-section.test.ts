/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `api:` section emission in `exportAsMarkdown`.
 *
 * Since the post-rework follow-up (2026-05-04) the exporter only
 * produces the Markdown form — `exportAsDirectory` and
 * `buildRecipeYaml` were removed because the API route now streams
 * the document as a download response instead of writing to a host
 * path. These tests assert the api block layout that the recipe
 * consumer parses out of the YAML frontmatter.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { FileAccessLayer, FileStat } from '../../src/server/fs-layer'
import { exportAsMarkdown } from '../../src/server/recipe-exporter'
import type { RecipeApiSection } from '../../src/shared/recipe-types'

const PROJECT_ROOT = '/proj'

beforeEach(() => {
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})

function makeFs(files: Record<string, string>): {
  fs: FileAccessLayer
  written: Record<string, string>
} {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  const written: Record<string, string> = {}
  return {
    written,
    fs: {
      existsSync: (path: string) => path in files || dirs.has(path) || path in written,
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
      readFileSync: ((path: string, _enc?: string) => {
        const v = files[path]
        if (v === undefined) throw new Error(`ENOENT: ${path}`)
        return v
      }) as FileAccessLayer['readFileSync'],
      statSync: (path: string): FileStat => {
        const v = files[path]
        if (v === undefined && !dirs.has(path)) throw new Error(`ENOENT: ${path}`)
        return { size: v ? Buffer.byteLength(v, 'utf-8') : 0, mtime: new Date(0), mtimeMs: 0 }
      },
      writeFileSync: ((path: string, content: string) => {
        written[path] = content
      }) as FileAccessLayer['writeFileSync'],
      readBytesSync: () => Buffer.alloc(0),
      unlinkSync: () => {},
      mkdirSync: () => {},
      // Identity realpath: no symlinks in this in-memory layout, so
      // the canonical form equals the input. `scanAppDirectory` calls
      // `realpathSync` on `app/` and `app/<appId>/` for its symlink
      // escape check; both must resolve here so the check passes.
      realpathSync: (path: string) => path,
      // Per-entry symlink defence in `scanDir` calls `lstatSync` on
      // every walked entry; report regular-file metadata so the
      // guard never fires for this in-memory layout.
      lstatSync: () => ({
        size: 0,
        mtime: new Date(0),
        mtimeMs: 0,
        isSymbolicLink: false,
        isFile: true,
        nlink: 1,
      }),
      watch: () => ({ close: () => {} }),
    } as unknown as FileAccessLayer,
  }
}

describe('exportAsMarkdown: api section', () => {
  const baseMetadata = {
    recipeId: 'my-app',
    name: 'My App',
    description: 'desc',
    version: '1.0.0',
  }

  it('writes the api block when an ApiSection is provided (manifest-installed app)', () => {
    const { fs } = makeFs({
      [`${PROJECT_ROOT}/app/my-app/pages/Foo.tsx`]: 'export {}',
    })
    const api: RecipeApiSection = {
      scopes: ['project-read', 'own-data'],
      calls: [
        { id: 'list-docs', handler: 'list-files', args: { path: 'docs/' } },
        { id: 'read-doc', handler: 'read-file', args: { path: '${input.path}' } },
      ],
    }
    const md = exportAsMarkdown(
      fs,
      'my-app',
      { artifacts: [{ path: 'pages/Foo.tsx', type: 'page', sizeBytes: 9 }], menu: [], totalSize: 9 },
      baseMetadata,
      api,
    )
    expect(md).toContain('api:')
    expect(md).toContain('  scopes:')
    expect(md).toContain('    - project-read')
    expect(md).toContain('    - own-data')
    expect(md).toContain('  calls:')
    expect(md).toContain('    - id: "list-docs"')
    expect(md).toContain('      handler: "list-files"')
    expect(md).toContain('      args:')
    expect(md).toContain('        path: "docs/"')
    expect(md).toContain('    - id: "read-doc"')
    // Template placeholders in args must survive YAML quoting so install
    // can substitute them at runtime — we expect JSON.stringify quoting.
    expect(md).toContain('"${input.path}"')
  })

  it('omits the api section entirely when api is null (user-authored app)', () => {
    const { fs } = makeFs({
      [`${PROJECT_ROOT}/app/my-app/pages/Foo.tsx`]: 'export {}',
    })
    const md = exportAsMarkdown(
      fs,
      'my-app',
      { artifacts: [{ path: 'pages/Foo.tsx', type: 'page', sizeBytes: 9 }], menu: [], totalSize: 9 },
      baseMetadata,
      null,
    )
    // Only the body header `# My App` remains; no `api:` line should appear
    expect(md).not.toContain('\napi:\n')
    expect(md).not.toContain('  scopes:')
  })

  it('handles a calls entry without args by skipping the args block', () => {
    const { fs } = makeFs({
      [`${PROJECT_ROOT}/app/my-app/pages/Foo.tsx`]: 'export {}',
    })
    const api: RecipeApiSection = {
      scopes: ['project-read'],
      calls: [{ id: 'no-arg-call', handler: 'list-files' }],
    }
    const md = exportAsMarkdown(
      fs,
      'my-app',
      { artifacts: [{ path: 'pages/Foo.tsx', type: 'page', sizeBytes: 9 }], menu: [], totalSize: 9 },
      baseMetadata,
      api,
    )
    expect(md).toContain('    - id: "no-arg-call"')
    expect(md).toContain('      handler: "list-files"')
    expect(md).not.toContain('      args:')
  })

  it('writes recipeId before name in the YAML frontmatter', () => {
    const { fs } = makeFs({
      [`${PROJECT_ROOT}/app/my-app/pages/Foo.tsx`]: 'export {}',
    })
    const md = exportAsMarkdown(
      fs,
      'my-app',
      { artifacts: [{ path: 'pages/Foo.tsx', type: 'page', sizeBytes: 9 }], menu: [], totalSize: 9 },
      baseMetadata,
      null,
    )
    // Locate the first occurrence of the two lines and assert order.
    const idIdx = md.indexOf('recipeId: "my-app"')
    const nameIdx = md.indexOf('name: "My App"')
    expect(idIdx).toBeGreaterThanOrEqual(0)
    expect(nameIdx).toBeGreaterThanOrEqual(0)
    expect(idIdx).toBeLessThan(nameIdx)
  })
})
