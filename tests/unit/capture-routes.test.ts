/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.0 capture endpoint router
 * (`/api/app/capture/<kind>`) — v1.5 shape.
 *
 * The router runs the 5-step verification flow from
 * `http-api-contract.md` v1.3.1 §10.6.3 with independent step 3
 * (`captureRequires`) and step 4 (`approvedCaptures`) per
 * invariant I-CR3:
 *
 *   - unknown literal kind path segment → 403 CaptureNotDeclared
 *   - missing / malformed appId → 403 NoActiveRecipe (reason: unresolved-appid)
 *   - unknown appId → 403 NoActiveRecipe (reason: no-active-recipe)
 *   - kind missing from manifest.captureRequires → 403 CaptureNotDeclared
 *   - kind missing from manifest.approvedCaptures → 403 CaptureNotApproved
 *   - otherwise 204
 *
 * Each refusal also emits a capture-audit entry routed to either
 * the per-app sink or the global sink at
 * `app/_unresolved-capture-audit.log`. The tests verify the file
 * contents to ensure the audit trail captures all 5 reasons.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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
    captureRequires: ['a11y'],
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

function readPerAppAuditEntries(
  projectRoot: string,
  appId: string,
): Array<Record<string, unknown>> {
  const path = join(projectRoot, 'app', 'data', appId, '_capture-audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function readUnresolvedAuditEntries(
  projectRoot: string,
): Array<Record<string, unknown>> {
  const path = join(projectRoot, 'app', '_unresolved-capture-audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createCaptureRouter', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-capture-router-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('returns 204 when both captureRequires and approvedCaptures contain the kind', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(204)
    const entries = readPerAppAuditEntries(projectRoot, 'capture-app')
    expect(entries).toHaveLength(1)
    expect(entries[0].reason).toBe('approved')
    expect(entries[0].trustLevel).toBe('unknown')
  })

  it('returns 403 CaptureNotDeclared when the kind is missing from captureRequires (step 3)', async () => {
    const app = mountRouter({
      manifest: buildManifest({
        captureRequires: ['exposed-context'],
        approvedCaptures: [],
      }),
      projectRoot,
    })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('not-declared')
    const entries = readPerAppAuditEntries(projectRoot, 'capture-app')
    expect(entries.at(-1)?.reason).toBe('not-declared')
  })

  it('returns 403 CaptureNotApproved when the kind is declared but not approved (step 4)', async () => {
    const app = mountRouter({
      manifest: buildManifest({
        captureRequires: ['a11y'],
        approvedCaptures: [],
      }),
      projectRoot,
    })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotApproved')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('not-approved')
    const entries = readPerAppAuditEntries(projectRoot, 'capture-app')
    expect(entries.at(-1)?.reason).toBe('not-approved')
  })

  it('treats grandfather (captureRequires empty + approvedCaptures empty) as CaptureNotDeclared', async () => {
    const app = mountRouter({
      manifest: buildManifest({
        trustLevel: 'unknown',
        captureRequires: [],
        approvedCaptures: [],
      }),
      projectRoot,
    })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
    expect((res.body?.details as Record<string, unknown>).trustLevel).toBe('unknown')
    expect(
      String((res.body?.details as Record<string, unknown>).remediation),
    ).toMatch(/Grandfather recipe/)
  })

  it('returns 403 NoActiveRecipe (unresolved-appid) when appId is missing', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {})
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('unresolved-appid')
    // Unresolved entries land in the global sink because no appId
    // could be tied to the request.
    const entries = readUnresolvedAuditEntries(projectRoot)
    expect(entries.at(-1)?.reason).toBe('unresolved-appid')
    expect(entries.at(-1)?.appId).toBeNull()
  })

  it('returns 403 NoActiveRecipe (no-active-recipe) when appId does not resolve to a manifest', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/a11y', {
      appId: 'unknown-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('no-active-recipe')
    const entries = readUnresolvedAuditEntries(projectRoot)
    expect(entries.at(-1)?.reason).toBe('no-active-recipe')
    expect(entries.at(-1)?.appId).toBeNull()
  })

  it('returns 403 CaptureNotDeclared on an unknown literal kind path segment', async () => {
    const app = mountRouter({ manifest: buildManifest(), projectRoot })
    const res = await postJson(app, '/api/app/capture/camera', {
      appId: 'capture-app',
    })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
  })
})
