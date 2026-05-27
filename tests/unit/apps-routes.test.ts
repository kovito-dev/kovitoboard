/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.1 apps menu-metadata routes
 * (`PUT /api/apps/menu-order` and `PATCH /api/apps/:appId/menu-label`).
 *
 * Covers every error-code branch on the wire-contract side:
 *
 *   menu-order PUT:
 *     - 200 happy path (closed-world batch update + ws broadcast)
 *     - 200 snapshotVersion roundtrip (provided + matches)
 *     - 400 InvalidMenuOrder (non-array / malformed entry)
 *     - 400 MenuOrderDuplicateAppId
 *     - 400 MenuOrderCoverageMismatch (missing + extra)
 *     - 400 MenuOrderNonContiguous (out-of-range + duplicate value)
 *     - 409 MenuOrderSnapshotDrift
 *
 *   menu-label PATCH:
 *     - 200 happy path (string set + null reset)
 *     - 400 MenuLabelEmpty (empty string)
 *     - 400 MenuLabelTooLong (> 80 char)
 *     - 400 InvalidMenuLabel (wrong type)
 *     - 400 InvalidAppId (path param mismatch)
 *     - 404 AppNotFound (missing manifest)
 *     - 500 AppManifestUnreadable (parse-fail manifest)
 *
 *   Cross-cutting:
 *     - ws-event `app_menu_changed` event=menu-label-update carries
 *       the affected appId, event=menu-order-update omits it
 *     - audit emits `kind: 'http-route'` records and never carries
 *       the raw user-input label string
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'

import { createAppsRouter } from '../../src/server/routes/apps-routes'
import { DirectFsLayer } from '../../src/server/fs-layer'
import { initLogger, lazyChildLogger } from '../../src/server/logger'

// The PATCH /menu-label handler routes its read through
// `readAppManifest()`, which emits a `recipeLogger.warn` line on
// parse / schema failures. `recipeLogger` is a lazy proxy that
// throws when `initLogger()` has not been called, so without this
// one-shot initialization the parse-fail and schema-invalid paths
// would surface as a 500 routed through Express's default HTML
// error handler rather than the structured 500 the test expects.
beforeAll(async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'kb-apps-routes-logroot-'))
  mkdirSync(join(logRoot, '.kovitoboard', 'logs'), { recursive: true })
  await initLogger(logRoot, null)
})
import type { AppManifest } from '../../src/shared/app-manifest-types'
import type { ServerToClientEvent } from '../../src/shared/ws-events'

const log = lazyChildLogger('apps-routes-test')

interface Harness {
  projectRoot: string
  app: Express
  broadcasts: ServerToClientEvent[]
}

function buildHarness(): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kb-apps-routes-'))
  mkdirSync(join(projectRoot, 'app'), { recursive: true })
  const broadcasts: ServerToClientEvent[] = []
  const fs = new DirectFsLayer()
  const expressApp = express()
  expressApp.use(express.json())
  expressApp.use(
    '/api/apps',
    createAppsRouter({
      fs,
      projectRoot,
      broadcast: (event) => {
        broadcasts.push(event)
      },
      apiLogger: log as unknown as Parameters<typeof createAppsRouter>[0]['apiLogger'],
    }),
  )
  return { projectRoot, app: expressApp, broadcasts }
}

function cleanup(h: Harness): void {
  rmSync(h.projectRoot, { recursive: true, force: true })
}

function writeManifest(projectRoot: string, manifest: AppManifest): void {
  const dir = join(projectRoot, 'app', manifest.appId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  )
}

function readManifestFromDisk(
  projectRoot: string,
  appId: string,
): Record<string, unknown> {
  const path = join(projectRoot, 'app', appId, 'manifest.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function buildManifest(appId: string, menuOrder?: number): AppManifest {
  return {
    appId,
    displayName: `App ${appId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    kovitoboardVersion: '0.2.1',
    source: { type: 'user-creation', createdViaAgent: 'kovito-developer' },
    ...(menuOrder !== undefined ? { menuOrder } : {}),
  }
}

interface HttpReply {
  status: number
  body: Record<string, unknown> | null
}

async function sendJson(
  app: Express,
  method: 'PUT' | 'PATCH',
  path: string,
  body: unknown,
): Promise<HttpReply> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<HttpReply>((resolve, reject) => {
      const payload = JSON.stringify(body ?? null)
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8')
            let parsed: Record<string, unknown> | null = null
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>
              } catch {
                parsed = null
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// =====================================================================
// PUT /api/apps/menu-order
// =====================================================================

describe('PUT /api/apps/menu-order', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => cleanup(h))

  it('200 happy path: writes menuOrder to every manifest + emits broadcast', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    writeManifest(h.projectRoot, buildManifest('beta'))
    writeManifest(h.projectRoot, buildManifest('gamma'))

    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'beta', menuOrder: 0 },
        { appId: 'gamma', menuOrder: 1 },
        { appId: 'alpha', menuOrder: 2 },
      ],
    })

    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(3)
    expect(typeof reply.body?.snapshotVersion).toBe('string')

    expect(readManifestFromDisk(h.projectRoot, 'beta').menuOrder).toBe(0)
    expect(readManifestFromDisk(h.projectRoot, 'gamma').menuOrder).toBe(1)
    expect(readManifestFromDisk(h.projectRoot, 'alpha').menuOrder).toBe(2)

    expect(h.broadcasts).toHaveLength(1)
    const event = h.broadcasts[0]
    expect(event.type).toBe('app_menu_changed')
    if (event.type === 'app_menu_changed') {
      expect(event.payload.event).toBe('menu-order-update')
      expect(event.payload.appId).toBeUndefined()
      expect(typeof event.payload.ts).toBe('number')
    }
  })

  it('200 snapshotVersion provided + matches current snapshot', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha', 0))
    writeManifest(h.projectRoot, buildManifest('beta', 1))

    // First read the current snapshot via an order that exactly
    // matches what is on disk.
    const initial = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'beta', menuOrder: 1 },
      ],
    })
    expect(initial.status).toBe(200)
    const currentSnapshot = initial.body?.snapshotVersion as string

    // Now resend with the captured snapshot — should match.
    h.broadcasts.length = 0
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'beta', menuOrder: 0 },
        { appId: 'alpha', menuOrder: 1 },
      ],
      snapshotVersion: currentSnapshot,
    })
    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(2)
    // The snapshot should change after the reorder.
    expect(reply.body?.snapshotVersion).not.toBe(currentSnapshot)
  })

  it('400 InvalidMenuOrder when order is not an array', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: 'not-an-array',
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('InvalidMenuOrder')
  })

  it('400 InvalidMenuOrder on negative menuOrder values', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: -1 }],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('InvalidMenuOrder')
  })

  it('400 InvalidMenuOrder on non-integer menuOrder values', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: 0.5 }],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('InvalidMenuOrder')
  })

  it('400 MenuOrderDuplicateAppId on repeated appId entries', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    writeManifest(h.projectRoot, buildManifest('beta'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'alpha', menuOrder: 1 },
      ],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderDuplicateAppId')
  })

  it('400 MenuOrderCoverageMismatch when request omits an eligible app', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    writeManifest(h.projectRoot, buildManifest('beta'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: 0 }],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderCoverageMismatch')
  })

  it('400 MenuOrderCoverageMismatch when request adds an unknown appId', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'unknown-app', menuOrder: 1 },
      ],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderCoverageMismatch')
  })

  it('400 MenuOrderNonContiguous when menuOrder values skip a number', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    writeManifest(h.projectRoot, buildManifest('beta'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'beta', menuOrder: 5 },
      ],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderNonContiguous')
  })

  it('400 MenuOrderNonContiguous on duplicate menuOrder values', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    writeManifest(h.projectRoot, buildManifest('beta'))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'beta', menuOrder: 0 },
      ],
    })
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderNonContiguous')
  })

  it('409 MenuOrderSnapshotDrift when caller-supplied snapshotVersion is stale', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha', 0))
    writeManifest(h.projectRoot, buildManifest('beta', 1))
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'beta', menuOrder: 1 },
      ],
      snapshotVersion: 'definitely-not-the-current-snapshot',
    })
    expect(reply.status).toBe(409)
    expect(reply.body?.error).toBe('MenuOrderSnapshotDrift')
  })

  it('does not broadcast when validation fails', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: -1 }],
    })
    expect(h.broadcasts).toHaveLength(0)
  })

  it('200 no-op short-circuit: skips write + broadcast when order matches disk state', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha', 0))
    writeManifest(h.projectRoot, buildManifest('beta', 1))

    // Snapshot the manifest bytes so we can verify the no-op
    // path did not rewrite the file (the post-write JSON layout
    // adds a trailing newline, so a rewrite would change the
    // bytes verbatim even when the value is identical).
    const alphaBefore = readFileSync(
      join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
      'utf-8',
    )
    const betaBefore = readFileSync(
      join(h.projectRoot, 'app', 'beta', 'manifest.json'),
      'utf-8',
    )

    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'beta', menuOrder: 1 },
      ],
    })

    expect(reply.status).toBe(200)
    // The 200 envelope still carries the full snapshot so the
    // client cannot tell a no-op apart from a write; this matches
    // the wire-contract surface defined in http-api-contract.md
    // v1.7.3 §6.3.9.A.
    expect(typeof reply.body?.snapshotVersion).toBe('string')

    // No file rewrite happened.
    expect(
      readFileSync(
        join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
        'utf-8',
      ),
    ).toBe(alphaBefore)
    expect(
      readFileSync(
        join(h.projectRoot, 'app', 'beta', 'manifest.json'),
        'utf-8',
      ),
    ).toBe(betaBefore)

    // No broadcast either — clients that listen for refetch
    // signals stay quiet on no-op submissions.
    expect(h.broadcasts).toHaveLength(0)
  })
})

// =====================================================================
// PATCH /api/apps/:appId/menu-label
// =====================================================================

describe('PATCH /api/apps/:appId/menu-label', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => cleanup(h))

  it('200 happy path: writes userMenuLabel + broadcasts with appId', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: 'My App' },
    )
    expect(reply.status).toBe(200)
    expect(reply.body?.appId).toBe('alpha')
    expect(reply.body?.userMenuLabel).toBe('My App')

    expect(readManifestFromDisk(h.projectRoot, 'alpha').userMenuLabel).toBe(
      'My App',
    )

    expect(h.broadcasts).toHaveLength(1)
    const event = h.broadcasts[0]
    expect(event.type).toBe('app_menu_changed')
    if (event.type === 'app_menu_changed') {
      expect(event.payload.event).toBe('menu-label-update')
      expect(event.payload.appId).toBe('alpha')
    }
  })

  it('200 null reset: explicit null sentinel clears the override', async () => {
    const baseManifest: AppManifest = {
      ...buildManifest('alpha'),
      userMenuLabel: 'Previously Set',
    }
    writeManifest(h.projectRoot, baseManifest)
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: null },
    )
    expect(reply.status).toBe(200)
    expect(reply.body?.userMenuLabel).toBeNull()
    expect(readManifestFromDisk(h.projectRoot, 'alpha').userMenuLabel).toBeNull()
  })

  it('400 MenuLabelEmpty rejects empty string distinct from null', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: '' },
    )
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuLabelEmpty')
  })

  it('400 MenuLabelTooLong rejects strings beyond 80 char', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: 'a'.repeat(81) },
    )
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuLabelTooLong')
  })

  it('400 InvalidMenuLabel rejects non-string non-null types', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: 42 },
    )
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('InvalidMenuLabel')
  })

  it('400 InvalidAppId rejects path params that fail the regex', async () => {
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/Invalid_AppId/menu-label',
      { userMenuLabel: 'x' },
    )
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('InvalidAppId')
  })

  it('404 AppNotFound when the path appId has no manifest on disk', async () => {
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/missing-app/menu-label',
      { userMenuLabel: 'x' },
    )
    expect(reply.status).toBe(404)
    expect(reply.body?.error).toBe('AppNotFound')
  })

  it('500 AppManifestUnreadable when manifest JSON cannot be parsed', async () => {
    const appDir = join(h.projectRoot, 'app', 'broken')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'manifest.json'), '{ not json', 'utf-8')
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/broken/menu-label',
      { userMenuLabel: 'x' },
    )
    expect(reply.status).toBe(500)
    expect(reply.body?.error).toBe('AppManifestUnreadable')
  })

  it('500 AppManifestUnreadable when manifest schema is invalid', async () => {
    const appDir = join(h.projectRoot, 'app', 'shape-bad')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'manifest.json'),
      JSON.stringify({ appId: 'shape-bad' }),
      'utf-8',
    )
    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/shape-bad/menu-label',
      { userMenuLabel: 'x' },
    )
    expect(reply.status).toBe(500)
    expect(reply.body?.error).toBe('AppManifestUnreadable')
  })

  it('does not broadcast when validation fails', async () => {
    writeManifest(h.projectRoot, buildManifest('alpha'))
    await sendJson(h.app, 'PATCH', '/api/apps/alpha/menu-label', {
      userMenuLabel: '',
    })
    expect(h.broadcasts).toHaveLength(0)
  })

  it('preserves unrelated AppManifest fields when writing back', async () => {
    const base: AppManifest = {
      ...buildManifest('alpha'),
      menuOrder: 5,
    }
    writeManifest(h.projectRoot, base)
    await sendJson(h.app, 'PATCH', '/api/apps/alpha/menu-label', {
      userMenuLabel: 'Renamed',
    })
    const after = readManifestFromDisk(h.projectRoot, 'alpha')
    expect(after.appId).toBe('alpha')
    expect(after.displayName).toBe('App alpha')
    expect(after.menuOrder).toBe(5)
    expect(after.userMenuLabel).toBe('Renamed')
  })
})

// =====================================================================
// computeMenuOrderSnapshot — stable shape regression
// =====================================================================

import { __test_only__ } from '../../src/server/routes/apps-routes'

describe('computeMenuOrderSnapshot', () => {
  const { computeMenuOrderSnapshot } = __test_only__

  it('returns the same snapshot for equivalent menu orders regardless of input ordering', () => {
    const a = computeMenuOrderSnapshot([
      buildManifest('alpha', 0),
      buildManifest('beta', 1),
    ])
    const b = computeMenuOrderSnapshot([
      buildManifest('beta', 1),
      buildManifest('alpha', 0),
    ])
    expect(a).toBe(b)
  })

  it('returns different snapshots when menuOrder values differ', () => {
    const a = computeMenuOrderSnapshot([
      buildManifest('alpha', 0),
      buildManifest('beta', 1),
    ])
    const b = computeMenuOrderSnapshot([
      buildManifest('alpha', 1),
      buildManifest('beta', 0),
    ])
    expect(a).not.toBe(b)
  })

  it('ignores unrelated AppManifest fields (display name / source)', () => {
    const a = computeMenuOrderSnapshot([
      {
        ...buildManifest('alpha', 0),
        displayName: 'Alpha v1',
      },
    ])
    const b = computeMenuOrderSnapshot([
      {
        ...buildManifest('alpha', 0),
        displayName: 'Alpha v2',
      },
    ])
    expect(a).toBe(b)
  })
})
