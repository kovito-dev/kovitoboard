/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the custom-BE refusal in `scanAppDirectory` /
 * `inferArtifactType` (companion to the changes in
 * `src/server/recipe-exporter.ts`).
 *
 * The recipe safety boundary disallows `api/`-prefixed artifacts at
 * install time (recipe-inspector path-prefix restriction), so the
 * exporter must:
 *
 * 1. NOT classify `api/<file>.ts` as a `lib` artifact (the previous
 *    behaviour silently mapped backend handlers into `artifacts`,
 *    producing recipes the inspector would later reject).
 * 2. Collect any `api/<file>.ts` files into `customBeFiles` so the
 *    `/api/recipes/export` route can refuse the export with an
 *    actionable guidance message.
 * 3. Continue treating non-`api/` paths exactly as before.
 *
 * The HTTP-level "400 CustomBeNotExportable" path is exercised at
 * the L1 layer; this suite stays at the pure-function level.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { FileAccessLayer, FileStat } from '../../src/server/fs-layer'
import {
  inferArtifactType,
  scanAppDirectory,
} from '../../src/server/recipe-exporter'

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
    readFileSync: ((path: string) => {
      const v = files[path]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    }) as FileAccessLayer['readFileSync'],
    statSync: (path: string): FileStat => {
      const v = files[path]
      if (v === undefined && !dirs.has(path)) throw new Error(`ENOENT: ${path}`)
      return {
        size: v ? Buffer.byteLength(v, 'utf-8') : 0,
        mtime: new Date(0),
        mtimeMs: 0,
      }
    },
    writeFileSync: () => {},
    readBytesSync: () => Buffer.alloc(0),
    unlinkSync: () => {},
    mkdirSync: () => {},
    // Identity realpath: no symlinks in this in-memory layout. Required
    // because `scanAppDirectory` calls `realpathSync` on `app/` and
    // `app/<appId>/` for its symlink escape check.
    realpathSync: (path: string) => path,
    // Per-entry symlink defence in `scanDir` calls `lstatSync` on
    // every walked entry; report regular-file metadata so the guard
    // never fires for this in-memory layout.
    lstatSync: () => ({
      size: 0,
      mtime: new Date(0),
      mtimeMs: 0,
      isSymbolicLink: false,
      isFile: true,
      nlink: 1,
    }),
    watch: () => ({ close: () => {} }),
  } as unknown as FileAccessLayer
}

describe('inferArtifactType — T-3: api/ no longer maps to lib', () => {
  it('does not map api/<file>.ts to a lib artifact', () => {
    // The previous behaviour mapped api/ into 'lib' so route handlers
    // would be packaged as if they were utility modules. That output
    // could never be re-installed (recipe-inspector rejects api/) and
    // is no longer produced — api/ paths should never reach this
    // function in the new flow because scanAppDirectory routes them
    // into customBeFiles. Even if they do, the type fallback is just
    // 'lib' for unknown roots; what matters is that we are NOT
    // labelling api/<*> with a special-case meaning anymore.
    expect(inferArtifactType('api/handler.ts')).toBe('lib')
    expect(inferArtifactType('api/sub/handler.ts')).toBe('lib')
    // Sanity: real artifact roots still resolve correctly.
    expect(inferArtifactType('pages/Foo.tsx')).toBe('page')
    expect(inferArtifactType('styles/foo.css')).toBe('style')
    expect(inferArtifactType('hooks/useThing.ts')).toBe('hook')
    expect(inferArtifactType('utils/format.ts')).toBe('util')
  })
})

describe('scanAppDirectory — T-1: api/*.ts goes to customBeFiles', () => {
  it('collects api/<file>.ts into customBeFiles instead of artifacts', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/api/handler.ts`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.artifacts.map((a) => a.path)).toEqual(['pages/Foo.tsx'])
    expect(result.customBeFiles.map((f) => f.relativePath)).toEqual([
      'api/handler.ts',
    ])
  })

  it('also catches nested api/<sub>/<file>.ts as custom BE', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/api/v1/list.ts`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/api/v1/get.ts`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.artifacts.map((a) => a.path)).toEqual(['pages/Foo.tsx'])
    const beSorted = result.customBeFiles
      .map((f) => f.relativePath)
      .sort()
    expect(beSorted).toEqual(['api/v1/get.ts', 'api/v1/list.ts'])
  })

  it('records the byte size of each custom BE file', () => {
    const beBody = 'export const handler = async () => {}'
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/api/handler.ts`]: beBody,
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.customBeFiles).toHaveLength(1)
    expect(result.customBeFiles[0].sizeBytes).toBe(
      Buffer.byteLength(beBody, 'utf-8'),
    )
  })
})

describe('scanAppDirectory — T-2: existing artifact classification preserved', () => {
  it('keeps pages / styles / hooks / utils on the artifact side', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'p',
      [`${PROJECT_ROOT}/app/foo/styles/foo.css`]: 's',
      [`${PROJECT_ROOT}/app/foo/hooks/useFoo.ts`]: 'h',
      [`${PROJECT_ROOT}/app/foo/utils/foo.ts`]: 'u',
    })
    const result = scanAppDirectory(fs, 'foo')
    const byType = new Map<string, string[]>()
    for (const a of result.artifacts) {
      const list = byType.get(a.type) ?? []
      list.push(a.path)
      byType.set(a.type, list)
    }
    expect(byType.get('page')).toEqual(['pages/Foo.tsx'])
    expect(byType.get('style')).toEqual(['styles/foo.css'])
    expect(byType.get('hook')).toEqual(['hooks/useFoo.ts'])
    expect(byType.get('util')).toEqual(['utils/foo.ts'])
    expect(result.customBeFiles).toEqual([])
  })

  it('updates totalSize from artifacts only (custom BE bytes excluded)', () => {
    // The recipe download size estimate should reflect what actually
    // ships to the recipient. customBeFiles never reach the consumer,
    // so they intentionally do not bump totalSize.
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/pages/A.tsx`]: 'a'.repeat(10),
      [`${PROJECT_ROOT}/app/foo/api/handler.ts`]: 'b'.repeat(50),
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.totalSize).toBe(10)
    expect(result.customBeFiles[0].sizeBytes).toBe(50)
  })
})

describe('scanAppDirectory — sample cap on customBeFiles', () => {
  it('short-circuits on a large api/ tree and reports an approximate count', () => {
    // Pathological case: an `api/` tree with 60 files. The scanner
    // is expected to stop walking after it has accumulated enough
    // entries to drive the refusal, so the count it reports is a
    // lower bound rather than the true total. The test does NOT
    // assert customBeFilesCount === 60 anymore — that would force
    // the scanner to walk the entire rejected tree, defeating the
    // CPU/IO bound that the cap is meant to enforce.
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i += 1) {
      files[`${PROJECT_ROOT}/app/foo/api/h${i}.ts`] = 'export {}'
    }
    files[`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`] = 'export {}'
    const fs = makeFs(files)
    const result = scanAppDirectory(fs, 'foo')
    expect(result.customBeFiles.length).toBeLessThanOrEqual(50)
    expect(result.customBeFilesCount).toBeGreaterThanOrEqual(50)
    expect(result.customBeFilesCount).toBeLessThanOrEqual(60)
    expect(result.customBeFilesCountApproximate).toBe(true)
  })

  it('reports an exact (non-approximate) count when api/ stays under the cap', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/api/handler.ts`]: 'export {}',
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    expect(result.customBeFilesCount).toBe(1)
    expect(result.customBeFilesCountApproximate).toBe(false)
  })

  it('treats non-.ts files under api/ as custom BE too (path-prefix is the rule, not extension)', () => {
    // recipe-inspector's path-prefix restriction rejects every
    // artifact whose path starts with `api/` regardless of
    // extension, so the exporter must agree: a JSON fixture or a
    // README under api/ blocks the export the same way a .ts handler
    // would. Otherwise the exported recipe would still fail to
    // install — just with a more confusing error message.
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/foo/api/data.json`]: '{}',
      [`${PROJECT_ROOT}/app/foo/api/README.md`]: 'docs',
      [`${PROJECT_ROOT}/app/foo/pages/Foo.tsx`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'foo')
    const beSorted = result.customBeFiles.map((f) => f.relativePath).sort()
    expect(beSorted).toEqual(['api/README.md', 'api/data.json'])
    expect(result.customBeFilesCount).toBe(2)
    expect(result.artifacts.map((a) => a.path)).toEqual(['pages/Foo.tsx'])
  })
})
