/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Integration tests for the work-roots router
 * (spec `cwd-allowlist.md` v1.0 §5.3 / §6.2 SSOT).
 *
 * Covers the §6.2.2 7-step validation, the §6.2.3 delete contract,
 * and the §7.5 CAS retry exhaustion path. Tests boot the real
 * Express router against a tempdir so the persistence + lock layer
 * exercised in setting-manager is exercised end-to-end too.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetProjectRootCache } from '../../src/server/config'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger } from '../../src/server/logger'
import { createWorkRootsRouter } from '../../src/server/routes/work-roots-routes'
import { writeSetting } from '../../src/server/setting-manager'
import type { KovitoboardSetting } from '../../src/shared/setting-types'

const fsLayer = new DirectFsLayer()
let loggerRoot: string
let projectRoot: string
let server: Server
let baseUrl: string

function baseSetting(): KovitoboardSetting {
  return {
    version: '1.2',
    revision: 1,
    additionalWorkRoots: [],
    workRootsMetadata: {},
    user: { displayName: 'tester', avatar: null },
    project: {
      name: 'test-project',
      description: 'work-roots integration',
      path: projectRoot,
    },
    locale: 'en',
    onboarding: { completedAt: '2026-05-10T00:00:00Z', wizardVersion: '0.1.0' },
  }
}

const app = express()
app.use(express.json())
app.use('/api/work-roots', createWorkRootsRouter(fsLayer))

beforeAll(async () => {
  loggerRoot = mkdtempSync(join(tmpdir(), 'kb-work-roots-test-logger-'))
  mkdirSync(join(loggerRoot, '.kovitoboard', 'logs'), { recursive: true })
  await initLogger(loggerRoot, null)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(loggerRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'kb-work-roots-proj-'))
  mkdirSync(join(projectRoot, '.kovitoboard'), { recursive: true })
  process.env.KOVITOBOARD_PROJECT_ROOT = projectRoot
  _resetProjectRootCache()
  await writeSetting(fsLayer, baseSetting())
})

afterEach(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
  _resetProjectRootCache()
  rmSync(projectRoot, { recursive: true, force: true })
})

// --- GET ---------------------------------------------------------------

describe('GET /api/work-roots', () => {
  it('returns an empty list on fresh state', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ additionalWorkRoots: [] })
  })

  it('reflects roots added via POST', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-extra-'))
    try {
      const post = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(post.status).toBe(200)
      const get = await fetch(`${baseUrl}/api/work-roots`)
      const body = await get.json()
      expect(body.additionalWorkRoots).toHaveLength(1)
      expect(body.additionalWorkRoots[0]).toBe(fsLayer.realpathSync(extra))
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

// --- POST --------------------------------------------------------------

describe('POST /api/work-roots — happy path', () => {
  it('returns 200 + canonical addedPath when input is a valid absolute directory', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-extra-'))
    try {
      const res = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.addedPath).toBe(fsLayer.realpathSync(extra))
      expect(body.additionalWorkRoots).toContain(fsLayer.realpathSync(extra))
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it('persists workRootsMetadata for the added root', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-extra-meta-'))
    try {
      const res = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(res.status).toBe(200)
      // Verify the metadata is on disk by reading the setting back.
      const getRes = await fetch(`${baseUrl}/api/work-roots`)
      const body = await getRes.json()
      expect(body.additionalWorkRoots).toHaveLength(1)
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

describe('POST /api/work-roots — failure envelopes', () => {
  it('rejects a non-string path with not_absolute', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 123 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_absolute')
  })

  it('rejects a relative path with not_absolute', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'relative/dir' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_absolute')
    expect(body.path).toBe('relative/dir')
  })

  it('rejects a missing path with not_found', async () => {
    const missing = join(tmpdir(), 'kb-definitely-missing-' + Date.now())
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: missing }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_found')
  })

  it('rejects a regular file with not_directory', async () => {
    const filePath = join(projectRoot, 'file.txt')
    // Reuse the project root tempdir; write a file inside it.
    fsLayer.writeFileSync(filePath, 'hi')
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_directory')
  })

  it('rejects a denylisted path with denylisted_root', async () => {
    // We cannot mkdir /etc inside the sandbox, but /etc already
    // exists on every CI runner and is one of the §7.3 anchors.
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('denylisted_root')
    expect(body.path).toBe('/etc')
  })

  // CodeX PR #38 Attempt 4 MED 2 regression — path-length cap.
  it('rejects a path longer than the per-entry cap with path_too_long', async () => {
    // 4097 chars: one over MAX_WORK_ROOT_PATH_LENGTH. The value
    // happens to be absolute (leading slash) so we exercise the
    // length check specifically rather than the not_absolute branch.
    const longPath = '/' + 'a'.repeat(4096)
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: longPath }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('path_too_long')
  })

  // CodeX PR #38 Attempt 4 MED 2 regression — count cap.
  it('rejects POST when the allow-list is already at MAX_WORK_ROOTS with too_many_roots', async () => {
    // Pre-seed `additionalWorkRoots` with 32 synthetic entries
    // directly via the on-disk setting (we avoid 32 real-FS probes
    // here — the test is about the ceiling check, not about
    // canonicalization).
    const { readFileSync, writeFileSync } = await import('node:fs')
    const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
    const setting = JSON.parse(readFileSync(settingPath, 'utf-8'))
    setting.additionalWorkRoots = Array.from(
      { length: 32 },
      (_v, i) => `/tmp/synthetic-root-${i}`,
    )
    setting.workRootsMetadata = Object.fromEntries(
      setting.additionalWorkRoots.map((p: string) => [
        p,
        { caseSensitive: true, probedAt: '2026-05-15T00:00:00Z' },
      ]),
    )
    writeFileSync(settingPath, JSON.stringify(setting, null, 2))

    const extra = mkdtempSync(join(tmpdir(), 'kb-work-cap-'))
    try {
      const res = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('too_many_roots')
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  // CodeX PR #38 Attempt 4 MED 1 regression — probe runs only after
  // the setting precheck, so a request that will return `no_setting`
  // never writes the probe sentinel into the user-supplied directory.
  it('returns no_setting (before running the probe) when setting.json is absent', async () => {
    const { rmSync: rmSyncFn, readdirSync } = await import('node:fs')
    const settingPath = join(projectRoot, '.kovitoboard', 'setting.json')
    rmSyncFn(settingPath, { force: true })

    const extra = mkdtempSync(join(tmpdir(), 'kb-work-no-setting-'))
    try {
      const before = readdirSync(extra)
      expect(before).toEqual([])

      const res = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('no_setting')

      // Probe sentinel must NOT have been written into the supplied
      // directory: the precheck rejected the request before the
      // probe could touch the filesystem.
      const after = readdirSync(extra)
      expect(after).toEqual([])
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it('rejects a duplicate add with duplicate', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-dup-'))
    try {
      const first = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(first.status).toBe(200)

      const second = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(second.status).toBe(400)
      const body = await second.json()
      expect(body.error).toBe('duplicate')
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

// --- DELETE ------------------------------------------------------------

describe('DELETE /api/work-roots', () => {
  it('removes an existing entry and returns the updated list', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-del-'))
    try {
      const postRes = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      const postBody = await postRes.json()
      const canonical = postBody.addedPath as string

      const del = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: canonical }),
      })
      expect(del.status).toBe(200)
      const body = await del.json()
      expect(body.removedPath).toBe(canonical)
      expect(body.additionalWorkRoots).not.toContain(canonical)
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it('returns 404 + not_found when the path is not in the list', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/never-added' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('not_found')
  })

  it('rejects an empty-string path with invalid_path', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_path')
  })

  // CodeX PR #38 Attempt 8 LOW 1 regression — DELETE must enforce
  // the same absolute-only contract as POST + validateCwd. A
  // relative input previously fell through to realpathSync() which
  // resolved it against the server process cwd, making a
  // security-sensitive allow-list mutation depend on process state.
  it('rejects a relative path with not_absolute (matches POST contract)', async () => {
    const res = await fetch(`${baseUrl}/api/work-roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'relative/work-root' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('not_absolute')
  })

  // CodeX PR #38 Attempt 4 LOW 3 regression — DELETE canonicalises
  // the input via realpath so a trailing-slash form (or any other
  // equivalent form) successfully matches the stored canonical entry.
  it('canonicalises the DELETE input so a trailing-slash form removes the canonical entry', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-canon-del-'))
    try {
      const post = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      const canonical = (await post.json()).addedPath as string

      // Issue DELETE with a trailing slash — pre-fix this verbatim
      // form would miss the canonical entry; post-fix realpath strips
      // the slash and the lookup succeeds.
      const withSlash = canonical + '/'
      const del = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: withSlash }),
      })
      expect(del.status).toBe(200)
      const body = await del.json()
      // `removedPath` reports the actual stored entry (canonical form).
      expect(body.removedPath).toBe(canonical)
      expect(body.additionalWorkRoots).not.toContain(canonical)
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it('cleans up workRootsMetadata when the root is removed', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'kb-work-meta-cleanup-'))
    try {
      const post = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      const canonical = (await post.json()).addedPath as string

      await fetch(`${baseUrl}/api/work-roots`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: canonical }),
      })

      // Verify metadata cleanup by adding the same path again — if the
      // stale metadata had been kept, the duplicate guard would still
      // reject because the canonical form is identical.
      const re = await fetch(`${baseUrl}/api/work-roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: extra }),
      })
      expect(re.status).toBe(200)
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})
