/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the `GET /api/admin/status` derivation of the overall
 * `status` field (supervisor-startup spec §6.6.1, normative).
 *
 * The derivation is session-aware: a missing tmux session is only an
 * anomaly when a session is actually running. Right after a KB restart
 * the tmux session is spawned lazily, so `tmux.alive === false` with no
 * active session is the normal idle state and must report `healthy`
 * (false-positive degraded-banner fix).
 *
 * | tmux.alive | active sessions | status   |
 * |------------|-----------------|----------|
 * | true       | (any)           | healthy  |
 * | false      | 0               | healthy  |
 * | false      | >= 1            | degraded |
 *
 * Active-session source of truth: `SessionManager.getSessions()` entries
 * whose `status !== 'idle'` (renderer `hasActiveSession` parity).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'

import { createAdminRouter } from '../../src/server/routes/admin-routes'
import { initLogger } from '../../src/server/logger'
import type { TmuxBridge } from '../../src/server/tmux-bridge'
import type { SessionManager } from '../../src/server/session-manager'
import type { SessionSummary } from '../../src/server/types'

// `admin-routes` logs a `lazyChildLogger` warning when the tmux health
// check throws. The lazy logger proxy throws unless `initLogger()` ran,
// so initialize it once for the throw-path case.
beforeAll(async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'kb-admin-status-logroot-'))
  mkdirSync(join(logRoot, '.kovitoboard', 'logs'), { recursive: true })
  await initLogger(logRoot, null)
})

interface TmuxStub {
  alive: boolean | (() => boolean)
}

function makeTmuxBridge(stub: TmuxStub): TmuxBridge {
  return {
    get sessionName() {
      return 'kovitoboard-test'
    },
    hasSession() {
      return typeof stub.alive === 'function' ? stub.alive() : stub.alive
    },
    listWindows() {
      // Mirrors the real bridge: windows derive from tmux, so an absent
      // session yields no windows. The status derivation must not rely
      // on this field for idle-vs-anomaly discrimination.
      return []
    },
  } as unknown as TmuxBridge
}

function makeSessionSummary(status: string): SessionSummary {
  return {
    id: `session-${status}`,
    projectName: 'proj',
    projectPath: '/tmp/proj',
    status,
    lastEventAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    stats: {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
  }
}

function makeSessionManager(sessions: SessionSummary[]): SessionManager {
  return {
    getSessions(): SessionSummary[] {
      return sessions
    },
  } as unknown as SessionManager
}

function buildApp(
  tmuxStub: TmuxStub,
  sessions: SessionSummary[],
): Express {
  const app = express()
  app.use(
    '/api/admin',
    createAdminRouter(
      makeTmuxBridge(tmuxStub),
      Date.now(),
      makeSessionManager(sessions),
    ),
  )
  return app
}

interface HttpReply {
  status: number
  body: Record<string, unknown> | null
}

async function getStatus(app: Express): Promise<HttpReply> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<HttpReply>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'GET', path: '/api/admin/status' },
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
      req.end()
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('GET /api/admin/status — status derivation (spec §6.6.1)', () => {
  it('tmux alive -> healthy (regardless of session state)', async () => {
    const app = buildApp({ alive: true }, [makeSessionSummary('active')])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(true)
  })

  it('tmux absent + 0 active sessions -> healthy (idle, no false-positive banner)', async () => {
    // Only idle sessions present -> none count as active.
    const app = buildApp({ alive: false }, [makeSessionSummary('idle')])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  it('tmux absent + no sessions at all -> healthy (idle)', async () => {
    const app = buildApp({ alive: false }, [])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
  })

  it('tmux absent + >= 1 active session -> degraded (real anomaly)', async () => {
    const app = buildApp({ alive: false }, [
      makeSessionSummary('idle'),
      makeSessionSummary('active'),
    ])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('degraded')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  it('tmux check throws + active session -> degraded (conservative, §6.6.1 error tolerance)', async () => {
    const app = buildApp(
      {
        alive: () => {
          throw new Error('tmux exploded')
        },
      },
      [makeSessionSummary('thinking')],
    )
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('degraded')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  it('tmux check throws + no active session -> healthy', async () => {
    const app = buildApp(
      {
        alive: () => {
          throw new Error('tmux exploded')
        },
      },
      [],
    )
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
  })
})
