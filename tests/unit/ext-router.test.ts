/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * External-client HTTP router boundary tests
 * (external-client-api.md v1.0 §7.1 / §7.2 / §7.4 / §9.1–§9.3 / §9.5).
 *
 * Drives the real router mounted on an in-process express app
 * (`listen(0)` + fetch) so the extension guard, pairing handlers, and
 * the `/token` rotation special-route are exercised exactly as the live
 * server wires them. The injected delegates are spies so the test does
 * not need the full KB server. Also pins the §5.2 mount ordering: the
 * ext router is mounted BEFORE a stand-in `/api` loopback guard, and an
 * extension request is NOT intercepted by that loopback guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createExtClientRouter, EXT_CLIENT_MOUNT_PREFIX } from '../../src/server/ext-client/ext-router'
import { PairingStore } from '../../src/server/ext-client/pairing-store'
import { OwnershipRegistry } from '../../src/server/ext-client/ownership-registry'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`

let server: Server
let base: string
let pairing: PairingStore
let registry: OwnershipRegistry
let loopbackGuardHits = 0

beforeAll(async () => {
  pairing = new PairingStore()
  registry = new OwnershipRegistry()
  const app = express()

  // Ext router BEFORE the loopback `/api` guard (§5.2). The stand-in
  // guard records whether it was ever reached by an ext request.
  app.use(
    EXT_CLIENT_MOUNT_PREFIX,
    createExtClientRouter({
      pairing,
      registry,
      getLaunchToken: () => TOKEN,
      tokensMatchLaunchToken: (actual, expected) => actual === expected,
      onRepairOverwrite: () => {},
      onAsyncError: () => {},
      handleAgentsList: (_req, res) => res.json([{ id: 'agent-1' }]),
      handleExtSessionNew: (req, res, ctx) => {
        // Mirror the real delegate's validate-before-launch contract so
        // the test pins the 400 (bad input) vs 202 (accepted) split and
        // the abort-on-bad-input behaviour (§7.3 — no 500 for bad input).
        const body = req.body as { message?: unknown }
        const message = typeof body.message === 'string' ? body.message : ''
        if (message.trim().length === 0) {
          registry.abortLaunch(ctx.launchId)
          res.status(400).json({ error: 'message must be a non-empty string' })
          return
        }
        res.status(202).json({ launchId: ctx.launchId })
      },
      handleSessionSend: (_req, res) => res.json({ ok: true }),
    }),
  )
  app.use('/api', (_req, res) => {
    loopbackGuardHits++
    res.status(401).json({ error: 'loopback guard reached' })
  })

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address() as AddressInfo
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function url(path: string): string {
  return `${base}${EXT_CLIENT_MOUNT_PREFIX}${path}`
}

async function pair(): Promise<void> {
  pairing.reset()
  registry.clear()
  const code = pairing.issuePairingCode()
  const res = await fetch(url('/pair'), {
    method: 'POST',
    headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, extensionId: EXT_ID }),
  })
  expect(res.status).toBe(200)
}

describe('ext guard — origin / token (§7.1 / §9.1)', () => {
  beforeAll(pair)

  it('accepts a paired extension origin + valid token', async () => {
    const res = await fetch(url('/capabilities'), {
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { apiVersion: number; supportedFeatures: string[] }
    expect(body.apiVersion).toBe(1)
    expect(body.supportedFeatures).toContain('shared-chat')
  })

  it('rejects a mismatched extension id (403)', async () => {
    const other = `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba`
    const res = await fetch(url('/capabilities'), {
      headers: { origin: other, 'x-kovitoboard-token': TOKEN },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a normal web origin (403, §7.1 step 2a)', async () => {
    const res = await fetch(url('/capabilities'), {
      headers: { origin: 'https://evil.example', 'x-kovitoboard-token': TOKEN },
    })
    expect(res.status).toBe(403)
  })

  it('rejects an empty Origin (no curl救済 in ext namespace, §7.1)', async () => {
    const res = await fetch(url('/capabilities'), {
      headers: { 'x-kovitoboard-token': TOKEN },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a wrong token (401 + WWW-Authenticate)', async () => {
    const res = await fetch(url('/capabilities'), {
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': 'wrong' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('KbLaunchToken')
  })

  it('does NOT fall through to the loopback /api guard for ext requests (§5.2)', () => {
    expect(loopbackGuardHits).toBe(0)
  })
})

describe('unpaired fail-closed (§8.1 / §9.1)', () => {
  beforeAll(() => {
    pairing.reset()
    registry.clear()
  })

  it('403s every guarded route while unpaired', async () => {
    const res = await fetch(url('/capabilities'), {
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN },
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: 'Extension not paired' })
  })

  it('403s /token while unpaired (§7.2.4)', async () => {
    const res = await fetch(url('/token'), { headers: { origin: EXT_ORIGIN } })
    expect(res.status).toBe(403)
  })
})

describe('pairing handshake (§7.2 / §9.2)', () => {
  beforeAll(() => {
    pairing.reset()
    registry.clear()
  })

  it('401s /pair when no code is active', async () => {
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'x', extensionId: EXT_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('400s when body extensionId mismatches the origin id', async () => {
    pairing.issuePairingCode()
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'x', extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba' }),
    })
    expect(res.status).toBe(400)
  })

  it('403s /pair from a non-extension origin', async () => {
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'x', extensionId: EXT_ID }),
    })
    expect(res.status).toBe(403)
  })

  it('pairs with the correct code and returns the token', async () => {
    const code = pairing.issuePairingCode()
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, extensionId: EXT_ID }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { token: string }).toEqual({ token: TOKEN })
  })

  it('a same-id re-pair still resets the ownership registry (§7.2.1)', async () => {
    // Pair, then create some owned state, then re-pair the SAME id.
    const code1 = pairing.issuePairingCode()
    await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code1, extensionId: EXT_ID }),
    })
    registry.registerLaunch({ agentId: 'agent-z', originConnId: 1, clientRequestId: 'rz' })
    expect(registry.isAgentInFlight('agent-z')).toBe(true)

    const code2 = pairing.issuePairingCode()
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code2, extensionId: EXT_ID }),
    })
    expect(res.status).toBe(200)
    // The re-pair must have cleared the in-flight launch state.
    expect(registry.isAgentInFlight('agent-z')).toBe(false)
  })

  it('rejects reuse of a consumed code (401)', async () => {
    const code = pairing.issuePairingCode()
    await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, extensionId: EXT_ID }),
    })
    const res = await fetch(url('/pair'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, extensionId: EXT_ID }),
    })
    expect(res.status).toBe(401)
  })
})

describe('/token rotation follow (§7.2.4 / §9.3)', () => {
  beforeAll(pair)

  it('returns the current token on origin-only (no token required)', async () => {
    const res = await fetch(url('/token'), { headers: { origin: EXT_ORIGIN } })
    expect(res.status).toBe(200)
    expect((await res.json()) as { token: string }).toEqual({ token: TOKEN })
  })

  it('403s /token from a mismatched origin', async () => {
    const res = await fetch(url('/token'), {
      headers: { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' },
    })
    expect(res.status).toBe(403)
  })
})

describe('ownership enforcement on send (§7.3.1 / §9.5)', () => {
  beforeAll(pair)

  it('403s send for a non-owned session', async () => {
    const res = await fetch(url('/sessions/not-owned/send'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: 'Session not owned' })
  })
})

describe('ext new-session launch (§7.3.1 / §9.4)', () => {
  beforeAll(pair)

  it('returns 202 + launchId and marks the agent in-flight', async () => {
    const res = await fetch(url('/sessions/new'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-x', clientRequestId: 'req-1', message: 'go' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { launchId: string }
    expect(typeof body.launchId).toBe('string')
    expect(registry.isAgentInFlight('agent-x')).toBe(true)
  })

  it('400s (not 500) on invalid input and releases the in-flight lock', async () => {
    const res = await fetch(url('/sessions/new'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-y', clientRequestId: 'req-y', message: '   ' }),
    })
    expect(res.status).toBe(400)
    // The aborted launch must not leave agent-y locked.
    expect(registry.isAgentInFlight('agent-y')).toBe(false)
  })

  it('409s a second concurrent launch for the same agentId', async () => {
    const res = await fetch(url('/sessions/new'), {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-x', clientRequestId: 'req-2', message: 'go again' }),
    })
    expect(res.status).toBe(409)
  })
})

describe('ext new-session re-pair TOCTOU on the HTTP path (§7.2.1)', () => {
  // `extGuard` validates the pairing/origin BEFORE `express.json()`
  // streams the body. A re-pair (overwrite to a different extension) can
  // land DURING a slow body stream — it clears the registry and
  // terminates the old WS sockets, but an in-flight HTTP request is not
  // a WS socket and survives. `handleExtNew` must re-validate the
  // pairing + origin after the body parses, before mutating the
  // registry, so the now-revoked extension cannot register a launch
  // under the new pairing.
  let server2: Server
  let base2: string
  let registry2: OwnershipRegistry
  // Pairing stub: the guard sees the request's origin id as allowed, but
  // by the time the post-parse re-check runs the slot has flipped to a
  // different extension (a re-pair landed mid-stream).
  let allowedIdReturns: Array<string | null>

  beforeAll(async () => {
    registry2 = new OwnershipRegistry()
    allowedIdReturns = []
    const pairingStub = {
      getAllowedExtensionId: () =>
        allowedIdReturns.length > 0 ? (allowedIdReturns.shift() as string | null) : EXT_ID,
    } as unknown as PairingStore

    const app = express()
    app.use(
      EXT_CLIENT_MOUNT_PREFIX,
      createExtClientRouter({
        pairing: pairingStub,
        registry: registry2,
        getLaunchToken: () => TOKEN,
        tokensMatchLaunchToken: (actual, expected) => actual === expected,
        onRepairOverwrite: () => {},
        onAsyncError: () => {},
        handleAgentsList: (_req, res) => res.json([]),
        handleExtSessionNew: (_req, res, ctx) => res.status(202).json({ launchId: ctx.launchId }),
        handleSessionSend: (_req, res) => res.json({ ok: true }),
      }),
    )
    await new Promise<void>((resolve) => {
      server2 = app.listen(0, '127.0.0.1', resolve)
    })
    const addr = server2.address() as AddressInfo
    base2 = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server2.close(() => resolve()))
  })

  it('403s and does not register a launch when the pairing flips after the guard', async () => {
    const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    // 1st call = the guard (sees EXT_ID, passes). 2nd call = the
    // post-parse re-check inside handleExtNew (sees OTHER_ID → mismatch).
    allowedIdReturns = [EXT_ID, OTHER_ID]
    const res = await fetch(`${base2}${EXT_CLIENT_MOUNT_PREFIX}/sessions/new`, {
      method: 'POST',
      headers: { origin: EXT_ORIGIN, 'x-kovitoboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-toctou', clientRequestId: 'req-toctou', message: 'go' }),
    })
    expect(res.status).toBe(403)
    // The revoked extension must NOT have registered a launch.
    expect(registry2.isAgentInFlight('agent-toctou')).toBe(false)
  })
})
