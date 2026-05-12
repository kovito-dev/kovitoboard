/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the host-bootstrap audit endpoint (v0.2.0 / spec v1.7
 * §6.10.6.13). Verifies the host-emitted sentinel is recorded to
 * `app/_host-bootstrap-audit.log` and that recipe code cannot route
 * around the host-only auth.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import type { Express, RequestHandler } from 'express'
import { createAuditRouter } from '../../src/server/routes/audit-routes'
import { lazyChildLogger } from '../../src/server/logger'

const log = lazyChildLogger('audit-routes-test')

const passingInternalAuth: RequestHandler = (_req, _res, next) => next()

function mountRouter(opts: {
  projectRoot: string
  verifyInternalAuth?: RequestHandler
}): Express {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/audit',
    createAuditRouter({
      projectRoot: opts.projectRoot,
      logger: log as unknown as Parameters<typeof createAuditRouter>[0]['logger'],
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

function readAuditLines(projectRoot: string): Array<Record<string, unknown>> {
  const path = join(projectRoot, 'app', '_host-bootstrap-audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('createAuditRouter — host-bootstrap', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-audit-routes-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('records a host-bootstrap-verified record for a healthy mount', async () => {
    const app = mountRouter({ projectRoot })
    const res = await postJson(app, '/api/audit/host-bootstrap', {
      event: 'host-bootstrap-verified',
      recipePath: 'fixture-a',
      appId: 'fixture-a',
      when: 'before-recipe-render',
    })
    expect(res.status).toBe(204)
    const lines = readAuditLines(projectRoot)
    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('host-bootstrap-verified')
    expect(lines[0].recipePath).toBe('fixture-a')
    expect(typeof lines[0].timestamp).toBe('string')
  })

  it('records a host-bootstrap-violation record and includes appId / recipePath', async () => {
    const app = mountRouter({ projectRoot })
    const res = await postJson(app, '/api/audit/host-bootstrap', {
      event: 'host-bootstrap-violation',
      recipePath: 'fixture-b',
      appId: 'fixture-b',
      when: 'before-recipe-render',
    })
    expect(res.status).toBe(204)
    const lines = readAuditLines(projectRoot)
    expect(lines.at(-1)?.event).toBe('host-bootstrap-violation')
  })

  it('returns 400 InvalidEvent when the body event is not in the allowed set', async () => {
    const app = mountRouter({ projectRoot })
    const res = await postJson(app, '/api/audit/host-bootstrap', {
      event: 'random-string',
    })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('InvalidEvent')
  })

  it('rejects with 401 when the internal auth middleware fails', async () => {
    const failingAuth: RequestHandler = (_req, res) => {
      res.status(401).json({ error: 'MissingInternalAuth' })
    }
    const app = mountRouter({ projectRoot, verifyInternalAuth: failingAuth })
    const res = await postJson(app, '/api/audit/host-bootstrap', {
      event: 'host-bootstrap-verified',
    })
    expect(res.status).toBe(401)
    // No audit file was created — recipe code cannot fabricate
    // sentinel records.
    expect(readAuditLines(projectRoot)).toHaveLength(0)
  })
})
