/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the `appId` boundary defence in `recipe-exporter`.
 *
 * Covers the two layers introduced for Codex #11 (v0.2.x export
 * grandfather period):
 *
 *   1. `validateAppId` — regex (`/^[a-z][a-z0-9-]{0,63}$/`) plus the
 *      RESERVED_DIRS exclusion sourced from
 *      `docs/specs/app-directory-extension.md`.
 *   2. `scanAppDirectory` — realpath escape check that refuses to walk
 *      a directory whose canonical path is not under the canonical
 *      `app/` directory, even when `appId` itself looks innocuous.
 *
 * The route layer (`/api/recipes/export`, `/api/recipes/app-scan`)
 * delegates to both, so these tests pin the contract that the HTTP
 * boundary relies on.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { FileAccessLayer, FileStat } from '../../src/server/fs-layer'
import {
  scanAppDirectory,
  validateAppId,
  AppIdBoundaryError,
  APP_ID_PATTERN,
  APP_ID_RESERVED_DIRS,
} from '../../src/server/recipe-exporter'

const PROJECT_ROOT = '/proj'

beforeEach(() => {
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})

/**
 * Tiny in-memory FileAccessLayer for the boundary tests.
 *
 * `realpathOverride` lets a test simulate a planted symlink at the
 * app-root level: when set, it replaces the identity `realpathSync`
 * only for the listed paths so we can assert the scanner refuses to
 * walk a tree that escapes `app/`. Without the override every path
 * is its own canonical form, which mirrors the production layout
 * when no symlinks are present.
 *
 * `symlinkPaths` lets a test plant a symlink *inside* the app tree
 * (e.g. `app/<appId>/pages` linked to `/etc`). Anything in this set
 * is reported by `lstatSync` as `isSymbolicLink: true` so the
 * per-entry symlink defence in `scanDir` can refuse it. Paths not in
 * the set behave as ordinary directories or regular files.
 *
 * `hardLinkPaths` lets a test mark an entry as having `nlink > 1`
 * (i.e. another directory entry — possibly outside `app/<appId>/` —
 * also points at the same inode). The hard-link defence in
 * `scanDir` refuses these even though `isSymbolicLink` is `false`,
 * since `lstatSync` cannot otherwise distinguish them from honest
 * regular files. Paths not in the set get the default `nlink: 1`.
 */
function makeFs(
  files: Record<string, string>,
  realpathOverride: Record<string, string> = {},
  symlinkPaths: Set<string> = new Set(),
  hardLinkPaths: Set<string> = new Set(),
): FileAccessLayer {
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
    readFileSync: ((path: string, _enc?: string) => {
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
    realpathSync: (path: string) => realpathOverride[path] ?? path,
    // `lstatSync` is used by the per-entry symlink defence inside
    // `scanDir`. Default `isFile: true / isSymbolicLink: false /
    // nlink: 1` keeps every existing test behaving as plain regular
    // files; tests exercising the nested-symlink branch pass paths
    // via `symlinkPaths`, and tests exercising the hard-link
    // branch pass paths via `hardLinkPaths` (which flips `nlink: 2`
    // so the guard refuses the entry).
    lstatSync: (path: string) => ({
      size: 0,
      mtime: new Date(0),
      mtimeMs: 0,
      isSymbolicLink: symlinkPaths.has(path),
      isFile: !symlinkPaths.has(path),
      nlink: hardLinkPaths.has(path) ? 2 : 1,
    }),
    watch: () => ({ close: () => {} }),
  } as unknown as FileAccessLayer
}

describe('validateAppId — regex + RESERVED_DIRS contract', () => {
  it('exposes the same pattern documented in app-directory-extension.md', () => {
    // Pinning the regex literal here keeps spec drift loud: any silent
    // change to the contract surface (e.g. allowing uppercase) breaks
    // this assertion before it reaches the scanner.
    expect(APP_ID_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,63}$')
  })

  it('exposes the RESERVED_DIRS list verbatim', () => {
    expect(APP_ID_RESERVED_DIRS).toEqual(['api', 'pages', 'styles', 'data'])
  })

  it.each([
    ['my-app'],
    ['a'],
    ['research-reports'],
    // 64 chars (1 leading + 63 follow) is the maximum allowed by the regex.
    ['a' + 'b'.repeat(63)],
  ])('accepts %s', (appId) => {
    expect(validateAppId(appId)).toBe(appId)
  })

  it.each([
    ['empty string', ''],
    ['parent traversal segment', '..'],
    ['relative parent prefix', '../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['leading slash', '/foo'],
    ['uppercase first letter', 'Foo'],
    ['camel-case', 'myApp'],
    ['underscore', 'my_app'],
    ['dot-prefix', '.hidden'],
    ['numeric prefix', '1foo'],
    ['hyphen prefix', '-foo'],
    // 65 chars: 1 leading + 64 follow exceeds the {0,63} bound.
    ['too long (65 chars)', 'a' + 'b'.repeat(64)],
    ['contains slash', 'my-app/sub'],
    ['contains backslash', 'my-app\\sub'],
    ['contains whitespace', ' foo'],
    ['trailing whitespace', 'foo '],
    ['contains nul', 'foo\u0000bar'],
  ])('rejects %s', (_label, appId) => {
    expect(() => validateAppId(appId)).toThrow(AppIdBoundaryError)
  })

  it.each(APP_ID_RESERVED_DIRS)(
    'rejects RESERVED_DIRS entry %s even though it matches the pattern',
    (reserved) => {
      expect(APP_ID_PATTERN.test(reserved)).toBe(true)
      expect(() => validateAppId(reserved)).toThrow(AppIdBoundaryError)
      expect(() => validateAppId(reserved)).toThrow(/reserved/)
    },
  )

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['object', { appId: 'foo' }],
    ['array', ['foo']],
    ['boolean', true],
  ])('rejects non-string %s', (_label, value) => {
    expect(() => validateAppId(value)).toThrow(AppIdBoundaryError)
    expect(() => validateAppId(value)).toThrow(/string/)
  })
})

describe('scanAppDirectory — boundary defence', () => {
  it('throws AppIdBoundaryError for invalid appId before touching the filesystem', () => {
    // No app/ tree at all: an unguarded scanner would still fail later
    // with ENOENT, but the boundary check must reject the input
    // first so a malformed id never touches `existsSync` or
    // `realpathSync`.
    const fs = makeFs({})
    expect(() => scanAppDirectory(fs, '../etc/passwd')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, '..')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, '')).toThrow(AppIdBoundaryError)
  })

  it.each(APP_ID_RESERVED_DIRS)(
    'throws AppIdBoundaryError for RESERVED_DIR appId %s',
    (reserved) => {
      const fs = makeFs({})
      expect(() => scanAppDirectory(fs, reserved)).toThrow(AppIdBoundaryError)
    },
  )

  it('returns an empty result when the appId is valid but the directory is missing', () => {
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/menu.ts`]: '',
    })
    const result = scanAppDirectory(fs, 'missing-app')
    expect(result.artifacts).toEqual([])
    expect(result.menu).toEqual([])
    expect(result.totalSize).toBe(0)
    expect(result.customBeFilesCount).toBe(0)
  })

  it('refuses to scan when realpath(appRoot) escapes realpath(app/)', () => {
    // Symlink simulation: `app/foo` is in the tree (so the existsSync
    // check passes) but its canonical path resolves into `/etc/`,
    // which sits outside `realpath(app/)`. The scanner must throw
    // before walking the foreign directory.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
      },
      {
        // app/ resolves to itself (no symlink on the parent), but
        // app/foo resolves to a path under /etc/, simulating a
        // planted symlink.
        [`${PROJECT_ROOT}/app`]: `${PROJECT_ROOT}/app`,
        [`${PROJECT_ROOT}/app/foo`]: '/etc/passwd-shadow',
      },
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(
      /does not match expected canonical path/,
    )
  })

  it('refuses a symlinked appRoot that lands on a RESERVED_DIRS sibling (e.g. app/foo -> app/api)', () => {
    // Bypass attempt against the RESERVED_DIRS exclusion: `app/foo`
    // is a benign-looking appId, but the planted symlink redirects
    // its canonical resolution to `app/api/`. A guard that only
    // checked "still under realpath(app/)" would happily walk the
    // backend handler tree; the strict per-appId match refuses it.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/api/list-files.ts`]: 'export {}',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
      },
      {
        [`${PROJECT_ROOT}/app`]: `${PROJECT_ROOT}/app`,
        [`${PROJECT_ROOT}/app/foo`]: `${PROJECT_ROOT}/app/api`,
      },
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(
      /does not match expected canonical path/,
    )
  })

  it('refuses a symlinked appRoot that points at another app (e.g. app/foo -> app/other-app)', () => {
    // Cross-app access attempt: `app/foo` resolves to a sibling
    // app's directory. The scanner must not let `appId=foo` walk
    // `app/other-app/` even though both sit under `realpath(app/)`.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/other-app/pages/Other.tsx`]: 'export {}',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
      },
      {
        [`${PROJECT_ROOT}/app`]: `${PROJECT_ROOT}/app`,
        [`${PROJECT_ROOT}/app/foo`]: `${PROJECT_ROOT}/app/other-app`,
      },
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(
      /does not match expected canonical path/,
    )
  })

  it('accepts when realpath(appRoot) lands inside realpath(app/) even when both legs go through symlinks', () => {
    // Both `app/` and `app/foo` resolve through symlinks to a
    // different absolute root, but the canonical app root still
    // contains the canonical app directory — the legitimate "project
    // mounted via symlinked overlay" case must keep working.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
      },
      {
        [`${PROJECT_ROOT}/app`]: '/canonical/app',
        [`${PROJECT_ROOT}/app/foo`]: '/canonical/app/foo',
      },
    )
    const result = scanAppDirectory(fs, 'foo')
    expect(result.artifacts.map((a) => a.path)).toEqual(['pages/Index.tsx'])
  })

  it('walks the legitimate tree when no symlinks redirect the appRoot', () => {
    // Sanity baseline — asserts the defence does not regress the
    // happy path. A realistic exporter run with `appId = my-app`
    // should still produce the artifact list it always did.
    const fs = makeFs({
      [`${PROJECT_ROOT}/app/menu.ts`]: '',
      [`${PROJECT_ROOT}/app/my-app/pages/MyApp.tsx`]: 'export {}',
      [`${PROJECT_ROOT}/app/my-app/utils/helpers.ts`]: 'export {}',
    })
    const result = scanAppDirectory(fs, 'my-app')
    expect(result.artifacts.map((a) => a.path).sort()).toEqual([
      'pages/MyApp.tsx',
      'utils/helpers.ts',
    ])
  })

  it('refuses a directory-level nested symlink (e.g. app/<appId>/pages -> /etc)', () => {
    // The entry-level boundary check at the top of `scanAppDirectory`
    // canonicalises only `appRoot` itself. A planted symlink inside
    // the app tree (here `app/foo/pages` linked to `/etc`) would still
    // be followed by the recursive walk if the per-entry `lstatSync`
    // defence were missing. The scan must throw before reading any
    // file under the foreign tree.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
      },
      {},
      new Set([`${PROJECT_ROOT}/app/foo/pages`]),
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(/symlink/)
  })

  it('refuses a hard-linked file inside the app tree (nlink > 1)', () => {
    // Hard-link defence: a regular file whose inode is reachable from
    // outside `app/<appId>/` cannot be detected by `isSymbolicLink`
    // (the symlink check returns false for hard links). The scanner
    // sees `nlink: 2` and refuses, matching the policy applied to
    // symlinks. The fixture marks `app/foo/utils/secret.ts` as a
    // hard link; the scan must throw before reading any artifact.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
        [`${PROJECT_ROOT}/app/foo/utils/secret.ts`]: 'export {}',
      },
      {},
      new Set(),
      new Set([`${PROJECT_ROOT}/app/foo/utils/secret.ts`]),
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(/hard-linked/)
  })

  it('refuses a file-level nested symlink (e.g. app/<appId>/utils/link.ts -> ../../api/list-files.ts)', () => {
    // Symlink at the file level (rather than the directory level)
    // must be refused by the same per-entry guard. The recursive walk
    // would otherwise read the link target via `readFileSync` and
    // package it into the recipe artifact list under the link's own
    // relative path.
    const fs = makeFs(
      {
        [`${PROJECT_ROOT}/app/menu.ts`]: '',
        [`${PROJECT_ROOT}/app/api/list-files.ts`]: 'export {}',
        [`${PROJECT_ROOT}/app/foo/pages/Index.tsx`]: 'export {}',
        [`${PROJECT_ROOT}/app/foo/utils/link.ts`]: 'export {}',
      },
      {},
      new Set([`${PROJECT_ROOT}/app/foo/utils/link.ts`]),
    )
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(AppIdBoundaryError)
    expect(() => scanAppDirectory(fs, 'foo')).toThrow(/symlink/)
  })
})
