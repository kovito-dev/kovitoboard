/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * External-client WS classification + verifier tests
 * (external-client-api.md v1.0 §7.6.2 / §9.6.1).
 *
 * Pins the 3-value connection classification and the ext-aware
 * verifyClient: renderer upgrades delegate verbatim, extension upgrades
 * require pairing + token + extApiVersion, and a stale extension origin
 * is rejected (not silently demoted to renderer).
 */
import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'http'
import {
  classifyConnection,
  parseExtApiVersion,
  createExtAwareWsVerifier,
  EXT_API_VERSION,
} from '../../src/server/ext-client/ws-ext'
import { PairingStore } from '../../src/server/ext-client/pairing-store'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

// Mirror auth.ts's loopback predicate shape for the classifier.
const LOOPBACK = new Set(['http://127.0.0.1:5173', 'http://localhost:3001'])
const isLoopbackOrigin = (origin: string | undefined): boolean =>
  origin === undefined || origin === '' || LOOPBACK.has(origin)

function pairedStore(): PairingStore {
  const store = new PairingStore()
  const code = store.issuePairingCode()
  store.tryPair(code, EXT_ID)
  return store
}

describe('classifyConnection (3-value §7.6.2)', () => {
  it('classifies a paired extension origin as extension', () => {
    const store = pairedStore()
    expect(classifyConnection(`chrome-extension://${EXT_ID}`, store, isLoopbackOrigin)).toBe('extension')
  })

  it('classifies a loopback origin as renderer', () => {
    const store = pairedStore()
    expect(classifyConnection('http://127.0.0.1:5173', store, isLoopbackOrigin)).toBe('renderer')
  })

  it('classifies an empty origin (programmatic client) as renderer', () => {
    const store = pairedStore()
    expect(classifyConnection('', store, isLoopbackOrigin)).toBe('renderer')
  })

  it('rejects a valid-but-unpaired extension origin (no silent renderer demotion)', () => {
    const store = pairedStore()
    const otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    expect(classifyConnection(`chrome-extension://${otherId}`, store, isLoopbackOrigin)).toBe('reject')
  })

  it('rejects an unknown web origin', () => {
    const store = pairedStore()
    expect(classifyConnection('https://evil.example', store, isLoopbackOrigin)).toBe('reject')
  })

  it('classifies as renderer when no extension is paired and origin is loopback', () => {
    const store = new PairingStore()
    expect(classifyConnection('http://localhost:3001', store, isLoopbackOrigin)).toBe('renderer')
  })
})

describe('parseExtApiVersion', () => {
  const req = (url: string) => ({ url }) as IncomingMessage
  it('parses an integer extApiVersion', () => {
    expect(parseExtApiVersion(req(`/api/ws?token=x&extApiVersion=${EXT_API_VERSION}`))).toBe(EXT_API_VERSION)
  })
  it('returns null when absent', () => {
    expect(parseExtApiVersion(req('/api/ws?token=x'))).toBeNull()
  })
  it('returns null for a non-integer', () => {
    expect(parseExtApiVersion(req('/api/ws?token=x&extApiVersion=abc'))).toBeNull()
  })
})

describe('createExtAwareWsVerifier', () => {
  const tokensMatch = (actual: string | undefined, expected: string) => actual === expected

  function makeVerifier(store: PairingStore, rendererCalls: { count: number }) {
    return createExtAwareWsVerifier({
      pairing: store,
      rendererVerify: (_info, cb) => {
        rendererCalls.count++
        cb(true)
      },
      getLaunchToken: () => TOKEN,
      tokensMatch,
    })
  }

  function info(origin: string, url: string) {
    return { origin, req: { url } as IncomingMessage, secure: false }
  }

  function run(verifier: ReturnType<typeof makeVerifier>, origin: string, url: string) {
    let result: { ok: boolean; code?: number } = { ok: false }
    verifier(info(origin, url), (ok, code) => {
      result = { ok, code }
    })
    return result
  }

  it('delegates a loopback origin to the renderer verifier verbatim', () => {
    const calls = { count: 0 }
    const v = makeVerifier(pairedStore(), calls)
    const r = run(v, 'http://127.0.0.1:5173', `/api/ws?token=${TOKEN}`)
    expect(r.ok).toBe(true)
    expect(calls.count).toBe(1)
  })

  it('accepts a paired extension upgrade with token + matching extApiVersion', () => {
    const v = makeVerifier(pairedStore(), { count: 0 })
    const r = run(v, `chrome-extension://${EXT_ID}`, `/api/ws?token=${TOKEN}&extApiVersion=${EXT_API_VERSION}`)
    expect(r).toEqual({ ok: true, code: undefined })
  })

  it('rejects a paired extension upgrade with a wrong token (401)', () => {
    const v = makeVerifier(pairedStore(), { count: 0 })
    const r = run(v, `chrome-extension://${EXT_ID}`, `/api/ws?token=wrong&extApiVersion=${EXT_API_VERSION}`)
    expect(r).toEqual({ ok: false, code: 401 })
  })

  it('rejects a paired extension upgrade with an unsupported extApiVersion (400)', () => {
    const v = makeVerifier(pairedStore(), { count: 0 })
    const r = run(v, `chrome-extension://${EXT_ID}`, `/api/ws?token=${TOKEN}&extApiVersion=99`)
    expect(r).toEqual({ ok: false, code: 400 })
  })

  it('rejects a paired extension upgrade missing extApiVersion (400)', () => {
    const v = makeVerifier(pairedStore(), { count: 0 })
    const r = run(v, `chrome-extension://${EXT_ID}`, `/api/ws?token=${TOKEN}`)
    expect(r).toEqual({ ok: false, code: 400 })
  })

  it('rejects an extension origin when unpaired (403, fail-closed)', () => {
    const v = makeVerifier(new PairingStore(), { count: 0 })
    const r = run(v, `chrome-extension://${EXT_ID}`, `/api/ws?token=${TOKEN}&extApiVersion=${EXT_API_VERSION}`)
    expect(r).toEqual({ ok: false, code: 403 })
  })

  it('rejects an extension origin whose id does not match the paired id (403)', () => {
    const otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    const v = makeVerifier(pairedStore(), { count: 0 })
    const r = run(v, `chrome-extension://${otherId}`, `/api/ws?token=${TOKEN}&extApiVersion=${EXT_API_VERSION}`)
    expect(r).toEqual({ ok: false, code: 403 })
  })
})
