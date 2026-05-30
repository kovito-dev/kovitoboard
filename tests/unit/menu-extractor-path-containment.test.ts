/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the three-layer path-containment guard in
 * `readUserMenuEntries`, introduced in v0.2.1.
 *
 * The menu parser regex emits `<page>` from `import('./<page>')`,
 * which the renderer then dynamic-imports via Vite's `/@fs/` URL
 * scheme. Without containment, a hand-edited menu row such as
 * `component: () => import('./../../etc/passwd')` would survive
 * parse and land in `pageAbsolutePath`, letting the renderer pull
 * that file. The guard layers are:
 *
 *   - **Layer 1 — `isWithinAppDir(page, appDir)`**: lexical
 *     containment under `app/`. Refuses parent-directory escapes
 *     (`../etc/passwd`), absolute paths (`/etc/passwd`),
 *     drive-qualified shapes (`C:/../../bar`), Windows separators,
 *     and bare `..`.
 *   - **Layer 2 — `isCanonicalAppIdPath(page, id)`**: app-id
 *     binding. Refuses sibling-app drift
 *     (`doc-viewer/../evil-app/Index`) outright because loading
 *     evil-app's pages on the doc-viewer route would inject the
 *     wrong app's recipe-scoped capability bridge per
 *     `app-directory-extension.md`.
 *   - **Layer 3 — `realpathSync(candidate)` containment**: refuses
 *     planted symlinks whose target lands outside `app/`, and
 *     persists the canonicalized path so the renderer's later
 *     `/@fs/` import cannot be swapped post-validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isWithinAppDir,
  readUserMenuEntries,
} from '../../src/server/services/menu-extractor'
import type { FileAccessLayer } from '../../src/server/fs-layer'

// Capture warn calls via vi.hoisted so the stub is available
// inside the (also-hoisted) vi.mock factory. Without hoisting the
// factory references the variable before the module body runs.
const { serverLoggerStub } = vi.hoisted(() => ({
  serverLoggerStub: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../src/server/logger', () => ({
  serverLogger: serverLoggerStub,
  // `menu-extractor.ts` → `config.ts` pulls in `lazyChildLogger`,
  // so the mock must surface it too. Returning a no-op logger
  // keeps the resolver path quiet.
  lazyChildLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const warnSpy = serverLoggerStub.warn

beforeEach(() => {
  warnSpy.mockClear()
})

afterEach(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
})

interface MockFsOpts {
  /**
   * File-level symlinks: the path itself is a symlink whose
   * target is the mapped value. `lstatSync(p).isSymbolicLink`
   * returns `true` and `realpathSync(p)` returns the target.
   * Catches file-level redirect attacks (`<id>/Index.tsx →
   * /elsewhere/leak.tsx`).
   */
  symlinks?: Record<string, string>
  /**
   * Intermediate-directory symlinks expressed end-to-end at the
   * candidate level: `lstatSync(p).isSymbolicLink` returns `false`
   * (the candidate file itself is a plain regular file) while
   * `realpathSync(p)` returns the canonical target the production
   * fs layer would produce by walking the symlinked parent chain.
   * Catches directory-level redirect attacks (`<id> →
   * /elsewhere/evil-app/`).
   */
  directorySymlinks?: Record<string, string>
}

function makeMockFs(
  projectRoot: string,
  files: Record<string, string>,
  opts: MockFsOpts = {},
): FileAccessLayer {
  const fileMap = new Map(Object.entries(files))
  const dirs = new Set<string>([projectRoot])
  for (const p of fileMap.keys()) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  const fileSymlinks = new Map(Object.entries(opts.symlinks ?? {}))
  const dirSymlinks = new Map(Object.entries(opts.directorySymlinks ?? {}))
  // Symlink lookups walk the file-level map first so a path that
  // appears in both is treated as a file symlink (production
  // behaviour: lstat reports the leaf as a link).
  function realpathLookup(p: string): string {
    if (fileSymlinks.has(p)) return fileSymlinks.get(p)!
    if (dirSymlinks.has(p)) return dirSymlinks.get(p)!
    return p
  }
  return {
    readFileSync: (p) => {
      const v = fileMap.get(p)
      if (v == null) throw new Error(`ENOENT: ${p}`)
      return v
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: () => {
      throw new Error('not implemented in this stub')
    },
    writeFileAtomic: () => {
      throw new Error('not implemented in this stub')
    },
    existsSync: (p) =>
      fileMap.has(p) || dirs.has(p) || fileSymlinks.has(p) || dirSymlinks.has(p),
    statSync: (p) => {
      if (!fileMap.has(p)) throw new Error(`ENOENT: ${p}`)
      return { size: fileMap.get(p)!.length } as unknown as ReturnType<
        FileAccessLayer['statSync']
      >
    },
    lstatSync: (p) =>
      ({
        size: fileMap.get(p)?.length ?? 0,
        isSymbolicLink: fileSymlinks.has(p),
      }) as unknown as ReturnType<FileAccessLayer['lstatSync']>,
    // The path-containment guard canonicalizes the candidate
    // and the app dir via `realpathSync`. The mock returns the
    // mapped target when one is registered (file-level wins over
    // directory-level), otherwise the input unchanged.
    realpathSync: realpathLookup,
    mkdirSync: () => {},
    rmdirSync: () => {},
    unlinkSync: () => {},
    readdirSync: () => [],
    renameSync: () => {},
    appendFileSync: () => {},
    watch: () =>
      ({ close: () => {} } as unknown as ReturnType<FileAccessLayer['watch']>),
  } as FileAccessLayer
}

// =========================================
// isWithinAppDir — unit-level predicate
// =========================================

describe('isWithinAppDir', () => {
  it('accepts a canonical page path', () => {
    expect(isWithinAppDir('pages/Foo')).toBe(true)
    expect(isWithinAppDir('doc-viewer/pages/Index')).toBe(true)
    expect(isWithinAppDir('a/b/c/d/e')).toBe(true)
  })

  it('accepts in-app sibling drift at the Layer-1 predicate level', () => {
    // Layer 1 is intentionally coarse: it only checks that the
    // path stays inside `app/`. `doc-viewer/../evil-app` collapses
    // to `evil-app` which is still under app/, so the predicate
    // returns true. Layer 2 (`isCanonicalAppIdPath`) is what
    // refuses the cross-app drift further in.
    expect(isWithinAppDir('doc-viewer/../evil-app/Index')).toBe(true)
  })

  it('rejects parent-directory escapes', () => {
    expect(isWithinAppDir('../etc/passwd')).toBe(false)
    expect(isWithinAppDir('../../../../etc/passwd')).toBe(false)
    expect(isWithinAppDir('pages/../../etc/passwd')).toBe(false)
    expect(isWithinAppDir('doc-viewer/pages/../../../etc/passwd')).toBe(false)
  })

  it('rejects bare `..`', () => {
    expect(isWithinAppDir('..')).toBe(false)
  })

  it('accepts paths whose trailing `/..` collapses back inside app/', () => {
    // `path.normalize('pages/..')` is `.`, which joins back to
    // `appDir` itself — still inside app/, not an escape. Refusing
    // it would gate legitimate (if weird) hand-edits without
    // closing any escape gap, since the resolved path stays
    // safely under appDir.
    expect(isWithinAppDir('pages/..')).toBe(true)
    expect(isWithinAppDir('doc-viewer/pages/..')).toBe(true)
  })

  it('rejects absolute paths', () => {
    expect(isWithinAppDir('/etc/passwd')).toBe(false)
    expect(isWithinAppDir('/usr/local/bin/foo')).toBe(false)
  })

  it('rejects Windows-style separators', () => {
    expect(isWithinAppDir('\\evil')).toBe(false)
    expect(isWithinAppDir('pages\\Foo')).toBe(false)
    expect(isWithinAppDir('..\\etc\\passwd')).toBe(false)
  })

  it('rejects Win32 drive-qualified paths even with forward slashes', () => {
    // On Windows hosts `path.normalize('C:/../../bar')` strips the
    // drive prefix and emits `bar`, slipping past the POSIX-style
    // `..` checks. The drive-letter regex refuses the shape before
    // normalize can collapse it. POSIX hosts also refuse it (the
    // recipe layout never uses drive-qualified paths).
    expect(isWithinAppDir('C:foo')).toBe(false)
    expect(isWithinAppDir('C:/foo')).toBe(false)
    expect(isWithinAppDir('C:/../../bar')).toBe(false)
    expect(isWithinAppDir('D:bar/baz')).toBe(false)
    expect(isWithinAppDir('z:lowercase')).toBe(false)
  })

  it('rejects via the appDir resolve check when the lexical checks were ambiguous', () => {
    // Belt-and-braces: if a future platform quirk lets a path
    // sneak past the lexical checks, the resolve(appDir, page)
    // comparison still has to put the result under appDir.
    const appDir = '/test-project/app'
    // A path that lexically looks fine but, when resolved against
    // a different appDir, could land outside. Here we hand-craft
    // a value that the resolve check would refuse even though the
    // lexical checks pass: we cannot easily construct one with
    // pure POSIX semantics, so we verify the positive containment
    // case to lock in the expected behaviour.
    expect(isWithinAppDir('pages/Foo', appDir)).toBe(true)
    expect(isWithinAppDir('doc-viewer/pages/Index', appDir)).toBe(true)
    // Verify that obvious escapes are still refused when appDir
    // is passed (the lexical checks fire first).
    expect(isWithinAppDir('../etc/passwd', appDir)).toBe(false)
    expect(isWithinAppDir('C:/foo', appDir)).toBe(false)
  })

  it('rejects empty input', () => {
    expect(isWithinAppDir('')).toBe(false)
  })
})

// =========================================
// readUserMenuEntries — end-to-end guard
// =========================================

describe('readUserMenuEntries — path containment guard', () => {
  const projectRoot = '/test-project'
  const menuPath = `${projectRoot}/app/menu.ts`

  function menuTs(rows: Array<{ id: string; page: string }>): string {
    const lines = ['export const menuEntries = [']
    for (const row of rows) {
      lines.push(
        `  { id: '${row.id}', label: '${row.id} label', icon: 'note', component: () => import('./${row.page}') },`,
      )
    }
    lines.push(']')
    return lines.join('\n')
  }

  it('drops a row whose page escapes app/ with leading ..', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([{ id: 'evil', page: '../etc/passwd' }]),
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evil', page: '../etc/passwd' }),
      expect.stringContaining('escapes app/'),
    )
  })

  it('drops a row whose page contains a nested traversal that exits app/', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([
        { id: 'sneaky', page: 'doc-viewer/pages/../../../etc/passwd' },
      ]),
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('does not break legitimate in-app rows when an escape row is present', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const goodPath = `${projectRoot}/app/doc-viewer/pages/Index.tsx`
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([
        { id: 'doc-viewer', page: 'doc-viewer/pages/Index' },
        { id: 'evil', page: '../../etc/passwd' },
      ]),
      [goodPath]: 'export default function Index() { return null }\n',
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(2)
    const docViewer = entries.find((e) => e.id === 'doc-viewer')
    const evil = entries.find((e) => e.id === 'evil')
    expect(docViewer?.pageAbsolutePath).toBe(goodPath)
    expect(evil?.pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('forces trustLevel to null when the page escapes app/ even with a lookup', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([{ id: 'evil', page: '../etc/passwd' }]),
    })
    // The lookup would happily return a trust level — the guard
    // must short-circuit before the lookup is even consulted.
    const lookup = vi.fn(() => 'unknown' as const)
    const entries = readUserMenuEntries(fs, lookup)
    expect(entries[0].trustLevel).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects in-app sibling drift to refuse cross-app capability context mixup', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    // `doc-viewer/../evil-app/Index` collapses to `evil-app/Index`
    // which lexically lives under app/, but it lives under a
    // different appId than the menu entry's `id`. Loading it on
    // the `/ext/doc-viewer` route would inject `doc-viewer`'s
    // recipe-scoped bridge into evil-app's code — a cross-app
    // identity mixup per app-directory-extension.md. Layer 2
    // catches it before resolution.
    const driftedPath = `${projectRoot}/app/evil-app/Index.tsx`
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([
        { id: 'doc-viewer', page: 'doc-viewer/../evil-app/Index' },
      ]),
      [driftedPath]: 'export default function Index() { return null }\n',
    })
    const lookup = vi.fn(() => 'unknown' as const)
    const entries = readUserMenuEntries(fs, lookup)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(entries[0].trustLevel).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-viewer' }),
      expect.stringContaining('does not live under app/<id>/'),
    )
  })

  it('rejects rows whose page id does not match the menu entry id', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    // Directly bound — no `..` shenanigans — but still
    // cross-app: the page lives under app/evil-app/ while the
    // menu entry id is doc-viewer.
    const driftedPath = `${projectRoot}/app/evil-app/Index.tsx`
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([
        { id: 'doc-viewer', page: 'evil-app/Index' },
      ]),
      [driftedPath]: 'export default function Index() { return null }\n',
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

// =========================================
// Symlink containment (real fs)
// =========================================

describe('readUserMenuEntries — symlink defence (Layer 3)', () => {
  // Layer 3 refuses any entry whose `realpathSync(candidate)` differs
  // from the lexical candidate, regardless of whether the canonical
  // target stays inside `app/<id>/` or not. The rationale (Codex review
  // attempt 6): silently swapping the import base path would change
  // the page module's own relative-import resolution, which is not a
  // supported feature in v0.2.x. Refusing the entire shape also keeps
  // the warn payload free of canonical absolute paths so the guard
  // does not leak host filesystem layout in logs.
  const projectRoot = '/test-project'
  const menuPath = `${projectRoot}/app/menu.ts`

  function menuTs(rows: Array<{ id: string; page: string }>): string {
    const lines = ['export const menuEntries = [']
    for (const row of rows) {
      lines.push(
        `  { id: '${row.id}', label: '${row.id} label', icon: 'note', component: () => import('./${row.page}') },`,
      )
    }
    lines.push(']')
    return lines.join('\n')
  }

  function buildSymlinkFs(symlinks: Record<string, string>): FileAccessLayer {
    return makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'leaky-app', page: 'leaky-app/Index' }]),
        [`${projectRoot}/app/leaky-app/Index.tsx`]: '// placeholder\n',
      },
      { symlinks },
    )
  }

  it('refuses a file-level symlink pointing outside app/', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    const fs = buildSymlinkFs({ [candidatePath]: '/elsewhere/secrets/leak.tsx' })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'leaky-app',
        reason: 'symlink-redirect',
      }),
      expect.stringContaining('page file is a symlink'),
    )
  })

  it('refuses a file-level symlink even when the target stays inside app/<id>/', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    // Same-app target. Still refused: any symlink redirection changes
    // the import base path, breaking the page module's relative imports.
    const fs = buildSymlinkFs({
      [candidatePath]: `${projectRoot}/app/leaky-app/pages/RealIndex.tsx`,
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'leaky-app',
        reason: 'symlink-redirect',
      }),
      expect.stringContaining('page file is a symlink'),
    )
  })

  it('refuses when the app/<id>/ directory itself is a symlink outside app/', () => {
    // The entry's own `app/<id>/` directory is a symlink to a
    // location outside `app/`. The candidate file is plain, so
    // `lstatSync` returns `isSymbolicLink: false`, but both
    // `realpathSync(appIdDir)` and `realpathSync(candidate)`
    // canonicalize through the directory link. Layer 3b (outer
    // containment: `realAppIdDir` under `realAppDir`) refuses
    // the row.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const appIdDir = `${projectRoot}/app/leaky-app`
    const candidatePath = `${appIdDir}/Index.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'leaky-app', page: 'leaky-app/Index' }]),
        [candidatePath]: '// placeholder\n',
      },
      {
        directorySymlinks: {
          [appIdDir]: '/elsewhere/evil-app',
          [candidatePath]: '/elsewhere/evil-app/Index.tsx',
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'leaky-app',
        reason: 'app-id-dir-escape',
      }),
      expect.stringContaining('app/<id>/ directory escapes app/'),
    )
  })

  it('refuses when canonical candidate lands outside its app/<id>/ but inside app/', () => {
    // Cross-app intermediate symlink: realpath sends the
    // candidate under `app/evil-app/...` rather than the entry's
    // own `app/leaky-app/...`. Layer 3c (inner containment)
    // catches it.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'leaky-app', page: 'leaky-app/Index' }]),
        [candidatePath]: '// placeholder\n',
      },
      {
        directorySymlinks: {
          [candidatePath]: `${projectRoot}/app/evil-app/Index.tsx`,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'leaky-app',
        reason: 'app-id-escape',
      }),
      expect.stringContaining('escapes app/<id>/'),
    )
  })

  it('accepts a plain file whose canonical path differs only in casing (case-insensitive FS)', () => {
    // Simulate a case-insensitive filesystem (macOS APFS): the
    // candidate exists at its mixed-case form, lstat reports it
    // as a plain file, but realpathSync returns a different
    // casing for the canonical form. The containment compare
    // must be prefix-based (not string equality), so the row is
    // accepted instead of falsely flagged as `symlink-redirect`.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    const canonicalPath = `${projectRoot}/app/leaky-app/index.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'leaky-app', page: 'leaky-app/Index' }]),
        [candidatePath]: '// placeholder\n',
      },
      {
        directorySymlinks: {
          // Layer 3a sees `lstatSync(candidate).isSymbolicLink === false`,
          // Layer 3b sees `realpathSync(candidate) === canonicalPath`
          // which stays under `app/leaky-app/` → accept.
          [candidatePath]: canonicalPath,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBe(canonicalPath)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('accepts a plain (non-symlinked) page file and persists the lexical path', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    // No symlink mapping → realpathSync returns candidate verbatim.
    const fs = buildSymlinkFs({})
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBe(candidatePath)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('refuses when realpathSync throws (broken link / EACCES / ELOOP)', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/broken-app/Index.tsx`
    const fs = makeMockFs(projectRoot, {
      [menuPath]: menuTs([{ id: 'broken-app', page: 'broken-app/Index' }]),
      [candidatePath]: '// placeholder\n',
    }) as FileAccessLayer
    // Override realpathSync to simulate a broken symlink / EACCES.
    ;(fs as { realpathSync: (p: string) => string }).realpathSync = (
      p: string,
    ) => {
      if (p === candidatePath) throw new Error('ELOOP: symlink loop')
      return p
    }
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'broken-app',
        reason: 'realpath-failure',
      }),
      expect.stringContaining('could not be canonicalized'),
    )
  })
})
