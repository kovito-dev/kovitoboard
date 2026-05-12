/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.0 capture endpoint router
 * (`/api/app/capture/<kind>`).
 *
 * The router runs the 5-step verification flow from
 * `http-api-contract.md` v1.3 §10.6.3: invalid kind → 403
 * CaptureNotDeclared, missing/unresolvable appId → 403
 * NoActiveRecipe, manifest without the kind in approvedCaptures →
 * 403 CaptureNotApproved, otherwise 204. Each path is exercised
 * here via a hand-rolled Express harness so the asserts stay
 * focused on the router contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'
import {
  createCaptureRouter,
  type CaptureManifestLookup,
} from '../../src/server/routes/capture-routes'
import type { RecipeManifest } from '../../src/server/recipe/apiTypes'
import { lazyChildLogger } from '../../src/server/logger'

const log = lazyChildLogger('capture-routes-test')

function buildManifest(override: Partial<RecipeManifest> = {}): RecipeManifest {
  return {
    appId: 'capture-app',
    recipeId: 'capture-recipe',
    recipeVersion: '1.0.0',
    hash: 'deadbeef',
    installedAt: '2026-01-01T00:00:00.000Z',
    approvedScopes: ['own-data'],
    api: { scopes: ['own-data'], calls: [] },
    approvedCaptures: ['a11y'],
    trustLevel: 'unknown',
    ...override,
  }
}

function mountRouter(opts: {
  manifest: RecipeManifest | null
  projectRoot: string
}): Express {
  const store: CaptureManifestLookup = {
    get: (appId) => (opts.manifest && opts.manifest.appId === appId ? opts.manifest : null),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/api/app/capture',
    createCaptureRouter({
      manifestStore: store,
      projectRoot: opts.projectRoot,
      // The `RendererLogger`-like shape on the server side is a pino
      // child; lazyChildLogger satisfies the same surface for the
      // router's info / warn calls.
      logger: log as unknown as Parameters<typeof createCaptureRouter>[0]['logger'],
    }),
  )
  return app
}

/**
 * Spin up the Express app on an ephemeral port and POST a JSON body
 * to it via Node's built-in http client. Keeps the test suite free
 * of supertest while still exercising the router through real
 * HTTP — Express handler short-circuits (e.g. JSON parser errors)
 * therefore surface the way they would in production.
 */
async function postJson(
  app: Express,
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<{ status: number; body: Record<string, unknown> | null }>(
      (resolve, reject) => {
        const payload = JSON.stringify(body ?? {})
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
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
      },
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('createCaptureRouter', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-capture-router-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('returns 204 when the active recipe approved the kind', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(204)
  })

  it('returns 403 CaptureNotApproved when the kind is not in approvedCaptures', async () => {
    const app = mountRouter({
      manifest: buildManifest({ approvedCaptures: [] }),
      projectRoot,
    })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotApproved')
  })

  it('treats grandfather (trustLevel=unknown + empty approvedCaptures) as a grandfather refusal', async () => {
    const app = mountRouter({
      manifest: buildManifest({
        trustLevel: 'unknown',
        approvedCaptures: [],
      }),
      projectRoot,
    })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotApproved')
    expect((res.body?.details as Record<string, unknown>).trustLevel).toBe('unknown')
    expect(String((res.body?.details as Record<string, unknown>).remediation)).toMatch(
      /Grandfather recipe/,
    )
  })

  it('returns 403 NoActiveRecipe when appId is missing', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {})
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
  })

  it('returns 403 NoActiveRecipe when the appId does not resolve to a manifest', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'unknown-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
  })

  it('returns 403 CaptureNotDeclared on an unknown kind path segment', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/camera', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
  })
})
