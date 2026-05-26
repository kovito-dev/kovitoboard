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
   * Optional symlink map: `path → resolvedTarget`. When the
   * production code calls `realpathSync(p)`, the mock returns
   * `resolvedTarget` if `p` is in the map, otherwise `p`. Lets the
   * Layer-3 symlink check be exercised without standing up a real
   * temp-dir tree (which would also need cache resets across the
   * config-cached projectRoot resolver).
   */
  symlinks?: Record<string, string>
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
  const symlinkMap = new Map(Object.entries(opts.symlinks ?? {}))
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
    existsSync: (p) => fileMap.has(p) || dirs.has(p) || symlinkMap.has(p),
    statSync: (p) => {
      if (!fileMap.has(p)) throw new Error(`ENOENT: ${p}`)
      return { size: fileMap.get(p)!.length } as unknown as ReturnType<
        FileAccessLayer['statSync']
      >
    },
    // The path-containment guard canonicalizes both `candidate`
    // and `appDir` via `realpathSync`. The mock returns the
    // symlink target when one is registered, otherwise the input
    // unchanged.
    realpathSync: (p) => symlinkMap.get(p) ?? p,
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

describe('readUserMenuEntries — symlink containment (Layer 3)', () => {
  // The Layer-3 guard refuses any entry whose `realpathSync(candidate)`
  // does not resolve inside `realpathSync(appDir)`. We drive it
  // through the mock fs's symlink map: registering
  // `app/leaky-app/Index.tsx → /elsewhere/leak.tsx` simulates a
  // planted symlink pointing outside `app/`, while a target that
  // remains inside `app/` is accepted.
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

  it('rejects a menu entry whose .tsx file is a symlink to outside app/', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/leaky-app/Index.tsx`
    const outsideTarget = '/elsewhere/secrets/leak.tsx'
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'leaky-app', page: 'leaky-app/Index' }]),
        [candidatePath]: '// placeholder\n',
      },
      {
        symlinks: {
          [candidatePath]: outsideTarget,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    // The candidate exists (mock returns true) and is found, but
    // realpathSync points outside appDir, so Layer 3 refuses it.
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'leaky-app' }),
      expect.stringContaining('escapes app/<id>/ via symlink'),
    )
  })

  it('rejects a symlink whose target lands in app/ but outside the entry\'s own app/<id>/', () => {
    // The target is under app/ but in a different app's subtree.
    // Layer 3 must refuse this even though the lexical page
    // (`doc-viewer/Index`) passes Layers 1 and 2 — otherwise a
    // planted link would reintroduce the cross-app capability
    // mixup Layer 2 just closed.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/doc-viewer/Index.tsx`
    const crossAppTarget = `${projectRoot}/app/evil-app/Index.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'doc-viewer', page: 'doc-viewer/Index' }]),
        [candidatePath]: '// placeholder\n',
        // Materialize the `<id>/` directory so realpathSync can
        // canonicalize it.
        [`${projectRoot}/app/doc-viewer/.keep`]: '',
      },
      {
        symlinks: {
          [candidatePath]: crossAppTarget,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-viewer' }),
      expect.stringContaining('escapes app/<id>/ via symlink'),
    )
  })

  it('accepts a symlink whose target stays inside the entry\'s own app/<id>/', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const candidatePath = `${projectRoot}/app/doc-viewer/Index.tsx`
    const sameAppTarget = `${projectRoot}/app/doc-viewer/pages/RealIndex.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'doc-viewer', page: 'doc-viewer/Index' }]),
        [candidatePath]: '// placeholder\n',
        [`${projectRoot}/app/doc-viewer/.keep`]: '',
      },
      {
        symlinks: {
          [candidatePath]: sameAppTarget,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    // Layer 3 persists the canonical realpath, not the symlink
    // source, so the renderer's later `/@fs/` import pins to the
    // verified target and can no longer be swapped.
    expect(entries[0].pageAbsolutePath).toBe(sameAppTarget)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('rejects when the app/<id>/ directory itself is a symlink outside app/', () => {
    // Plant a menu row whose page path lexically looks fine, but
    // the entry's own `app/<id>/` directory is a symlink to a
    // location outside `app/`. The candidate file (which lives
    // physically under the foreign target) would otherwise pass
    // the inner containment check because the comparison root is
    // the foreign target itself. The new outer check refuses it.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const appIdDir = `${projectRoot}/app/doc-viewer`
    const foreignAppDir = `${projectRoot}/elsewhere/evil-app`
    const candidatePath = `${appIdDir}/Index.tsx`
    const fs = makeMockFs(
      projectRoot,
      {
        [menuPath]: menuTs([{ id: 'doc-viewer', page: 'doc-viewer/Index' }]),
        [candidatePath]: '// placeholder\n',
      },
      {
        symlinks: {
          // app/doc-viewer → /elsewhere/evil-app
          [appIdDir]: foreignAppDir,
          // The candidate, when canonicalized, points at the
          // foreign target file.
          [candidatePath]: `${foreignAppDir}/Index.tsx`,
        },
      },
    )
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].pageAbsolutePath).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-viewer' }),
      expect.stringContaining('app/<id>/ directory itself escapes app/'),
    )
  })

  it('rejects when realpathSync throws (broken or denied link)', () => {
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
      expect.objectContaining({ id: 'broken-app' }),
      expect.stringContaining('could not be canonicalized'),
    )
  })
})
