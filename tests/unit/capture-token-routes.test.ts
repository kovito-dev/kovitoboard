/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-token issuance / revoke endpoints
 * (`/api/app/capture-token/issue` and
 * `/api/app/capture-token/revoke`), v0.2.0 / spec v1.4 §10.6.7.
 *
 * Drives the router through a hand-rolled Express harness on an
 * ephemeral port — same shape as `tests/unit/capture-routes.test.ts`
 * so the suite stays free of supertest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'
import {
  createCaptureTokenRouter,
  type CaptureTokenManifestLookup,
} from '../../src/server/routes/capture-token-routes'
import type { RecipeManifest } from '../../src/server/recipe/apiTypes'
import { lazyChildLogger } from '../../src/server/logger'
import {
  __resetForTests,
  __sizeForTests,
  __MAX_ACTIVE_TOKENS_FOR_TESTS,
  issueCaptureToken,
} from '../../src/server/recipe-capture-sessions'

const log = lazyChildLogger('capture-token-routes-test')

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

function mountRouter(manifest: RecipeManifest | null): Express {
  const store: CaptureTokenManifestLookup = {
    get: (appId) => (manifest && manifest.appId === appId ? manifest : null),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/api/app/capture-token',
    createCaptureTokenRouter({
      manifestStore: store,
      logger: log as unknown as Parameters<typeof createCaptureTokenRouter>[0]['logger'],
    }),
  )
  return app
}

async function postJson(
  app: Express,
  path: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
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
              ...headers,
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

describe('createCaptureTokenRouter', () => {
  beforeEach(() => {
    __resetForTests()
  })

  afterEach(() => {
    __resetForTests()
  })

  describe('POST /issue', () => {
    it('issues a 32-char hex token bound to the manifest appId', async () => {
      const app = mountRouter(buildManifest())
      const res = await postJson(app, '/api/app/capture-token/issue', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(200)
      expect(typeof res.body?.token).toBe('string')
      expect(res.body?.token as string).toMatch(/^[0-9a-f]{32}$/)
      expect(typeof res.body?.expiresAt).toBe('number')
      expect(res.body?.reason).toBeNull()
      expect(__sizeForTests()).toBe(1)
    })

    it('returns a grandfather skip when manifest.captureRequires is empty', async () => {
      const app = mountRouter(
        buildManifest({ captureRequires: [], approvedCaptures: [] }),
      )
      const res = await postJson(app, '/api/app/capture-token/issue', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(200)
      expect(res.body?.token).toBeNull()
      expect(res.body?.expiresAt).toBeNull()
      expect(res.body?.reason).toBe('grandfather-no-capture')
      expect(__sizeForTests()).toBe(0)
    })

    it('returns 400 InvalidAppId for malformed appId', async () => {
      const app = mountRouter(buildManifest())
      const res = await postJson(app, '/api/app/capture-token/issue', {
        appId: 'INVALID UPPER',
      })
      expect(res.status).toBe(400)
      expect(res.body?.error).toBe('InvalidAppId')
    })

    it('returns 404 NoMatchingManifest when appId resolves to no manifest', async () => {
      const app = mountRouter(buildManifest())
      const res = await postJson(app, '/api/app/capture-token/issue', {
        appId: 'unknown-app',
      })
      expect(res.status).toBe(404)
      expect(res.body?.error).toBe('NoMatchingManifest')
    })

    it('returns 503 CaptureTokenStoreFull when the store cap is exhausted', async () => {
      // Pre-populate the store so the router's issue path trips
      // the cap on the next call.
      for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
        const result = issueCaptureToken(`app-${i}`)
        expect(result.ok).toBe(true)
      }
      const app = mountRouter(buildManifest())
      const res = await postJson(app, '/api/app/capture-token/issue', {
        appId: 'capture-app',
      })
      expect(res.status).toBe(503)
      expect(res.body?.error).toBe('CaptureTokenStoreFull')
      expect(
        (res.body?.details as Record<string, unknown>).maxActiveTokens,
      ).toBe(__MAX_ACTIVE_TOKENS_FOR_TESTS)
    })
  })

  describe('POST /revoke', () => {
    it('returns 401 MissingCaptureToken when the header is absent', async () => {
      const app = mountRouter(buildManifest())
      const res = await postJson(app, '/api/app/capture-token/revoke', {})
      expect(res.status).toBe(401)
      expect(res.body?.error).toBe('MissingCaptureToken')
    })

    it('returns 400 InvalidCaptureToken on a malformed header', async () => {
      const app = mountRouter(buildManifest())
      const res = await postJson(
        app,
        '/api/app/capture-token/revoke',
        {},
        { 'x-kb-capture-token': 'not-hex' },
      )
      expect(res.status).toBe(400)
      expect(res.body?.error).toBe('InvalidCaptureToken')
    })

    it('revokes a live token and reports revoked=true', async () => {
      const app = mountRouter(buildManifest())
      const issued = issueCaptureToken('capture-app')
      if (!issued.ok) throw new Error('issue failed')
      const res = await postJson(
        app,
        '/api/app/capture-token/revoke',
        {},
        { 'x-kb-capture-token': issued.token },
      )
      expect(res.status).toBe(200)
      expect(res.body?.revoked).toBe(true)
      expect(__sizeForTests()).toBe(0)
    })

    it('is idempotent — second revoke returns revoked=false', async () => {
      const app = mountRouter(buildManifest())
      const issued = issueCaptureToken('capture-app')
      if (!issued.ok) throw new Error('issue failed')
      await postJson(
        app,
        '/api/app/capture-token/revoke',
        {},
        { 'x-kb-capture-token': issued.token },
      )
      const second = await postJson(
        app,
        '/api/app/capture-token/revoke',
        {},
        { 'x-kb-capture-token': issued.token },
      )
      expect(second.status).toBe(200)
      expect(second.body?.revoked).toBe(false)
    })
  })
})
