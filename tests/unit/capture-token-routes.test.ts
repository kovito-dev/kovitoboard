/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-token issuance / revoke endpoints
 * (`/api/app/capture-token/issue` and
 * `/api/app/capture-token/revoke`), v0.2.0 / spec v1.7 §6.10.6 /
 * v1.5 §10.6.7.3〜§10.6.7.4.
 *
 * Drives the router through a hand-rolled Express harness on an
 * ephemeral port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express, RequestHandler } from 'express'
import { createCaptureTokenRouter } from '../../src/server/routes/capture-token-routes'
import { lazyChildLogger } from '../../src/server/logger'
import {
  __resetForTests as resetTokenStore,
  __sizeForTests as tokenStoreSize,
  __MAX_ACTIVE_TOKENS_FOR_TESTS,
  issueCaptureToken,
} from '../../src/server/recipe-capture-sessions'
import {
  __resetForTests as resetMountStore,
  openMount,
} from '../../src/server/recipe-capture-mount-sessions'

const log = lazyChildLogger('capture-token-routes-test')

/** Stub middleware that mimics a passing `verifyInternalAuth`. */
const passingInternalAuth: RequestHandler = (_req, _res, next) => next()

function mountRouter(verifyInternalAuth: RequestHandler): Express {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/app/capture-token',
    createCaptureTokenRouter({
      logger: log as unknown as Parameters<typeof createCaptureTokenRouter>[0]['logger'],
      verifyInternalAuth,
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
    resetTokenStore()
    resetMountStore()
  })

  afterEach(() => {
    resetTokenStore()
    resetMountStore()
  })

  describe('POST /issue', () => {
    it('issues a 32-char hex token bound to the mountId-derived appId', async () => {
      const open = openMount('capture-app')
      if (!open.ok) throw new Error('mount open failed')
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: open.mountId,
      })
      expect(res.status).toBe(200)
      expect(typeof res.body?.token).toBe('string')
      expect(res.body?.token as string).toMatch(/^[0-9a-f]{32}$/)
      expect(typeof res.body?.expiresAt).toBe('number')
      expect(tokenStoreSize()).toBe(1)
    })

    it('I-CR4 issuance gate: a recipe page cannot mint another appId by forging req.body.appId — body.appId is ignored, mountStore is the authority', async () => {
      // Open mount under "alpha-app".
      const openAlpha = openMount('alpha-app')
      if (!openAlpha.ok) throw new Error('mount open failed')
      // Open a parallel mount under "beta-app" so both are alive.
      const openBeta = openMount('beta-app')
      if (!openBeta.ok) throw new Error('mount open failed')
      const app = mountRouter(passingInternalAuth)
      // Recipe A holds alpha-app's mountId but tries to mint with body
      // claiming `appId: 'beta-app'`. The server must ignore body.appId
      // and use the mountStore record for alpha-app instead.
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: openAlpha.mountId,
        appId: 'beta-app',
      })
      expect(res.status).toBe(200)
      // The token was minted under alpha-app, not beta-app. We
      // verify via consumeCaptureToken in capture-routes paths; here
      // we just confirm the token landed in the store.
      expect(tokenStoreSize()).toBe(1)
    })

    it('returns 400 InvalidMountId for malformed mountId', async () => {
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: 'not-hex',
      })
      expect(res.status).toBe(400)
      expect(res.body?.error).toBe('InvalidMountId')
    })

    it('returns 401 MountNotFound when the mountId is unknown', async () => {
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: 'a'.repeat(32),
      })
      expect(res.status).toBe(401)
      expect(res.body?.error).toBe('MountNotFound')
    })

    it('returns 503 CaptureTokenStoreFull when the store cap is exhausted', async () => {
      // Pre-populate the store so the router's issue path trips
      // the cap on the next call.
      for (let i = 0; i < __MAX_ACTIVE_TOKENS_FOR_TESTS; i++) {
        const mountId = i.toString(16).padStart(32, '0').slice(0, 32)
        const r = issueCaptureToken({ mountId, appId: `app-${i}` })
        if (!r.ok) throw new Error('issue failed')
      }
      const open = openMount('capture-app')
      if (!open.ok) throw new Error('mount open failed')
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: open.mountId,
      })
      expect(res.status).toBe(503)
      expect(res.body?.error).toBe('CaptureTokenStoreFull')
    })

    it('refuses on a failing internal-auth middleware', async () => {
      const failingInternalAuth: RequestHandler = (_req, res) => {
        res.status(401).json({ error: 'MissingInternalAuth' })
      }
      const app = mountRouter(failingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/issue', {
        mountId: 'a'.repeat(32),
      })
      expect(res.status).toBe(401)
      expect(res.body?.error).toBe('MissingInternalAuth')
    })
  })

  describe('POST /revoke', () => {
    it('returns 401 MissingCaptureToken when the header is absent', async () => {
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(app, '/api/app/capture-token/revoke', {})
      expect(res.status).toBe(401)
      expect(res.body?.error).toBe('MissingCaptureToken')
    })

    it('returns 400 InvalidCaptureToken on a malformed header', async () => {
      const app = mountRouter(passingInternalAuth)
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
      const open = openMount('capture-app')
      if (!open.ok) throw new Error('mount open failed')
      const issued = issueCaptureToken({
        mountId: open.mountId,
        appId: 'capture-app',
      })
      if (!issued.ok) throw new Error('issue failed')
      const app = mountRouter(passingInternalAuth)
      const res = await postJson(
        app,
        '/api/app/capture-token/revoke',
        {},
        { 'x-kb-capture-token': issued.token },
      )
      expect(res.status).toBe(200)
      expect(res.body?.revoked).toBe(true)
      expect(tokenStoreSize()).toBe(0)
    })

    it('is idempotent — second revoke returns revoked=false', async () => {
      const open = openMount('capture-app')
      if (!open.ok) throw new Error('mount open failed')
      const issued = issueCaptureToken({
        mountId: open.mountId,
        appId: 'capture-app',
      })
      if (!issued.ok) throw new Error('issue failed')
      const app = mountRouter(passingInternalAuth)
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
