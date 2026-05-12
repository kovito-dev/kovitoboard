/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-mount endpoints
 * (`/api/app/capture-mount/{open,close}`), v0.2.0 / spec v1.7
 * §6.10.6 / v1.5 §10.6.7.1〜§10.6.7.2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express, RequestHandler } from 'express'
import {
  createCaptureMountRouter,
  type CaptureMountManifestLookup,
} from '../../src/server/routes/capture-mount-routes'
import type { RecipeManifest } from '../../src/server/recipe/apiTypes'
import { lazyChildLogger } from '../../src/server/logger'
import {
  __resetForTests as resetMountStore,
  __sizeForTests as mountStoreSize,
  MAX_ACTIVE_MOUNTS_PER_APP,
  openMount,
} from '../../src/server/recipe-capture-mount-sessions'
import {
  __resetForTests as resetTokenStore,
  __sizeForTests as tokenStoreSize,
  issueCaptureToken,
} from '../../src/server/recipe-capture-sessions'

const log = lazyChildLogger('capture-mount-routes-test')

const passingInternalAuth: RequestHandler = (_req, _res, next) => next()

function buildManifest(override: Partial<RecipeManifest> = {}): RecipeManifest {
  return {
    appId: 'capture-app',
    recipeId: 'capture-recipe',
    recipeVersion: '1.0.0',
    hash: 'deadbeef',
    installedAt: '2026-01-01T00:00:00.000Z',
    approvedScopes: ['own-data'],
    api: { scopes: ['own-data'], calls: [] },
    captureRequires: ['a11y'],
    approvedCaptures: ['a11y'],
    trustLevel: 'unknown',
    ...override,
  }
}

function mountRouter(opts: {
  manifests: RecipeManifest[]
  verifyInternalAuth?: RequestHandler
}): Express {
  const store: CaptureMountManifestLookup = {
    get: (appId) => opts.manifests.find((m) => m.appId === appId) ?? null,
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/api/app/capture-mount',
    createCaptureMountRouter({
      manifestStore: store,
      logger: log as unknown as Parameters<typeof createCaptureMountRouter>[0]['logger'],
      verifyInternalAuth: opts.verifyInternalAuth ?? passingInternalAuth,
    }),
  )
  return app
}

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
        const req = httpRequest(
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

describe('createCaptureMountRouter', () => {
  beforeEach(() => {
    resetMountStore()
    resetTokenStore()
  })
  afterEach(() => {
    resetMountStore()
    resetTokenStore()
  })

  describe('POST /open', () => {
    it('returns 200 with a fresh mountId for a normal recipe', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(200)
      expect(typeof res.body?.mountId).toBe('string')
      expect((res.body?.mountId as string)).toMatch(/^[0-9a-f]{32}$/)
      expect(typeof res.body?.expiresAt).toBe('number')
      expect(res.body?.reason).toBeNull()
      expect(mountStoreSize()).toBe(1)
    })

    it('returns 200 with mountId=null + reason=grandfather for grandfather recipe', async () => {
      const app = mountRouter({
        manifests: [
          buildManifest({ captureRequires: [], approvedCaptures: [] }),
        ],
      })
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(200)
      expect(res.body?.mountId).toBeNull()
      expect(res.body?.expiresAt).toBeNull()
      expect(res.body?.reason).toBe('grandfather-no-capture')
      // Grandfather skip does not occupy a slot.
      expect(mountStoreSize()).toBe(0)
    })

    it('returns 400 InvalidAppId on a malformed appId', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'INVALID UPPER',
      })
      expect(res.status).toBe(400)
      expect(res.body?.error).toBe('InvalidAppId')
    })

    it('returns 404 NoMatchingManifest when the appId is unknown', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'unknown-app',
      })
      expect(res.status).toBe(404)
      expect(res.body?.error).toBe('NoMatchingManifest')
    })

    it('returns 503 MountQuotaPerAppExceeded at the per-app cap', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      // Pre-fill the per-app cap directly via the library so the
      // route only has to make the 9th attempt.
      for (let i = 0; i < MAX_ACTIVE_MOUNTS_PER_APP; i++) {
        expect(openMount('capture-app').ok).toBe(true)
      }
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(503)
      expect(res.body?.error).toBe('MountQuotaPerAppExceeded')
      expect(
        (res.body?.details as Record<string, unknown>).currentLimit,
      ).toBe(MAX_ACTIVE_MOUNTS_PER_APP)
    })

    it('routes through verifyInternalAuth — a failing middleware refuses with 401', async () => {
      const failingAuth: RequestHandler = (_req, res) => {
        res.status(401).json({ error: 'MissingInternalAuth' })
      }
      const app = mountRouter({
        manifests: [buildManifest()],
        verifyInternalAuth: failingAuth,
      })
      const res = await postJson(app, '/api/app/capture-mount/open', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /close', () => {
    it('returns 200 ok=true closed=true for a live mount and drops the token', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const opened = openMount('capture-app')
      if (!opened.ok) throw new Error('openMount failed')
      // Bind a token to the mount so we can verify the atomic drop.
      const issued = issueCaptureToken({
        mountId: opened.mountId,
        appId: 'capture-app',
      })
      if (!issued.ok) throw new Error('issueCaptureToken failed')
      expect(tokenStoreSize()).toBe(1)
      const res = await postJson(app, '/api/app/capture-mount/close', {
        mountId: opened.mountId,
      })
      expect(res.status).toBe(200)
      expect(res.body?.ok).toBe(true)
      expect(res.body?.closed).toBe(true)
      // H-CR4 atomicity: mount + token both gone.
      expect(mountStoreSize()).toBe(0)
      expect(tokenStoreSize()).toBe(0)
    })

    it('is idempotent — second close returns closed=false', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const opened = openMount('capture-app')
      if (!opened.ok) throw new Error('openMount failed')
      await postJson(app, '/api/app/capture-mount/close', {
        mountId: opened.mountId,
      })
      const second = await postJson(app, '/api/app/capture-mount/close', {
        mountId: opened.mountId,
      })
      expect(second.status).toBe(200)
      expect(second.body?.closed).toBe(false)
    })

    it('returns 400 InvalidMountId on malformed mountId', async () => {
      const app = mountRouter({ manifests: [buildManifest()] })
      const res = await postJson(app, '/api/app/capture-mount/close', {
        mountId: 'not-hex',
      })
      expect(res.status).toBe(400)
      expect(res.body?.error).toBe('InvalidMountId')
    })
  })
})
