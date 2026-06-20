/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.12 manifest backfill for manifest-less self-made
 * apps in `readUserMenuEntries` (app-directory-extension.md v1.8 §6.9).
 *
 * A menu.ts row whose `AppManifest` is entirely absent
 * (`manifestState === 'missing'`), whose page module is readable, and
 * that carries no recipe-install evidence at all (pure self-made) is
 * backfilled with an `AppManifest` (`source.type === 'user-creation'`,
 * `displayName = menu.ts label ?? appId`, `createdViaAgent: ''`) and
 * adopted in-memory in the same scan cycle so it becomes menu-metadata
 * eligible (`displayName !== null`).
 *
 * Coverage (§6.9.2 / §6.9.3 / §6.9.4 / §6.9.5):
 *   - page.tsx present + manifest absent → manifest written + eligible
 *   - generated fields match the spec normative values
 *   - existing manifest is never overwritten (idempotent / no double-gen)
 *   - a malformed (`'unreadable'`) manifest is never clobbered
 *   - no page module → no backfill
 *   - recipe-install evidence present → no backfill (provenance kept)
 *   - `menuOrder` / `userMenuLabel` are never written by backfill
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest'

const { serverLoggerStub } = vi.hoisted(() => ({
  serverLoggerStub: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/server/logger', () => ({
  serverLogger: serverLoggerStub,
  recipeLogger: serverLoggerStub,
  lazyChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { readUserMenuEntries } from '../../src/server/services/menu-extractor'
import type {
  AppManifestLookup,
  AppManifestLookupResult,
  BackfillHooks,
} from '../../src/server/services/menu-extractor'
import { isAppManifest } from '../../src/server/services/app-manifest'
import type { AppManifest } from '../../src/shared/app-manifest-types'
import type { FileAccessLayer } from '../../src/server/fs-layer'

const PROJECT_ROOT = '/test-project'
const APP_ID = 'research-reports'
const MENU_LABEL = 'Research Reports'
const KB_VERSION = '0.2.12'

const MENU_TS_BODY = [
  `export const menuEntries = [`,
  `  { id: '${APP_ID}', label: '${MENU_LABEL}', icon: 'note', component: () => import('./${APP_ID}/pages/Index') },`,
  `]`,
].join('\n')

const MENU_TS = `${PROJECT_ROOT}/app/menu.ts`
const PAGE_FILE = `${PROJECT_ROOT}/app/${APP_ID}/pages/Index.tsx`
const MANIFEST_FILE = `${PROJECT_ROOT}/app/${APP_ID}/manifest.json`

/**
 * In-memory FileAccessLayer whose `writeFileAtomic` mutates the same
 * file map that `existsSync` / `readFileSync` consult, so a manifest
 * written by the backfill becomes visible to a follow-up read in the
 * same test (exercising the on-disk write side-effect).
 */
function makeFs(initial: Record<string, string>): {
  fs: FileAccessLayer
  fileMap: Map<string, string>
  writes: string[]
} {
  const fileMap = new Map(Object.entries(initial))
  const writes: string[] = []
  const dirs = () => {
    const set = new Set<string>([PROJECT_ROOT])
    for (const p of fileMap.keys()) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return set
  }
  const fs: FileAccessLayer = {
    readFileSync: (p) => {
      const v = fileMap.get(p)
      if (v == null) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return v
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: () => {
      throw new Error('not implemented')
    },
    writeFileAtomic: (p, data) => {
      fileMap.set(p, typeof data === 'string' ? data : data.toString())
      writes.push(p)
    },
    existsSync: (p) => fileMap.has(p) || dirs().has(p),
    statSync: (p) => {
      if (!fileMap.has(p)) throw new Error(`ENOENT: ${p}`)
      return { size: fileMap.get(p)!.length } as unknown as ReturnType<FileAccessLayer['statSync']>
    },
    realpathSync: (p) => p,
    lstatSync: (p) =>
      ({ size: fileMap.get(p)?.length ?? 0, isSymbolicLink: false }) as unknown as ReturnType<
        FileAccessLayer['lstatSync']
      >,
    mkdirSync: () => {},
    rmdirSync: () => {},
    unlinkSync: () => {},
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const items = new Set<string>()
      for (const k of fileMap.keys()) {
        if (k.startsWith(prefix)) items.add(k.slice(prefix.length).split('/')[0])
      }
      return [...items]
    },
    renameSync: () => {},
    appendFileSync: () => {},
    watch: () => ({ close: () => {} }) as unknown as ReturnType<FileAccessLayer['watch']>,
  }
  return { fs, fileMap, writes }
}

/**
 * AppManifestLookup that reflects the live `fileMap`: the same
 * tri-plus-anomaly contract `app-routes.ts` provides, so a manifest
 * the backfill writes mid-scan would read back as `'present'` on a
 * second invocation (idempotency check).
 */
function lookupFor(
  fileMap: Map<string, string>,
  malformed = false,
): AppManifestLookup {
  return (appId): AppManifestLookupResult => {
    if (appId !== APP_ID) return { state: 'missing' }
    if (!fileMap.has(MANIFEST_FILE)) return { state: 'missing' }
    if (malformed) return { state: 'unreadable' }
    const raw = fileMap.get(MANIFEST_FILE)!
    try {
      const parsed = JSON.parse(raw)
      if (!isAppManifest(parsed)) return { state: 'unreadable' }
      return { state: 'present', manifest: parsed }
    } catch {
      return { state: 'unreadable' }
    }
  }
}

function backfillHooks(
  evidence = false,
): BackfillHooks {
  return {
    projectRoot: PROJECT_ROOT,
    kovitoboardVersion: KB_VERSION,
    recipeInstallEvidenceExists: () => evidence,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.KOVITOBOARD_PROJECT_ROOT = PROJECT_ROOT
})
afterAll(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
})

describe('readUserMenuEntries — manifest backfill (§6.9)', () => {
  it('backfills a manifest-less self-made app and makes it eligible in the same scan', () => {
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
      // no manifest.json
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    const row = entries.find((e) => e.id === APP_ID)!
    // In-memory synthesis: eligible in this same cycle.
    expect(row.manifestState).toBe('present')
    expect(row.displayName).toBe(MENU_LABEL)
    expect(row.source).toBe('self-made')
    expect(row.displayName).not.toBeNull()
    // Manifest written to disk.
    expect(writes).toContain(MANIFEST_FILE)
    expect(fileMap.has(MANIFEST_FILE)).toBe(true)
  })

  it('writes the spec normative generated fields (§6.9.4)', () => {
    const { fs, fileMap } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
    })
    readUserMenuEntries(fs, undefined, lookupFor(fileMap), undefined, 'en', undefined, backfillHooks())
    const written = JSON.parse(fileMap.get(MANIFEST_FILE)!) as AppManifest
    expect(written.appId).toBe(APP_ID)
    expect(written.displayName).toBe(MENU_LABEL)
    expect(written.kovitoboardVersion).toBe(KB_VERSION)
    expect(written.source).toEqual({ type: 'user-creation', createdViaAgent: '' })
    expect(typeof written.createdAt).toBe('string')
    // menuOrder / userMenuLabel never written by backfill (§6.9.4).
    expect('menuOrder' in written).toBe(false)
    expect('userMenuLabel' in written).toBe(false)
    // Schema-valid (empty createdViaAgent passes the validator).
    expect(isAppManifest(written)).toBe(true)
  })

  it('falls back to appId when the menu.ts entry label is empty', () => {
    const noLabelMenu = [
      `export const menuEntries = [`,
      `  { id: '${APP_ID}', label: '', icon: 'note', component: () => import('./${APP_ID}/pages/Index') },`,
      `]`,
    ].join('\n')
    // The parser regex requires a non-empty label, so an empty-label
    // row never parses; assert that and that nothing is written. This
    // pins the parser contract the displayName fallback defends against.
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: noLabelMenu,
      [PAGE_FILE]: '// stub page',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    expect(entries.find((e) => e.id === APP_ID)).toBeUndefined()
    expect(writes).not.toContain(MANIFEST_FILE)
  })

  it('does not overwrite an existing present manifest (idempotent)', () => {
    const existing: AppManifest = {
      appId: APP_ID,
      displayName: 'User Chosen Name',
      createdAt: '2026-01-01T00:00:00.000Z',
      kovitoboardVersion: '0.2.0',
      source: { type: 'user-creation', createdViaAgent: 'kovito-developer' },
      menuOrder: 3,
      userMenuLabel: 'My Override',
    }
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
      [MANIFEST_FILE]: JSON.stringify(existing, null, 2),
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    // No backfill write fired.
    expect(writes).not.toContain(MANIFEST_FILE)
    // Existing fields preserved verbatim.
    const after = JSON.parse(fileMap.get(MANIFEST_FILE)!) as AppManifest
    expect(after).toEqual(existing)
    const row = entries.find((e) => e.id === APP_ID)!
    expect(row.displayName).toBe('User Chosen Name')
    expect(row.menuOrder).toBe(3)
    expect(row.userMenuLabel).toBe('My Override')
  })

  it('never re-generates on a second scan (no double generation)', () => {
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
    })
    // First scan backfills.
    readUserMenuEntries(fs, undefined, lookupFor(fileMap), undefined, 'en', undefined, backfillHooks())
    expect(writes.filter((w) => w === MANIFEST_FILE)).toHaveLength(1)
    // Second scan: manifest now present → no second write.
    const second = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    expect(writes.filter((w) => w === MANIFEST_FILE)).toHaveLength(1)
    expect(second.find((e) => e.id === APP_ID)?.manifestState).toBe('present')
  })

  it('does not clobber a malformed (unreadable) manifest', () => {
    const garbage = '{ this is not json'
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
      [MANIFEST_FILE]: garbage,
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap, /* malformed */ true),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    // Backfill suppressed for the unreadable state — file untouched.
    expect(writes).not.toContain(MANIFEST_FILE)
    expect(fileMap.get(MANIFEST_FILE)).toBe(garbage)
    expect(entries.find((e) => e.id === APP_ID)?.manifestState).toBe('unreadable')
  })

  it('does not backfill when the page module is absent (§6.9.5 guard)', () => {
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      // page file intentionally absent — broken / mid-deletion dir
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    expect(writes).not.toContain(MANIFEST_FILE)
    const row = entries.find((e) => e.id === APP_ID)!
    expect(row.pageAbsolutePath).toBeNull()
    expect(row.manifestState).toBe('missing')
    expect(row.displayName).toBeNull()
  })

  it('does not backfill when recipe-install evidence exists (§6.9.2 condition 4)', () => {
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      lookupFor(fileMap),
      undefined,
      'en',
      undefined,
      backfillHooks(/* evidence */ true),
    )
    // Provenance preserved: a recipe-derived residue is never
    // reattributed to user-creation.
    expect(writes).not.toContain(MANIFEST_FILE)
    const row = entries.find((e) => e.id === APP_ID)!
    expect(row.manifestState).toBe('missing')
    expect(row.displayName).toBeNull()
  })

  it('does not backfill a multi-segment appId that escapes the §5.4 grammar (codex #143 F5)', () => {
    // `isCanonicalAppIdPath` accepts `foo/bar` (it only forbids `app/`
    // escapes), so this entry reaches the backfill branch — but a
    // backfilled `app/foo/bar/manifest.json` could never be enumerated
    // by the menu-order eligible scan (immediate-subdir walk), so the
    // appId-grammar guard must suppress it.
    const badId = 'foo/bar'
    const multiSegMenu = [
      `export const menuEntries = [`,
      `  { id: '${badId}', label: 'Bad', icon: 'note', component: () => import('./${badId}/pages/Index') },`,
      `]`,
    ].join('\n')
    const badPageFile = `${PROJECT_ROOT}/app/${badId}/pages/Index.tsx`
    const badManifestFile = `${PROJECT_ROOT}/app/${badId}/manifest.json`
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: multiSegMenu,
      [badPageFile]: '// stub page',
    })
    const entries = readUserMenuEntries(
      fs,
      undefined,
      (appId): AppManifestLookupResult => {
        // The off-canonical lookup reflects the live map; the manifest
        // is absent so the state is 'missing' and the backfill branch
        // fires (only to be suppressed by the appId-grammar guard).
        if (appId !== badId) return { state: 'missing' }
        return fileMap.has(badManifestFile) ? { state: 'unreadable' } : { state: 'missing' }
      },
      undefined,
      'en',
      undefined,
      backfillHooks(),
    )
    expect(writes).not.toContain(badManifestFile)
    expect(fileMap.has(badManifestFile)).toBe(false)
    const row = entries.find((e) => e.id === badId)
    // The row is still served (manifestState stays 'missing'), it is
    // simply never promoted to eligible.
    expect(row?.manifestState).toBe('missing')
    expect(row?.displayName).toBeNull()
  })

  it('preserves pre-v0.2.12 behavior when backfill hooks are omitted', () => {
    const { fs, fileMap, writes } = makeFs({
      [MENU_TS]: MENU_TS_BODY,
      [PAGE_FILE]: '// stub page',
    })
    const entries = readUserMenuEntries(fs, undefined, lookupFor(fileMap), undefined, 'en')
    expect(writes).not.toContain(MANIFEST_FILE)
    expect(entries.find((e) => e.id === APP_ID)?.manifestState).toBe('missing')
    expect(entries.find((e) => e.id === APP_ID)?.displayName).toBeNull()
  })
})
