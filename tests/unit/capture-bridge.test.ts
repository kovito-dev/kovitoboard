/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Renderer-side tests for the v0.2.0 capture bridge
 * (`window.kb.capture` implementation, spec v1.6 §6.10.6).
 *
 * Covers:
 *   - mount-time token issuance (200, grandfather, store-full,
 *     network error)
 *   - capture calls with the token forwarded in the
 *     X-KB-Capture-Token header (never in the body)
 *   - client-side fast-path refusals from the declaration /
 *     consent caches
 *   - server-side 403 reception: the capture-token-* reasons
 *     collapse to CaptureNotApprovedError to prevent attacker
 *     token-oracling
 *   - unmount-time revoke
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCaptureBridge,
  CaptureNotApprovedError,
  CaptureNotDeclaredError,
  CaptureRejectedError,
} from '../../src/renderer/lib/captureBridge'

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const VALID_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** Build a fetch stub that responds to known URLs in sequence. */
function buildFetchStub(
  responses: Record<string, Response | Response[]>,
): ReturnType<typeof vi.fn> {
  const queues: Record<string, Response[]> = {}
  for (const [url, value] of Object.entries(responses)) {
    queues[url] = Array.isArray(value) ? [...value] : [value]
  }
  return vi.fn(async (input: string, _init?: RequestInit) => {
    const queue = queues[input]
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected fetch: ${input}`)
    }
    const next = queue.shift()
    if (!next) {
      throw new Error(`fetch queue exhausted: ${input}`)
    }
    return next
  })
}

describe('captureBridge (v1.6 capture-token mechanism)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('issueToken', () => {
    it('caches a 32-char hex token from a 200 response', async () => {
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        '/api/app/capture/a11y': new Response(null, { status: 204 }),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await bridge.a11y()
      // Second fetch call should be the capture POST with the
      // cached token forwarded in the header.
      const captureCall = fetchStub.mock.calls.find(
        ([url]) => url === '/api/app/capture/a11y',
      )
      expect(captureCall).toBeDefined()
      const init = captureCall![1] as RequestInit
      const headers = init.headers as Record<string, string>
      expect(headers['x-kb-capture-token']).toBe(VALID_TOKEN)
      // The token MUST travel via the header (I-CR4); the body
      // must NOT carry appId or token.
      expect(init.body).toBe('{}')
    })

    it('stays in grandfather mode when the server returns token=null', async () => {
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: null, expiresAt: null, reason: 'grandfather-no-capture' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      // a11y throws CaptureNotDeclaredError (the grandfather
      // recipe never declared the capability), without hitting
      // the network.
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotDeclaredError)
      // Only the issue call landed; capture never reached fetch.
      expect(fetchStub.mock.calls).toHaveLength(1)
    })

    it('falls back to fail-fast when the server returns 503 store-full', async () => {
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ error: 'CaptureTokenStoreFull' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      // No token cached → a11y refuses without a server round-trip
      // and surfaces as CaptureNotApprovedError (the cause is
      // opaque to recipe code).
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
      expect(fetchStub.mock.calls).toHaveLength(1)
    })

    it('falls back to fail-fast on a network error during issue', async () => {
      const fetchStub = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    })
  })

  describe('callServer', () => {
    it('rejects locally with CaptureNotDeclaredError when captureRequires omits the kind', async () => {
      const fetchStub = vi.fn()
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({
        appId: 'app-a',
        captureRequires: ['exposed-context'],
        approvedCaptures: ['exposed-context'],
        log: noopLog,
      })
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotDeclaredError)
      expect(fetchStub).not.toHaveBeenCalled()
    })

    it('rejects locally with CaptureNotApprovedError when only approvedCaptures omits the kind', async () => {
      const fetchStub = vi.fn()
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({
        appId: 'app-a',
        captureRequires: ['a11y'],
        approvedCaptures: [],
        log: noopLog,
      })
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
      expect(fetchStub).not.toHaveBeenCalled()
    })

    it('collapses server-side capture-token-* 403 into CaptureNotApprovedError', async () => {
      // The bridge has a token cached but the server says it
      // expired (race between client expiry awareness and server
      // sweep). The client must NOT surface the technical reason
      // to recipe code — token-oracle prevention per spec v1.3
      // §10.5.2.
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        '/api/app/capture/a11y': new Response(
          JSON.stringify({
            error: 'NoActiveRecipe',
            message: 'Capture token has expired.',
            details: { kind: 'a11y', reason: 'capture-token-expired' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    })

    it('preserves CaptureRejectedError for non-token 403 reasons', async () => {
      // `not-approved` is a legitimate recipe-author-facing
      // outcome (user declined the capability at install time) —
      // surface the structured envelope verbatim.
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        '/api/app/capture/a11y': new Response(
          JSON.stringify({
            error: 'CaptureNotApproved',
            message: 'Capture a11y is not approved',
            details: { kind: 'a11y', reason: 'not-approved' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await expect(bridge.a11y()).rejects.toMatchObject({
        name: 'CaptureRejectedError',
        code: 'CaptureNotApproved',
        status: 403,
      })
    })

    it('falls back to a generic code when the 403 body is malformed', async () => {
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        '/api/app/capture/a11y': new Response('not-json', { status: 403 }),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureRejectedError)
    })
  })

  describe('revokeToken', () => {
    it('POSTs to revoke with the cached token in the header', async () => {
      const fetchStub = buildFetchStub({
        '/api/app/capture-token/issue': new Response(
          JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        '/api/app/capture-token/revoke': new Response(
          JSON.stringify({ ok: true, revoked: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      await bridge.revokeToken()
      const revokeCall = fetchStub.mock.calls.find(
        ([url]) => url === '/api/app/capture-token/revoke',
      )
      expect(revokeCall).toBeDefined()
      const init = revokeCall![1] as RequestInit
      const headers = init.headers as Record<string, string>
      expect(headers['x-kb-capture-token']).toBe(VALID_TOKEN)
    })

    it('skips the network call when no token is cached', async () => {
      const fetchStub = vi.fn()
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.revokeToken()
      expect(fetchStub).not.toHaveBeenCalled()
    })

    it('swallows network errors during revoke', async () => {
      const fetchStub = vi.fn(async (url: string) => {
        if (url === '/api/app/capture-token/issue') {
          return new Response(
            JSON.stringify({ token: VALID_TOKEN, expiresAt: Date.now() + 60_000, reason: null }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        throw new Error('ECONNREFUSED')
      })
      vi.stubGlobal('fetch', fetchStub)
      const bridge = createCaptureBridge({ appId: 'app-a', log: noopLog })
      await bridge.issueToken()
      // revokeToken resolves without throwing even on failure —
      // cleanup paths must not block on a flaky network.
      await expect(bridge.revokeToken()).resolves.toBeUndefined()
    })
  })
})
