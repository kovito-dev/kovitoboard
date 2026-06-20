/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Regression test for codex #143 F4: the `/menu-entries` GET handler
 * must build its backfill scan context (and therefore re-snapshot
 * `recipe-history.jsonl`) PER REQUEST, not once at router construction.
 *
 * The v0.2.12 backfill (app-directory-extension.md v1.8 §6.9) reads the
 * recipe history once per scan to decide whether a manifest-less app is
 * pure self-made (§6.9.2 condition 4). If that snapshot were captured at
 * `createAppRouter` time, a recipe install / uninstall appended after
 * server startup would be invisible to later scans, and a post-startup
 * recipe app could be mis-backfilled as `user-creation` against a stale
 * evidence snapshot.
 *
 * This test builds the router once, then mutates the history between two
 * GET calls and asserts the second scan honours the fresh evidence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'

import { initLogger } from '../../src/server/logger'
import { createAppRouter } from '../../src/server/routes/app-routes'
import { RecipeManifestStore } from '../../src/server/recipeManifestStore'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { _resetProjectRootCache } from '../../src/server/config'

beforeAll(async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'kb-app-routes-fresh-logroot-'))
  mkdirSync(join(logRoot, '.kovitoboard', 'logs'), { recursive: true })
  await initLogger(logRoot, null)
})

const APP_ID = 'research-reports'

interface Harness {
  projectRoot: string
  app: Express
}

function writeMenuTsAndPage(projectRoot: string): void {
  const pagesDir = join(projectRoot, 'app', APP_ID, 'pages')
  mkdirSync(pagesDir, { recursive: true })
  writeFileSync(join(pagesDir, 'Index.tsx'), '// stub page', 'utf-8')
  const menuTs = [
    'export const menuEntries = [',
    `  { id: '${APP_ID}', label: 'Research Reports', icon: 'note', component: () => import('./${APP_ID}/pages/Index') },`,
    ']',
    '',
  ].join('\n')
  writeFileSync(join(projectRoot, 'app', 'menu.ts'), menuTs, 'utf-8')
}

function buildHarness(): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kb-app-routes-fresh-'))
  mkdirSync(join(projectRoot, 'app'), { recursive: true })
  mkdirSync(join(projectRoot, '.kovitoboard'), { recursive: true })
  const fs = new DirectFsLayer()
  const manifestStore = new RecipeManifestStore(
    join(projectRoot, '.kovitoboard'),
    fs,
  )
  manifestStore.loadAll()
  const expressApp = express()
  expressApp.use(express.json())
  // Router built ONCE here — the per-request context construction is
  // what the F4 fix guarantees.
  expressApp.use('/api/app', createAppRouter(fs, manifestStore, projectRoot))
  return { projectRoot, app: expressApp }
}

async function getMenuEntries(
  app: Express,
): Promise<Array<{ id: string; manifestState: string; displayName: string | null }>> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'GET', path: '/api/app/menu-entries' },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
            } catch (err) {
              reject(err)
            }
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  } finally {
    server.close()
  }
}

let savedProjectRoot: string | undefined
let savedVersion: string | undefined
let h: Harness

beforeEach(() => {
  savedProjectRoot = process.env.KOVITOBOARD_PROJECT_ROOT
  savedVersion = process.env.npm_package_version
  process.env.npm_package_version = '0.2.12-test'
  h = buildHarness()
  process.env.KOVITOBOARD_PROJECT_ROOT = h.projectRoot
  // `resolveProjectRoot` caches at module level; reset so each test's
  // fresh tmp project root is re-resolved (otherwise the first test's
  // root stays cached and later tests scan a deleted directory).
  _resetProjectRootCache()
})
afterEach(() => {
  if (savedProjectRoot === undefined) delete process.env.KOVITOBOARD_PROJECT_ROOT
  else process.env.KOVITOBOARD_PROJECT_ROOT = savedProjectRoot
  if (savedVersion === undefined) delete process.env.npm_package_version
  else process.env.npm_package_version = savedVersion
  rmSync(h.projectRoot, { recursive: true, force: true })
  _resetProjectRootCache()
})
afterAll(() => {
  delete process.env.KOVITOBOARD_PROJECT_ROOT
  delete process.env.npm_package_version
})

describe('GET /api/app/menu-entries — backfill evidence is fresh per request (codex #143 F4)', () => {
  it('honours a recipe-history row appended AFTER the router was built', async () => {
    const manifestPath = join(h.projectRoot, 'app', APP_ID, 'manifest.json')
    writeMenuTsAndPage(h.projectRoot)

    // 1st GET: no history yet, so the app is pure self-made and gets
    // backfilled (proves the happy path through the live router).
    const first = await getMenuEntries(h.app)
    const firstRow = first.find((e) => e.id === APP_ID)
    expect(firstRow?.manifestState).toBe('present')
    expect(firstRow?.displayName).toBe('Research Reports')
    expect(existsSync(manifestPath)).toBe(true)

    // Remove the backfilled manifest and append a recipe-history row
    // that binds the appId to recipe lineage (post-startup mutation).
    rmSync(manifestPath, { force: true })
    const historyRow = {
      id: 'hist-1',
      action: 'install',
      name: 'Research Reports',
      version: '1.0.0',
      source: 'import',
      hash: 'abc123',
      appliedAt: '2026-02-01T00:00:00.000Z',
      artifacts: ['pages/Index.tsx'],
      menu: [APP_ID],
      appId: APP_ID,
    }
    writeFileSync(
      join(h.projectRoot, '.kovitoboard', 'recipe-history.jsonl'),
      JSON.stringify(historyRow) + '\n',
      'utf-8',
    )

    // 2nd GET on the SAME router: if the history snapshot were captured
    // at router-construction time, the new row would be invisible and
    // the app would be backfilled again. The per-request context re-read
    // sees the row and suppresses backfill.
    const second = await getMenuEntries(h.app)
    const secondRow = second.find((e) => e.id === APP_ID)
    expect(secondRow?.manifestState).toBe('missing')
    expect(secondRow?.displayName).toBeNull()
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('fails closed and suppresses backfill when recipe-history is unreadable (codex #143 F6)', async () => {
    const manifestPath = join(h.projectRoot, 'app', APP_ID, 'manifest.json')
    writeMenuTsAndPage(h.projectRoot)

    // Make `recipe-history.jsonl` a DIRECTORY so the snapshot reader's
    // `readFileSync` throws EISDIR — an indeterminate history state
    // (cannot prove recipe evidence is absent). The fail-closed guard
    // must suppress backfill rather than treat the unreadable file as
    // "no evidence" and mis-attribute the app to user-creation.
    mkdirSync(join(h.projectRoot, '.kovitoboard', 'recipe-history.jsonl'), {
      recursive: true,
    })

    const entries = await getMenuEntries(h.app)
    const row = entries.find((e) => e.id === APP_ID)
    expect(row?.manifestState).toBe('missing')
    expect(row?.displayName).toBeNull()
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('fails closed and suppresses backfill when recipe-history is over the size cap (codex #143 F9)', async () => {
    const manifestPath = join(h.projectRoot, 'app', APP_ID, 'manifest.json')
    writeMenuTsAndPage(h.projectRoot)

    // Write a `recipe-history.jsonl` over the 10 MiB cap. The snapshot
    // loader rotates it away and returns an EMPTY snapshot — which would
    // read as "no recipe evidence" — but the rotated-away records may
    // have bound this app to recipe lineage, so absence is indeterminate
    // and the over-cap pre-check must fail closed.
    const oversizeBytes = 10 * 1024 * 1024 + 1024
    writeFileSync(
      join(h.projectRoot, '.kovitoboard', 'recipe-history.jsonl'),
      'x'.repeat(oversizeBytes),
      'utf-8',
    )

    const entries = await getMenuEntries(h.app)
    const row = entries.find((e) => e.id === APP_ID)
    expect(row?.manifestState).toBe('missing')
    expect(row?.displayName).toBeNull()
    expect(existsSync(manifestPath)).toBe(false)
  })
})
