/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `scanAppDirectory(fs, appId)` after the
 * v0.1.0-recipe-export-rework changes (DEC-024 #5):
 *
 *   - Scope is `app/<appId>/`, not the whole `app/` tree.
 *   - `app/<appId>/api/*.ts` is part of the artifacts (was excluded).
 *   - Artifact paths are relative to `app/<appId>/` (no `<appId>/`
 *     prefix in the recipe).
 *   - `parseMenuTsForApp` filters menu rows so only the focused app's
 *     entries land in the recipe.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import type { FileStat } from '../../src/server/fs-layer'
import { scanAppDirectory, inferArtifactType } from '../../src/server/recipe-exporter'
import { parseMenuTsForApp } from '../../src/server/services/menu-extractor'

/**
 * Tiny in-memory FileAccessLayer for the exporter tests. Only
 * implements the methods the exporter touches; everything else throws
 * so an accidental new dependency surfaces immediately.
 */
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
    readFileSync: ((path: string, _encoding?: string) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }) as FileAccessLayer['readFileSync'],
    statSync: (path: string): FileStat => {
      const content = files[path]
      if (content === undefined) {
        if (dirs.has(path)) return { size: 0, mtime: new Date(0), mtimeMs: 0 }
        throw new Error(`ENOENT: ${path}`)
      }
      return { size: Buffer.byteLength(content, 'utf-8'), mtime: new Date(0), mtimeMs: 0 }
    },
    writeFileSync: () => {},
    unlinkSync: () => {},
    readBytesSync: () => Buffer.alloc(0),
    mkdirSync: () => {},
    watch: () => ({ close: () => {} }),
    realpathSync: (path: string) => path,
    // No symlinks in this in-memory layout; report every entry as a
    // regular file so the per-entry symlink defence in `scanDir`
    // never fires here.
    lstatSync: () => ({
      size: 0,
      mtime: new Date(0),
      mtimeMs: 0,
      isSymbolicLink: false,
      isFile: true,
    }),
    chmodSync: () => {},
    rmSync: () => {},
    renameSync: () => {},
    copyFileSync: () => {},
    appendFileSync: () => {},
    utimesSync: () => {},
    accessSync: () => {},
    createReadStream: () => {
      throw new Error('not implemented in test fs')
    },
    createWriteStream: () => {
      throw new Error('not implemented in test fs')
    },
  } as unknown as FileAccessLayer
}

const PROJECT_ROOT = '/proj'

beforeEach(() => {
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})

describe('inferArtifactType (DEC-024 #5)', () => {
  it('classifies `api/` paths as `lib`', () => {
    expect(inferArtifactType('api/list-files.ts')).toBe('lib')
  })
  it('keeps the existing buckets', () => {
    expect(inferArtifactType('pages/Foo.tsx')).toBe('page')
    expect(inferArtifactType('styles/main.css')).toBe('style')
    expect(inferArtifactType('hooks/useFoo.ts')).toBe('hook')
    expect(inferArtifactType('utils/helpers.ts')).toBe('util')
    expect(inferArtifactType('lib/whatever.ts')).toBe('lib')
    expect(inferArtifactType('something.else')).toBe('lib') // fallback
  })
})

describe('scanAppDirectory(fs, appId)', () => {
  it('scopes to app/<appId>/ and ignores siblings', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/menu.ts`]: '',
      [`${PROJECT_ROOT}/app/foo/pages/FooPage.tsx`]: 'export {}',
      [`${PROJECT_ROOT}/app/bar/pages/BarPage.tsx`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.artifacts.map((a) => a.path)).toEqual(['pages/FooPage.tsx'])
  })

  it('routes api/*.ts into customBeFiles instead of artifacts (recipe safety boundary)', () => {
    // Recipe install rejects `api/`-prefixed artifacts at the
    // path-prefix step, so packaging them into a recipe was always
    // unsound. Backend handlers are now collected into a separate
    // bucket so the export route can refuse them with a guidance
    // message instead of pretending to ship them.
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/FooPage.tsx`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/api/handler.ts`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    const artifactPaths = result.artifacts.map((a) => a.path).sort()
    expect(artifactPaths).toEqual(['pages/FooPage.tsx'])
    const beRelativePaths = result.customBeFiles.map((f) => f.relativePath).sort()
    expect(beRelativePaths).toEqual(['api/handler.ts'])
  })

  it('strips the appId prefix from artifact paths', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/my-app/pages/Foo.tsx`]: 'x',
      [`${PROJECT_ROOT}/app/my-app/api/list.ts`]: 'x',
      [`${PROJECT_ROOT}/app/my-app/styles/foo.css`]: 'x',
    })
    const result = scanAppDirectory(fs, 'my-app')
    for (const a of result.artifacts) {
      expect(a.path.startsWith('my-app/'), `path "${a.path}" still has appId prefix`).toBe(false)
    }
  })

  it('skips dotfiles and node_modules', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/.DS_Store`]: 'junk',
      [`${PROJECT_ROOT}/app/foo/node_modules/some-pkg/index.js`]: 'junk',
    })
    const result = scanAppDirectory(fs, 'foo')
    const paths = result.artifacts.map((a) => a.path)
    expect(paths).toEqual(['pages/Foo.tsx'])
  })

  it('returns empty artifacts when the app directory does not exist', () => {
    const fs = makeFs({})
    const result = scanAppDirectory(fs, 'missing-app')
    expect(result).toEqual({
      artifacts: [],
      menu: [],
      totalSize: 0,
      customBeFiles: [],
      customBeFilesCount: 0,
      customBeFilesCountApproximate: false,
    })
  })

  it('reports cumulative size in bytes', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/A.tsx`]: 'a'.repeat(10),
      [`${PROJECT_ROOT}/app/foo/pages/B.tsx`]: 'b'.repeat(20),
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.totalSize).toBe(30)
  })

  it('reads only the menu rows whose id matches appId', () => {
    const menuTs = [
      "import type { AppMenuEntry } from '../src/renderer/types/app-types'",
      '',
      'export const menuEntries: AppMenuEntry[] = [',
      "  { id: 'foo', label: 'Foo', icon: 'sparkle', component: () => import('./foo/pages/FooPage') },",
      "  { id: 'bar', label: 'Bar', icon: 'note', component: () => import('./bar/pages/BarPage') },",
      ']',
      '',
    ].join('\n')
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/menu.ts`]: menuTs,
      [`${PROJECT_ROOT}/app/foo/pages/FooPage.tsx`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.menu).toEqual([
      { id: 'foo', label: 'Foo', icon: 'sparkle', page: 'foo/pages/FooPage' },
    ])
  })

  it('returns no menu rows when menu.ts has no matching entry', () => {
    const menuTs = [
      'export const menuEntries: AppMenuEntry[] = [',
      "  { id: 'other', label: 'Other', icon: 'x', component: () => import('./other/pages/OtherPage') },",
      ']',
      '',
    ].join('\n')
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/menu.ts`]: menuTs,
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'x',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.menu).toEqual([])
  })
})

describe('parseMenuTsForApp', () => {
  it('returns only entries whose id matches', () => {
    const content = [
      "  { id: 'foo', label: 'Foo', icon: 'sparkle', component: () => import('./foo/pages/FooPage') },",
      "  { id: 'bar', label: 'Bar', icon: 'note', component: () => import('./bar/pages/BarPage') },",
    ].join('\n')
    expect(parseMenuTsForApp(content, 'bar')).toEqual([
      { id: 'bar', label: 'Bar', icon: 'note', page: 'bar/pages/BarPage', pageAbsolutePath: null },
    ])
  })

  it('returns an empty array when no entry matches', () => {
    const content = "  { id: 'foo', label: 'Foo', icon: 'sparkle', component: () => import('./foo/pages/FooPage') },"
    expect(parseMenuTsForApp(content, 'missing')).toEqual([])
  })

  it('returns an empty array on an empty file', () => {
    expect(parseMenuTsForApp('', 'foo')).toEqual([])
  })
})
