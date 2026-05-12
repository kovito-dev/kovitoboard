/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Renderer-side tests for the v0.2.0 capture bridge
 * (`window.kb.capture` implementation). Covers the local fast-path
 * refusal, the success round-trip, and structured error handling on
 * 403 responses from `/api/app/capture/<kind>`.
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

describe('captureBridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects locally with CaptureNotDeclaredError when captureRequires omits the kind (step 3)', async () => {
    const bridge = createCaptureBridge({
      appId: 'test-app',
      captureRequires: ['exposed-context'],
      approvedCaptures: ['exposed-context'],
      log: noopLog,
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotDeclaredError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects locally with CaptureNotApprovedError when only approvedCaptures omits the kind (step 4)', async () => {
    // captureRequires contains the kind → step 3 passes locally.
    // approvedCaptures does not → step 4 short-circuits.
    const bridge = createCaptureBridge({
      appId: 'test-app',
      captureRequires: ['a11y'],
      approvedCaptures: [],
      log: noopLog,
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureNotApprovedError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('round-trips the server when both caches contain the kind', async () => {
    const bridge = createCaptureBridge({
      appId: 'test-app',
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
      log: noopLog,
    })
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/app/capture/a11y',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ appId: 'test-app' }),
      }),
    )
  })

  it('queries the server even with no client cache (server-only mode)', async () => {
    const bridge = createCaptureBridge({
      appId: 'test-app',
      log: noopLog,
    })
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('wraps a server 403 body in CaptureRejectedError', async () => {
    const bridge = createCaptureBridge({
      appId: 'test-app',
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
      log: noopLog,
    })
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'CaptureNotApproved',
          message: 'Capture a11y is not approved',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).rejects.toMatchObject({
      name: 'CaptureRejectedError',
      code: 'CaptureNotApproved',
      status: 403,
    })
  })

  it('falls back to a generic code when the 403 body is malformed', async () => {
    const bridge = createCaptureBridge({
      appId: 'test-app',
      captureRequires: ['a11y'],
      approvedCaptures: ['a11y'],
      log: noopLog,
    })
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('not-json', { status: 403 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    await expect(bridge.a11y()).rejects.toBeInstanceOf(CaptureRejectedError)
  })
})
