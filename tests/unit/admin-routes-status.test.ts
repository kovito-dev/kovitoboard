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
 * | tmux.alive | ever alive | active sessions | status   |
 * |------------|------------|-----------------|----------|
 * | true       | (any)      | (any)           | healthy  |
 * | false      | (any)      | 0               | healthy  |
 * | false      | false      | >= 1            | healthy  |
 * | false      | true       | >= 1            | degraded |
 *
 * The "ever alive" latch (`TmuxBridge.hasEverHadSession()`) suppresses
 * degraded during the startup window before the KB-owned tmux session is
 * first spawned: in that window any active sessions are external
 * (terminal-launched) Claude processes the bridge does not own, so they
 * must not raise the degraded banner. Degraded is reserved for "tmux gone
 * while a KB session was running".
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
  /**
   * Pre-seed the `hasEverHadSession()` latch as if a KB-owned session had
   * already been alive earlier in the process lifetime. Defaults to
   * `false` (fresh startup window). The real bridge also latches whenever
   * `hasSession()` returns true, which this stub mirrors below.
   */
  everAlive?: boolean
}

function makeTmuxBridge(stub: TmuxStub): TmuxBridge {
  // Mirror the real bridge's process-lifetime latch: it flips to true
  // when `hasSession()` returns true and never resets. `everAlive` may
  // also pre-seed it to model "tmux was alive earlier, then died".
  let everAlive = stub.everAlive ?? false
  return {
    get sessionName() {
      return 'kovitoboard-test'
    },
    hasSession() {
      const alive =
        typeof stub.alive === 'function' ? stub.alive() : stub.alive
      if (alive) everAlive = true
      return alive
    },
    hasEverHadSession() {
      return everAlive
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

  it('tmux absent + >= 1 active session + ever alive -> degraded (real anomaly)', async () => {
    // `everAlive: true` = the KB-owned session was alive earlier and then
    // died while a session is still running — the genuine anomaly.
    const app = buildApp({ alive: false, everAlive: true }, [
      makeSessionSummary('idle'),
      makeSessionSummary('active'),
    ])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('degraded')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  it('tmux check throws + active session + ever alive -> degraded (conservative, §6.6.1 error tolerance)', async () => {
    const app = buildApp(
      {
        alive: () => {
          throw new Error('tmux exploded')
        },
        everAlive: true,
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

describe('GET /api/admin/status — startup latch (hasEverHadSession)', () => {
  // (a) Reported case: an external (terminal-launched) Claude session is
  // non-idle, but the KB-owned tmux session has never been spawned. The
  // missing session is not a KB regression, so this must stay healthy
  // instead of surfacing the degraded banner.
  it('external non-idle session + tmux never alive -> healthy', async () => {
    const app = buildApp({ alive: false, everAlive: false }, [
      makeSessionSummary('active'),
    ])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  // (b) The KB-owned tmux session was alive earlier (latch set) and is
  // then force-killed while a session is still active. The latch persists
  // for the process lifetime, so the genuine anomaly is still reported as
  // degraded. `everAlive: true` models the prior alive observation;
  // `alive: false` models the post-kill state at the status read.
  it('tmux alive then killed + active session -> degraded', async () => {
    const app = buildApp({ alive: false, everAlive: true }, [
      makeSessionSummary('active'),
    ])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('degraded')
    expect((reply.body?.tmux as { alive: boolean }).alive).toBe(false)
  })

  // The latch is set by `hasSession()` itself (mirrors the real bridge):
  // a single alive observation flips it and it never resets, even after
  // the session subsequently disappears.
  it('hasSession() latches hasEverHadSession() and the latch persists', () => {
    let killed = false
    const bridge = makeTmuxBridge({
      alive: () => {
        if (!killed) {
          killed = true
          return true // first call: alive -> latches
        }
        return false // subsequently killed
      },
    })
    expect(bridge.hasEverHadSession()).toBe(false)
    expect(bridge.hasSession()).toBe(true)
    expect(bridge.hasEverHadSession()).toBe(true)
    expect(bridge.hasSession()).toBe(false) // killed
    expect(bridge.hasEverHadSession()).toBe(true) // latch persists
  })

  // (c) Sessions restored after a KB restart but all idle, with the
  // KB-owned tmux session not yet (re)spawned. No active work and no
  // latch -> healthy (no regression of the #128-class idle handling).
  it('restored sessions all idle + tmux never alive -> healthy', async () => {
    const app = buildApp({ alive: false, everAlive: false }, [
      makeSessionSummary('idle'),
      makeSessionSummary('idle'),
    ])
    const reply = await getStatus(app)
    expect(reply.status).toBe(200)
    expect(reply.body?.status).toBe('healthy')
  })
})
