/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Renderer-side tests for the v0.2.0 capture bridge
 * (`window.kb.capture` implementation, spec v1.7 §6.10.6).
 *
 * The bridge no longer calls `/api/app/capture-token/issue`
 * directly (host-only via `captureBridgeRegistry`). It receives an
 * initial mountId + token through `createCaptureBridge`'s closure
 * parameters and asks the registry to refresh on a stale-token
 * 403. We mock the registry's `requestRefresh` to drive both the
 * success and failure branches.
 *
 * Coverage:
 *   - capture calls send the cached token in `X-KB-Capture-Token`
 *     and never in the body (I-CR4)
 *   - declaration / consent caches refuse calls before the network
 *   - grandfather (mountId === null) fails fast with
 *     CaptureNotDeclaredError
 *   - server-side 403 token-shape reasons collapse to
 *     CaptureNotApprovedError to deny the token oracle (after a
 *     single refresh attempt failed)
 *   - successful refresh retries the call exactly once
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCaptureBridge,
  CaptureNotApprovedError,
  CaptureNotDeclaredError,
  CaptureRejectedError,
} from '../../src/renderer/lib/captureBridge'
import * as registry from '../../src/renderer/app-host/captureBridgeRegistry'

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const INITIAL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REFRESHED_TOKEN = '99887766554433221122334455667788'
const MOUNT_ID = '11223344556677889900aabbccddeeff'

beforeEach(() => {
  registry.__resetForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureBridge (v1.7 mount-bound capture token)', () => {
  it('caches the initial token and forwards it via X-KB-Capture-Token (no appId in body)', async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      log: noopLog,
    })
    await bridge.a11y()
    expect(fetchStub).toHaveBeenCalledOnce()
    const call = fetchStub.mock.calls[0]
    const init = call[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('x-kb-capture-token')).toBe(INITIAL_TOKEN)
    // I-CR4: appId is NOT sent in the body. The body is empty JSON.
    const body = typeof init.body === 'string' ? init.body : ''
    expect(JSON.parse(body)).toEqual({})
    bridge.dispose()
  })

  it('refuses with CaptureNotDeclaredError when the declaration cache excludes the kind', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      captureRequires: ['exposed-context'],
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotDeclaredError)
    expect(fetchStub).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('refuses with CaptureNotApprovedError when the consent cache excludes the kind', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      captureRequires: ['a11y'],
      approvedCaptures: [],
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    expect(fetchStub).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('grandfather state fails fast with CaptureNotDeclaredError', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      state: 'grandfather',
      mountId: null,
      initialToken: null,
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotDeclaredError)
    expect(fetchStub).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('pending state (pre-bootstrap) fails fast with the OPAQUE CaptureNotApprovedError, NOT CaptureNotDeclaredError', async () => {
    // PR #30 attempt 5 CodeX MEDIUM finding regression: capture
    // calls that arrive before `openMount()` resolves must NOT be
    // misclassified as grandfather. The opaque NotApproved envelope
    // hides the bootstrap timing from recipe code.
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      state: 'pending',
      mountId: null,
      initialToken: null,
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    await expect(bridge.a11y()).rejects.not.toBeInstanceOf(CaptureNotDeclaredError)
    expect(fetchStub).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('open-failed state fails fast with the opaque CaptureNotApprovedError', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      state: 'open-failed',
      mountId: null,
      initialToken: null,
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    await expect(bridge.a11y()).rejects.not.toBeInstanceOf(CaptureNotDeclaredError)
    expect(fetchStub).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('collapses server-side capture-token-expired 403 into CaptureNotApprovedError when refresh fails', async () => {
    const fetchStub = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'NoActiveRecipe',
          details: { reason: 'capture-token-expired' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchStub)
    // Force the registry's refresh to fail.
    const refreshSpy = vi
      .spyOn(registry, 'requestRefresh')
      .mockResolvedValue(null)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    expect(refreshSpy).toHaveBeenCalledWith(MOUNT_ID, noopLog)
    bridge.dispose()
  })

  it('retries the call once with the refreshed token on a successful refresh', async () => {
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          error: 'NoActiveRecipe',
          details: { reason: 'capture-token-expired' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
      new Response(null, { status: 204 }),
    ]
    let callIdx = 0
    const fetchStub = vi.fn(async () => {
      const r = responses[callIdx]
      callIdx += 1
      return r
    })
    vi.stubGlobal('fetch', fetchStub)
    vi
      .spyOn(registry, 'requestRefresh')
      .mockResolvedValue(REFRESHED_TOKEN)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      log: noopLog,
    })
    await expect(bridge.a11y()).resolves.toBeUndefined()
    expect(fetchStub).toHaveBeenCalledTimes(2)
    const retryHeaders = new Headers(
      (fetchStub.mock.calls[1][1] as RequestInit).headers,
    )
    expect(retryHeaders.get('x-kb-capture-token')).toBe(REFRESHED_TOKEN)
    bridge.dispose()
  })

  it('preserves CaptureRejectedError for non-token 403 reasons', async () => {
    const fetchStub = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'CaptureRateLimited',
          message: 'too many capture calls',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchStub)
    const bridge = createCaptureBridge({
      appId: 'app-a',
      mountId: MOUNT_ID,
      initialToken: INITIAL_TOKEN,
      log: noopLog,
    })
    await expect(bridge.a11y()).rejects.toMatchObject({
      name: 'CaptureRejectedError',
      code: 'CaptureRateLimited',
    })
    expect(bridge.a11y).toBeInstanceOf(Function)
    // ensure class exposure (for downstream branching)
    expect(new CaptureRejectedError('x', 'y', 500).code).toBe('x')
    bridge.dispose()
  })
})
