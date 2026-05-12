/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.0 capture endpoint router
 * (`/api/app/capture/<kind>`) — v1.7 shape with mount-identity +
 * capture-token source authentication.
 *
 * The router runs the v1.5 §10.6.3 5-step verification flow:
 *
 *   1. unknown literal kind path segment → 403 CaptureNotDeclared
 *   2. X-KB-Capture-Token header missing / malformed / unknown /
 *      expired → 403 NoActiveRecipe with the matching token-* reason
 *      (mountStore lookup miss → reason `mount-not-found`)
 *   3. token + mount resolve cleanly but manifest disappeared → 403
 *      NoActiveRecipe (audit reason: `no-matching-manifest`)
 *   4. kind missing from manifest.captureRequires → 403
 *      CaptureNotDeclared (audit reason: `not-declared`)
 *   5. kind missing from manifest.approvedCaptures → 403
 *      CaptureNotApproved (audit reason: `not-approved`)
 *   6. otherwise 204 (audit reason: `approved`)
 *
 * The suite covers the **issuance-gate cross-app capability theft
 * regression** (PR #30 attempt 4 CodeX HIGH): a recipe page A that
 * holds A's mountId cannot mint a token for app B by forging body
 * fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'
import {
  createCaptureRouter,
  type CaptureManifestLookup,
} from '../../src/server/routes/capture-routes'
import type { RecipeManifest } from '../../src/server/recipe/apiTypes'
import { lazyChildLogger } from '../../src/server/logger'
import {
  __resetForTests as resetTokenStore,
  issueCaptureToken,
} from '../../src/server/recipe-capture-sessions'
import {
  __resetForTests as resetMountStore,
  openMount,
} from '../../src/server/recipe-capture-mount-sessions'

const log = lazyChildLogger('capture-routes-test')

/**
 * Helper to open a mount and immediately issue a bound token. The
 * `appId` ends up in both the mountStore and the tokenStore, which
 * is the chain `capture-routes.ts` step 2 walks.
 */
function provisionToken(appId: string): { mountId: string; token: string } {
  const mount = openMount(appId)
  if (!mount.ok) throw new Error(`openMount failed for ${appId}: ${mount.reason}`)
  const issued = issueCaptureToken({ mountId: mount.mountId, appId })
  if (!issued.ok) throw new Error(`issueCaptureToken failed: ${issued.reason}`)
  return { mountId: mount.mountId, token: issued.token }
}

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
  projectRoot: string
}): Express {
  const store: CaptureManifestLookup = {
    get: (appId) => opts.manifests.find((m) => m.appId === appId) ?? null,
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/api/app/capture',
    createCaptureRouter({
      manifestStore: store,
      projectRoot: opts.projectRoot,
      logger: log as unknown as Parameters<typeof createCaptureRouter>[0]['logger'],
    }),
  )
  return app
}

async function postCapture(
  app: Express,
  kindSegment: string,
  body: Record<string, unknown>,
  token: string | null,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<{ status: number; body: Record<string, unknown> | null }>(
      (resolve, reject) => {
        const payload = JSON.stringify(body ?? {})
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString(),
        }
        if (token !== null) {
          headers['x-kb-capture-token'] = token
        }
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/api/app/capture/${kindSegment}`,
            headers,
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

describe('createCaptureRouter (v1.7 mountId + capture-token mechanism)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-capture-router-'))
    resetTokenStore()
    resetMountStore()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    resetTokenStore()
    resetMountStore()
  })

  it('returns 204 with a valid token and approved/declared kind', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const { token } = provisionToken('capture-app')

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(204)
    const entries = readPerAppAuditEntries(projectRoot, 'capture-app')
    expect(entries.at(-1)?.reason).toBe('approved')
  })

  it('returns 403 capture-token-missing when the header is absent', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })

    const res = await postCapture(app, 'a11y', {}, null)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('capture-token-missing')
    const entries = readUnresolvedAuditEntries(projectRoot)
    expect(entries.at(-1)?.reason).toBe('capture-token-missing')
    expect(entries.at(-1)?.appId).toBeNull()
  })

  it('returns 403 capture-token-invalid for a malformed token', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })

    const res = await postCapture(app, 'a11y', {}, 'not-hex')
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('NoActiveRecipe')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('capture-token-invalid')
  })

  it('returns 403 capture-token-invalid for an unknown token', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })

    const res = await postCapture(app, 'a11y', {}, 'a'.repeat(32))
    expect(res.status).toBe(403)
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('capture-token-invalid')
  })

  it('returns 403 no-matching-manifest when the token resolves to no manifest (uninstall race)', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    // Provision a token bound to an appId that the manifestStore
    // does not know about — simulates an uninstall race after
    // mount-open.
    const { token } = provisionToken('ghost-app')

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(403)
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('no-matching-manifest')
    const entries = readUnresolvedAuditEntries(projectRoot)
    expect(entries.at(-1)?.reason).toBe('no-matching-manifest')
  })

  it('returns 403 not-declared when captureRequires omits the kind (step 3)', async () => {
    const manifest = buildManifest({
      captureRequires: ['exposed-context'],
      approvedCaptures: [],
    })
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const { token } = provisionToken('capture-app')

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('not-declared')
    const entries = readPerAppAuditEntries(projectRoot, 'capture-app')
    expect(entries.at(-1)?.reason).toBe('not-declared')
  })

  it('returns 403 not-approved when the kind is declared but not approved (step 4)', async () => {
    const manifest = buildManifest({
      captureRequires: ['a11y'],
      approvedCaptures: [],
    })
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const { token } = provisionToken('capture-app')

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotApproved')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('not-approved')
  })

  it('returns 403 CaptureNotDeclared on an unknown literal kind path segment', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })

    const res = await postCapture(app, 'camera', {}, null)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
  })

  it('writes unknown-literal-kind probes to the global audit sink', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    await postCapture(app, 'camera', {}, null)
    const entries = readUnresolvedAuditEntries(projectRoot)
    const probeEntry = entries.find((e) => e.rawKind === 'camera')
    expect(probeEntry).toBeDefined()
    expect(probeEntry?.kind).toBeNull()
    expect(probeEntry?.reason).toBe('not-declared')
  })

  it('I-CR4 cross-app capability theft regression — token resolves to its own appId, body.appId is ignored', async () => {
    // Recipe A has a11y approved. Recipe B has nothing.
    // An attacker on recipe A's page mints A's token, then posts
    // `body: { appId: 'recipe-b' }` to try to borrow B's identity.
    const manifestA = buildManifest({
      appId: 'recipe-a',
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
    })
    const manifestB = buildManifest({
      appId: 'recipe-b',
      captureRequires: ['exposed-context'],
      approvedCaptures: ['exposed-context'],
    })
    const app = mountRouter({
      manifests: [manifestA, manifestB],
      projectRoot,
    })
    const { token } = provisionToken('recipe-a')

    const res = await postCapture(
      app,
      'a11y',
      { appId: 'recipe-b' }, // attacker-controlled lie
      token,
    )
    // Expected: 204 because recipe A has a11y approved. The body
    // field is ignored; if the router had honoured `body.appId =
    // 'recipe-b'` we would expect 403 CaptureNotDeclared (recipe B
    // does not declare a11y), so the 204 result proves the lie was
    // discarded and authorisation routed through recipe A's manifest.
    expect(res.status).toBe(204)
    const aEntries = readPerAppAuditEntries(projectRoot, 'recipe-a')
    expect(aEntries.at(-1)?.recipeId).toBe('capture-recipe')
    expect(aEntries.at(-1)?.reason).toBe('approved')
    // Recipe B's audit file is untouched.
    const bEntries = readPerAppAuditEntries(projectRoot, 'recipe-b')
    expect(bEntries).toHaveLength(0)
  })

  it('returns 403 mount-not-found when the token references a mount that was already closed (race)', async () => {
    // Provision a token, then drop the mount directly to simulate
    // a `/capture-mount/close` racing with a capture call.
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const { mountId, token } = provisionToken('capture-app')
    const { closeMount } = await import('../../src/server/recipe-capture-mount-sessions')
    expect(closeMount(mountId)).toBe(true)

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(403)
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('mount-not-found')
    const entries = readUnresolvedAuditEntries(projectRoot)
    expect(entries.at(-1)?.reason).toBe('mount-not-found')
  })

  it('grandfather recipe (captureRequires empty) — if a forged token reaches step 3 the manifest collapses to not-declared', async () => {
    const manifest = buildManifest({
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
    })
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const { token } = provisionToken('capture-app')

    const res = await postCapture(app, 'a11y', {}, token)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
    expect(
      String((res.body?.details as Record<string, unknown>).remediation),
    ).toMatch(/Grandfather recipe/)
  })
})
