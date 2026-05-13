/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the trust-level lookup integration in
 * `readUserMenuEntries` (handoff
 * `v02x-phase1-trust-marker-preamble-warning-request.md` v1.1
 * §3.2). The extractor itself stays oblivious to the manifest store
 * — the API route hands it a lookup lambda — so we exercise both:
 *
 *   1. No lookup supplied → every entry's `trustLevel` is `null`
 *      (matches the legacy contract from before the field existed).
 *   2. Lookup supplied → the entry inherits the value the lookup
 *      returns for its `appId`. `null` returns stay `null` (no
 *      manifest registered for that id).
 *
 * The in-memory `FileAccessLayer` mirrors the pattern used in
 * `recipe-parser-recipe-id.test.ts` so the extractor exercises its
 * production path without writing to the host disk.
 */
import { describe, it, expect } from 'vitest'
import { readUserMenuEntries } from '../../src/server/services/menu-extractor'
import type { FileAccessLayer } from '../../src/server/fs-layer'

const MENU_TS_BODY = [
  `export const menuEntries = [`,
  `  { id: 'doc-viewer', label: 'Doc Viewer', icon: 'note', component: () => import('./doc-viewer/pages/Index') },`,
  `  { id: 'todo', label: 'TODO', icon: 'content', component: () => import('./todo/pages/Index') },`,
  `]`,
].join('\n')

function makeMockFs(projectRoot: string, files: Record<string, string>): FileAccessLayer {
  const fileMap = new Map(Object.entries(files))
  const dirs = new Set<string>([projectRoot])
  for (const p of fileMap.keys()) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  const fs: FileAccessLayer = {
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
    existsSync: (p) => fileMap.has(p) || dirs.has(p),
    statSync: (p) => {
      if (!fileMap.has(p)) throw new Error(`ENOENT: ${p}`)
      return { size: fileMap.get(p)!.length } as unknown as ReturnType<FileAccessLayer['statSync']>
    },
    mkdirSync: () => {},
    rmdirSync: () => {},
    unlinkSync: () => {},
    readdirSync: () => [],
    renameSync: () => {},
    appendFileSync: () => {},
    watch: () => ({ close: () => {} } as unknown as ReturnType<FileAccessLayer['watch']>),
  }
  return fs
}

describe('readUserMenuEntries — trustLevel lookup', () => {
  // `resolveProjectRoot(fs)` consumes `$KOVITOBOARD_PROJECT_ROOT` so
  // the test points it at a synthesized in-memory root.
  const projectRoot = '/test-project'
  const menuPath = `${projectRoot}/app/menu.ts`

  it('leaves trustLevel null when no lookup is supplied (legacy contract)', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: MENU_TS_BODY,
    })
    const entries = readUserMenuEntries(fs)
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.trustLevel).toBeNull()
    }
  })

  it('threads the lookup return value onto each entry', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: MENU_TS_BODY,
    })
    const entries = readUserMenuEntries(fs, (appId) => {
      if (appId === 'doc-viewer') return 'unknown'
      // Forward-compat: a future v0.3.0 KovitoHub install lands here.
      if (appId === 'todo') return 'code-trusted'
      return null
    })
    const byId = new Map(entries.map((e) => [e.id, e.trustLevel]))
    expect(byId.get('doc-viewer')).toBe('unknown')
    expect(byId.get('todo')).toBe('code-trusted')
  })

  it('keeps trustLevel null when the lookup returns null (no manifest registered)', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const fs = makeMockFs(projectRoot, {
      [menuPath]: MENU_TS_BODY,
    })
    const entries = readUserMenuEntries(fs, () => null)
    for (const entry of entries) {
      expect(entry.trustLevel).toBeNull()
    }
  })

  it('refuses to attach trustLevel when the page is not under the entry id directory (badge-spoof defence)', () => {
    // A hand-edited `app/menu.ts` row reuses the `appId` of an
    // installed manifest (`doc-viewer`) while pointing `component`
    // at a completely different directory. menu-extractor must
    // refuse to inherit the manifest's trust badge for that row.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const spoofedBody = [
      `export const menuEntries = [`,
      `  { id: 'doc-viewer', label: 'Doc Viewer', icon: 'note', component: () => import('./evil-app/pages/Index') },`,
      `]`,
    ].join('\n')
    const fs = makeMockFs(projectRoot, {
      [menuPath]: spoofedBody,
    })
    const entries = readUserMenuEntries(fs, (appId) =>
      appId === 'doc-viewer' ? 'code-trusted' : null,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('doc-viewer')
    // Page path `evil-app/pages/Index` does not start with the
    // canonical `doc-viewer/` prefix, so the lookup is suppressed.
    expect(entries[0].trustLevel).toBeNull()
  })

  it('accepts entries whose page is the entry id itself (single-file recipe convention)', () => {
    // `recipe-applicator.ts` can emit a page that is exactly the
    // appId for single-page recipes (e.g. `component: () =>
    // import('./foo')`). The canonical-prefix check must accept
    // that shape too.
    process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
    const singleFileBody = [
      `export const menuEntries = [`,
      `  { id: 'foo', label: 'Foo', icon: 'note', component: () => import('./foo') },`,
      `]`,
    ].join('\n')
    const fs = makeMockFs(projectRoot, {
      [menuPath]: singleFileBody,
    })
    const entries = readUserMenuEntries(fs, (appId) =>
      appId === 'foo' ? 'unknown' : null,
    )
    expect(entries[0].trustLevel).toBe('unknown')
  })
})
