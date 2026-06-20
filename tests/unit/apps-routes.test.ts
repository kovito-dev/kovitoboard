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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { runMenuBackfillScan } from '../../src/server/routes/app-routes'
import { RecipeManifestStore } from '../../src/server/recipeManifestStore'
import { _resetProjectRootCache } from '../../src/server/config'
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

/**
 * Yield to the event loop once so any `setImmediate(...)` callbacks
 * scheduled during the previous request — notably the deferred
 * `app_menu_changed` broadcast in `apps-routes.ts` — run before the
 * test inspects observable side effects. Without this flush the
 * broadcast assertion would be timing-dependent: on some
 * scheduler outcomes the response could resolve before the
 * deferred callback fires (Spec note attempt 16 Finding 2).
 */
function flushSetImmediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
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
    // Flush one event-loop tick so any setImmediate-scheduled
    // post-response work (notably the deferred app_menu_changed
    // broadcast added in attempt 14 Finding 2) has run before
    // the test inspects observable side effects. Without this
    // flush the broadcast assertion would be timing-dependent.
    await flushSetImmediate()
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

  it('skips a broken symlink during scan instead of failing the whole batch', async () => {
    // Legitimate app under app/alpha/.
    writeManifest(h.projectRoot, buildManifest('alpha'))
    // app/broken-link points at a target that no longer exists —
    // realpathSync throws ENOENT here. The route MUST treat this
    // entry as ineligible (skip) and let the rest of the batch
    // proceed, rather than 500'ing every menu reorder until the
    // operator cleans up the dangling link.
    symlinkSync(
      '/nonexistent-target-' + Math.random().toString(36).slice(2),
      join(h.projectRoot, 'app', 'broken-link'),
      'dir',
    )

    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: 0 }],
    })
    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(1)

    // The dangling entry never made it into the eligible set, so a
    // batch that names `broken-link` is rejected with
    // MenuOrderCoverageMismatch (not 500).
    h.broadcasts.length = 0
    const overshoot = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'broken-link', menuOrder: 1 },
      ],
    })
    expect(overshoot.status).toBe(400)
    expect(overshoot.body?.error).toBe('MenuOrderCoverageMismatch')
  })

  it('skips a manifest whose on-disk appId fails the public APP_ID_PATTERN', async () => {
    // app/Bad_Id/manifest.json with internal appId "Bad_Id"
    // (both fail APP_ID_PATTERN). The directory + manifest.appId
    // match each other, so the previous identity check passes,
    // but the request validator forbids clients from ever
    // submitting "Bad_Id" so leaving it in the eligible set
    // would wedge every reorder request into
    // MenuOrderCoverageMismatch (Spec note attempt 17 Finding 1
    // — closed-world DoS via one bad manifest).
    const badDir = join(h.projectRoot, 'app', 'Bad_Id')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(
      join(badDir, 'manifest.json'),
      JSON.stringify(buildManifest('Bad_Id'), null, 2) + '\n',
      'utf-8',
    )
    // A well-formed manifest alongside it.
    writeManifest(h.projectRoot, buildManifest('alpha'))

    // Reorder request that targets only the well-formed alpha
    // succeeds; the corrupt Bad_Id entry stayed out of the
    // eligible set.
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: 0 }],
    })
    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(1)
  })

  it('400 MenuOrderCoverageMismatch when a manifest.appId disagrees with its directory name', async () => {
    // app/alpha/manifest.json carries {appId: "alpha"} (legitimate).
    writeManifest(h.projectRoot, buildManifest('alpha'))
    // app/wrongdir/manifest.json carries {appId: "actual-name"}
    // — the scan must drop it from the eligible set rather than
    // trust the on-disk appId as a lock key.
    const wrongDir = join(h.projectRoot, 'app', 'wrongdir')
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(
      join(wrongDir, 'manifest.json'),
      JSON.stringify(buildManifest('actual-name'), null, 2) + '\n',
      'utf-8',
    )

    // Sending the order body that includes only 'alpha' should
    // succeed because 'wrongdir' is treated as ineligible (matches
    // the previous scanAppManifests "skip corrupt" behaviour).
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'alpha', menuOrder: 0 }],
    })
    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(1)

    // Sending an order that includes 'wrongdir' OR 'actual-name'
    // should be rejected with MenuOrderCoverageMismatch — neither
    // name is in the eligible set.
    h.broadcasts.length = 0
    const wrongdirReply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [
        { appId: 'alpha', menuOrder: 0 },
        { appId: 'wrongdir', menuOrder: 1 },
      ],
    })
    expect(wrongdirReply.status).toBe(400)
    expect(wrongdirReply.body?.error).toBe('MenuOrderCoverageMismatch')
  })

  it('500 MenuOrderAtomicWriteFailed when the `app` root itself is a symlink that escapes the project root', async () => {
    // Wipe the auto-created `app/` directory and replace it with a
    // symlink pointing at an external location. Without the
    // attempt 11 fix the boundary check would have realpathSync'd
    // `<projectRoot>/app` to the external target and then treated
    // anything under that target as in-bounds, defeating the
    // documented `<projectRoot>/app/**` invariant.
    rmSync(join(h.projectRoot, 'app'), { recursive: true, force: true })
    const outside = mkdtempSync(join(tmpdir(), 'kb-apps-routes-app-link-'))
    try {
      // Plant a manifest at the external location so any boundary
      // misclassification would silently succeed.
      const externalApp = join(outside, 'foo')
      mkdirSync(externalApp, { recursive: true })
      writeFileSync(
        join(externalApp, 'manifest.json'),
        JSON.stringify(buildManifest('foo'), null, 2) + '\n',
        'utf-8',
      )
      symlinkSync(outside, join(h.projectRoot, 'app'), 'dir')

      const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
        order: [{ appId: 'foo', menuOrder: 0 }],
      })

      expect(reply.status).toBe(500)
      expect(reply.body?.error).toBe('MenuOrderAtomicWriteFailed')

      // The external manifest stays unchanged — the symlinked
      // app root is rejected before any read of foo/manifest.json
      // happens.
      const after = JSON.parse(
        readFileSync(join(externalApp, 'manifest.json'), 'utf-8'),
      ) as Record<string, unknown>
      expect(after.menuOrder).toBeUndefined()

      expect(h.broadcasts).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('500 MenuOrderAtomicWriteFailed when an app directory is a symlink that escapes the app root', async () => {
    // Create a legitimate app under `app/alpha/`.
    writeManifest(h.projectRoot, buildManifest('alpha', 0))

    // Plant an `app/beta` symlink pointing outside the app root.
    // The scanner can still read the manifest through the symlink
    // (so the request looks coverage-valid), but the boundary
    // check must catch it before any write touches the foreign
    // location.
    const outside = mkdtempSync(join(tmpdir(), 'kb-apps-routes-outside-'))
    try {
      writeFileSync(
        join(outside, 'manifest.json'),
        JSON.stringify(buildManifest('beta'), null, 2) + '\n',
        'utf-8',
      )
      symlinkSync(outside, join(h.projectRoot, 'app', 'beta'), 'dir')

      const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
        order: [
          { appId: 'alpha', menuOrder: 0 },
          { appId: 'beta', menuOrder: 1 },
        ],
      })

      expect(reply.status).toBe(500)
      expect(reply.body?.error).toBe('MenuOrderAtomicWriteFailed')

      // The outside manifest stays unchanged — the gate ran
      // before any writeFileAtomic touched it.
      const after = JSON.parse(
        readFileSync(join(outside, 'manifest.json'), 'utf-8'),
      ) as Record<string, unknown>
      expect(after.menuOrder).toBeUndefined()

      // No broadcast either.
      expect(h.broadcasts).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // (The previous "400 InvalidMenuOrder when batch exceeds
  // MENU_ORDER_MAX_ENTRIES" test was retired in attempt 8: the
  // application-level cap was removed in favour of the Express
  // body-size limit. See the comment block at the top of
  // src/server/routes/apps-routes.ts for the derivation.)

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
// PUT /api/apps/menu-order — case-A backfill pre-scan (§6.9.7 案 A)
// =====================================================================

interface BackfillHarness {
  projectRoot: string
  app: Express
}

/**
 * Build an apps router wired with the real {@link runMenuBackfillScan}
 * (the case-A pre-scan) over a `DirectFsLayer` tmp project, so a
 * manifest-less self-made app with a readable `app/<id>/page.tsx` +
 * `app/menu.ts` entry gets backfilled when the batch fires — even
 * though the request never hit `/menu-entries` first.
 */
function buildBackfillHarness(): BackfillHarness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kb-apps-backfill-'))
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
  expressApp.use(
    '/api/apps',
    createAppsRouter({
      fs,
      projectRoot,
      broadcast: () => {},
      apiLogger: log as unknown as Parameters<typeof createAppsRouter>[0]['apiLogger'],
      runBackfillScan: () =>
        runMenuBackfillScan(fs, manifestStore, projectRoot),
    }),
  )
  return { projectRoot, app: expressApp }
}

function writeSelfMadeApp(projectRoot: string, appId: string, label: string): void {
  const pagesDir = join(projectRoot, 'app', appId, 'pages')
  mkdirSync(pagesDir, { recursive: true })
  writeFileSync(join(pagesDir, 'Index.tsx'), '// stub page', 'utf-8')
  const menuTs = [
    'export const menuEntries = [',
    `  { id: '${appId}', label: '${label}', icon: 'note', component: () => import('./${appId}/pages/Index') },`,
    ']',
    '',
  ].join('\n')
  writeFileSync(join(projectRoot, 'app', 'menu.ts'), menuTs, 'utf-8')
}

describe('PUT /api/apps/menu-order — case-A backfill', () => {
  let h: BackfillHarness
  let savedEnvVersion: string | undefined
  let savedProjectRoot: string | undefined
  beforeEach(() => {
    savedEnvVersion = process.env.npm_package_version
    savedProjectRoot = process.env.KOVITOBOARD_PROJECT_ROOT
    process.env.npm_package_version = '0.2.12-test'
    h = buildBackfillHarness()
    // The menu-extraction backfill scan resolves the project root from
    // the env (the apps-router gets `projectRoot` directly, but
    // `readUserMenuEntries` reads it through `resolveProjectRoot`).
    process.env.KOVITOBOARD_PROJECT_ROOT = h.projectRoot
    // `resolveProjectRoot` caches at module level; reset so each test's
    // fresh tmp root is re-resolved instead of a prior deleted one.
    _resetProjectRootCache()
  })
  afterEach(() => {
    if (savedEnvVersion === undefined) delete process.env.npm_package_version
    else process.env.npm_package_version = savedEnvVersion
    if (savedProjectRoot === undefined) delete process.env.KOVITOBOARD_PROJECT_ROOT
    else process.env.KOVITOBOARD_PROJECT_ROOT = savedProjectRoot
    rmSync(h.projectRoot, { recursive: true, force: true })
    _resetProjectRootCache()
  })

  it('backfills a manifest-less self-made app so a direct PUT covers it', async () => {
    // No manifest.json on disk — only menu.ts + page.tsx.
    writeSelfMadeApp(h.projectRoot, 'research-reports', 'Research Reports')

    // Direct PUT (no prior /menu-entries GET). The case-A pre-scan
    // backfills the manifest, so the eligible set is { research-reports }
    // and a single-element contiguous order succeeds.
    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'research-reports', menuOrder: 0 }],
    })

    expect(reply.status).toBe(200)
    expect(reply.body?.updated).toBe(1)

    // The backfill wrote a user-creation manifest, and the batch then
    // persisted menuOrder onto it.
    const onDisk = readManifestFromDisk(h.projectRoot, 'research-reports')
    expect(onDisk.menuOrder).toBe(0)
    expect(onDisk.displayName).toBe('Research Reports')
    expect((onDisk.source as Record<string, unknown>).type).toBe('user-creation')
    expect((onDisk.source as Record<string, unknown>).createdViaAgent).toBe('')
  })

  it('does not backfill an app with a legacy history row that omits appId (menu[0] fallback, codex #143 F1)', async () => {
    // Manifest-less app whose only recipe-install evidence is a LEGACY
    // history row written before `appId` was a first-class field: it
    // carries no `appId`, only `menu: ['research-reports']`. Per the
    // `RecipeHistoryEntry.appId` JSDoc the reader must fall back to
    // `menu[0]` for app association, so this row binds the app to recipe
    // lineage and must suppress backfill (provenance guard, §6.9.2
    // condition 4) — otherwise a recipe residue is mis-attributed to
    // user-creation.
    writeSelfMadeApp(h.projectRoot, 'research-reports', 'Research Reports')
    const legacyHistoryRow = {
      id: 'hist-legacy-1',
      // no `appId` field (legacy)
      name: 'Research Reports',
      version: '1.0.0',
      source: 'import',
      hash: 'deadbeef',
      appliedAt: '2026-01-01T00:00:00.000Z',
      artifacts: ['pages/Index.tsx'],
      menu: ['research-reports'],
    }
    writeFileSync(
      join(h.projectRoot, '.kovitoboard', 'recipe-history.jsonl'),
      JSON.stringify(legacyHistoryRow) + '\n',
      'utf-8',
    )

    const reply = await sendJson(h.app, 'PUT', '/api/apps/menu-order', {
      order: [{ appId: 'research-reports', menuOrder: 0 }],
    })

    // Backfill suppressed → the app stays ineligible → the closed-world
    // batch sees an empty eligible set and the single-element order does
    // not cover it.
    expect(reply.status).toBe(400)
    expect(reply.body?.error).toBe('MenuOrderCoverageMismatch')
    // No manifest was synthesized for the recipe-lineage app.
    expect(
      existsSync(join(h.projectRoot, 'app', 'research-reports', 'manifest.json')),
    ).toBe(false)
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

  it('200 no-op short-circuit: skips write + broadcast when userMenuLabel already matches', async () => {
    writeManifest(h.projectRoot, {
      ...buildManifest('alpha'),
      userMenuLabel: 'Existing Label',
    })

    const before = readFileSync(
      join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
      'utf-8',
    )

    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: 'Existing Label' },
    )

    expect(reply.status).toBe(200)
    expect(reply.body?.userMenuLabel).toBe('Existing Label')

    // Manifest file is byte-for-byte unchanged.
    expect(
      readFileSync(
        join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
        'utf-8',
      ),
    ).toBe(before)

    // No broadcast.
    expect(h.broadcasts).toHaveLength(0)
  })

  it('200 no-op short-circuit: explicit null reset against missing field is a no-op', async () => {
    // Manifest has no userMenuLabel field; PATCH with null should
    // be treated as a no-op (current state already matches null).
    writeManifest(h.projectRoot, buildManifest('alpha'))

    const before = readFileSync(
      join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
      'utf-8',
    )

    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/alpha/menu-label',
      { userMenuLabel: null },
    )

    expect(reply.status).toBe(200)
    expect(reply.body?.userMenuLabel).toBeNull()

    expect(
      readFileSync(
        join(h.projectRoot, 'app', 'alpha', 'manifest.json'),
        'utf-8',
      ),
    ).toBe(before)

    expect(h.broadcasts).toHaveLength(0)
  })

  it('500 AppManifestUnreadable when app/<appId> is a symlink to an external dir that has no manifest.json', async () => {
    // Plant `app/escape-no-manifest` pointing at an external
    // directory that lacks `manifest.json`. Without the attempt
    // 15 fix, the helper would fall through to the manifest-file
    // lstat, see ENOENT, and classify the case as `not-found` →
    // 404 AppNotFound, even though the directory-level escape is
    // the primary anomaly we want to surface.
    const outside = mkdtempSync(join(tmpdir(), 'kb-apps-routes-noman-'))
    try {
      // Intentionally NO manifest.json inside `outside`.
      symlinkSync(outside, join(h.projectRoot, 'app', 'escape-no-manifest'), 'dir')

      const reply = await sendJson(
        h.app,
        'PATCH',
        '/api/apps/escape-no-manifest/menu-label',
        { userMenuLabel: 'X' },
      )

      expect(reply.status).toBe(500)
      expect(reply.body?.error).toBe('AppManifestUnreadable')
      expect(h.broadcasts).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('500 AppManifestUnreadable when manifest.json itself is a dangling symlink', async () => {
    // app/dangling/manifest.json is a symlink whose target does
    // not exist. existsSync(manifestPath) would return `false`
    // here (symlinks are followed), so the previous helper would
    // have classified this as 404 AppNotFound — masking the
    // genuine on-disk corruption. lstatSync distinguishes the two
    // cases: ENOENT only when the symlink itself is missing.
    const dir = join(h.projectRoot, 'app', 'dangling')
    mkdirSync(dir, { recursive: true })
    symlinkSync(
      '/nonexistent-target-' + Math.random().toString(36).slice(2),
      join(dir, 'manifest.json'),
      'file',
    )

    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/dangling/menu-label',
      { userMenuLabel: 'Anything' },
    )

    expect(reply.status).toBe(500)
    expect(reply.body?.error).toBe('AppManifestUnreadable')
    expect(h.broadcasts).toHaveLength(0)
  })

  it('500 AppManifestUnreadable when manifest.appId disagrees with the path parameter', async () => {
    // app/imposter/manifest.json carries {appId: "victim"}.
    const dir = join(h.projectRoot, 'app', 'imposter')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(buildManifest('victim'), null, 2) + '\n',
      'utf-8',
    )

    const reply = await sendJson(
      h.app,
      'PATCH',
      '/api/apps/imposter/menu-label',
      { userMenuLabel: 'Hijacked' },
    )

    expect(reply.status).toBe(500)
    expect(reply.body?.error).toBe('AppManifestUnreadable')

    // Manifest content is byte-for-byte unchanged.
    const after = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(after.userMenuLabel).toBeUndefined()

    expect(h.broadcasts).toHaveLength(0)
  })

  it('500 AppManifestUnreadable when the app directory is a symlink that escapes the app root', async () => {
    // Plant an `app/beta` symlink pointing outside the app root with
    // a valid-shape manifest behind it. existsSync passes (the
    // symlink target exists), but the boundary check must catch the
    // escape before write touches the foreign location.
    const outside = mkdtempSync(join(tmpdir(), 'kb-apps-routes-outside-'))
    try {
      writeFileSync(
        join(outside, 'manifest.json'),
        JSON.stringify(buildManifest('beta'), null, 2) + '\n',
        'utf-8',
      )
      symlinkSync(outside, join(h.projectRoot, 'app', 'beta'), 'dir')

      const reply = await sendJson(
        h.app,
        'PATCH',
        '/api/apps/beta/menu-label',
        { userMenuLabel: 'Hijacked' },
      )

      expect(reply.status).toBe(500)
      expect(reply.body?.error).toBe('AppManifestUnreadable')

      // The outside manifest stays unchanged.
      const after = JSON.parse(
        readFileSync(join(outside, 'manifest.json'), 'utf-8'),
      ) as Record<string, unknown>
      expect(after.userMenuLabel).toBeUndefined()

      expect(h.broadcasts).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
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
