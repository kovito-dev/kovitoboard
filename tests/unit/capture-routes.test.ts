/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the v0.2.0 capture endpoint router
 * (`/api/app/capture/<kind>`) — v1.6 shape with capture-token
 * source authentication.
 *
 * The router runs the 5-step verification flow from
 * `http-api-contract.md` v1.4 §10.6.3 with token-based source
 * authentication (I-CR4):
 *
 *   1. unknown literal kind path segment → 403 CaptureNotDeclared
 *      (audit reason: `not-declared`, kind: null, global sink)
 *   2. X-KB-Capture-Token header missing → 403 NoActiveRecipe
 *      (audit reason: `capture-token-missing`, global sink)
 *   3. token malformed / unknown → 403 NoActiveRecipe
 *      (audit reason: `capture-token-invalid`, global sink)
 *   4. token expired → 403 NoActiveRecipe
 *      (audit reason: `capture-token-expired`, global sink)
 *   5. token's appId resolves to no manifest → 403 NoActiveRecipe
 *      (audit reason: `no-matching-manifest`, global sink)
 *   6. kind missing from manifest.captureRequires → 403
 *      CaptureNotDeclared (audit reason: `not-declared`, per-app sink)
 *   7. kind missing from manifest.approvedCaptures → 403
 *      CaptureNotApproved (audit reason: `not-approved`, per-app sink)
 *   8. otherwise 204 (audit reason: `approved`, per-app sink)
 *
 * Crucially this suite covers the **cross-app capability theft
 * regression** that surfaced as the attempt 3 CodeX HIGH finding:
 * a token issued for `app-A` MUST resolve to `app-A` regardless of
 * any `appId` field the caller may send in the body (I-CR4).
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
  __resetForTests,
  issueCaptureToken,
} from '../../src/server/recipe-capture-sessions'

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
  manifests: RecipeManifest[]
  projectRoot: string
}): Express {
  // Multi-manifest lookup so cross-app capability theft tests can
  // register both app-A and app-B in the same store.
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

describe('createCaptureRouter (v1.6 capture-token mechanism)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-capture-router-'))
    __resetForTests()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    __resetForTests()
  })

  it('returns 204 with a valid token and approved/declared kind', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    const issued = issueCaptureToken('capture-app')
    if (!issued.ok) throw new Error('issue failed')

    const res = await postCapture(app, 'a11y', {}, issued.token)
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

  it('returns 403 no-matching-manifest when the token resolves to no manifest', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })
    // Issue a token bound to an appId that the store does not know
    // about — simulates uninstall-mid-session race.
    const ghost = issueCaptureToken('ghost-app')
    if (!ghost.ok) throw new Error('issue failed')

    const res = await postCapture(app, 'a11y', {}, ghost.token)
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
    const issued = issueCaptureToken('capture-app')
    if (!issued.ok) throw new Error('issue failed')

    const res = await postCapture(app, 'a11y', {}, issued.token)
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
    const issued = issueCaptureToken('capture-app')
    if (!issued.ok) throw new Error('issue failed')

    const res = await postCapture(app, 'a11y', {}, issued.token)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotApproved')
    expect(
      (res.body?.details as Record<string, unknown>).reason,
    ).toBe('not-approved')
  })

  it('returns 403 CaptureNotDeclared on an unknown literal kind path segment', async () => {
    const manifest = buildManifest()
    const app = mountRouter({ manifests: [manifest], projectRoot })

    // Unknown kind short-circuits before any token check, so we
    // can send any (or no) token here.
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
    // The server MUST resolve the token to recipe A (its own appId)
    // and check recipe A's manifest. Recipe B's manifest is never
    // consulted — so the attempt does not gain B's authorisation,
    // and it does not even exfiltrate B's `captureRequires` state
    // because A's check runs in isolation.
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
    const issuedA = issueCaptureToken('recipe-a')
    if (!issuedA.ok) throw new Error('issue failed')

    const res = await postCapture(
      app,
      'a11y',
      { appId: 'recipe-b' }, // attacker-controlled lie
      issuedA.token,
    )
    // Expected: 204 because recipe A has a11y approved. The body
    // field is ignored; if the router had honoured `body.appId =
    // 'recipe-b'` we would expect 403 CaptureNotDeclared (recipe B
    // does not declare a11y), so the **204 result is what proves
    // the lie was discarded** and authorisation routed through
    // recipe A's own manifest.
    expect(res.status).toBe(204)
    // Audit entry is attributed to recipe A's manifest, not B's.
    const aEntries = readPerAppAuditEntries(projectRoot, 'recipe-a')
    expect(aEntries.at(-1)?.recipeId).toBe('capture-recipe')
    expect(aEntries.at(-1)?.reason).toBe('approved')
    // Recipe B's audit file is untouched.
    const bEntries = readPerAppAuditEntries(projectRoot, 'recipe-b')
    expect(bEntries).toHaveLength(0)
  })

  it('grandfather recipe (captureRequires empty) — token issuance would skip, but if forged it lands on step 3', async () => {
    // The legitimate path is for the bridge to never call
    // /api/app/capture/* without a token, because grandfather
    // manifests get `{ token: null }` from the issue endpoint.
    // This test exercises the defensive branch: even if a probe
    // forges a token bound to a grandfather appId, the manifest's
    // empty `captureRequires` collapses the call to step 3.
    const manifest = buildManifest({
      captureRequires: [],
      approvedCaptures: [],
      trustLevel: 'unknown',
    })
    const app = mountRouter({ manifests: [manifest], projectRoot })
    // Mint a token directly via the session store as if a forged
    // path bypassed the issue endpoint's grandfather skip. This is
    // the defensive branch the router must still refuse.
    const forced = issueCaptureToken('capture-app')
    if (!forced.ok) throw new Error('issue failed')

    const res = await postCapture(app, 'a11y', {}, forced.token)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('CaptureNotDeclared')
    expect(
      String((res.body?.details as Record<string, unknown>).remediation),
    ).toMatch(/Grandfather recipe/)
  })
})
