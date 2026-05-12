/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Renderer-side tests for `captureBridgeRegistry` (v0.2.0 / spec
 * v1.7.2 §6.10.6 / v1.5.2 §10.6.7.5).
 *
 * Covers:
 *   - `closeMountSync` uses `keepalive: true` so the request
 *     survives `pagehide` / `beforeunload` and the mount slot is
 *     released (PR #30 attempt 5 CodeX MEDIUM finding regression).
 *   - `closeMount` does NOT set `keepalive` (normal async path).
 *   - Both paths drop the active-bridge registration first so a
 *     late refresh response cannot inject into a stale bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetForTests,
  __setHostFetchForTests,
  __activeBridgesForTests,
  closeMount,
  closeMountSync,
  registerBridge,
} from '../../src/renderer/app-host/captureBridgeRegistry'

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const MOUNT_ID = '11223344556677889900aabbccddeeff'

beforeEach(() => {
  __resetForTests()
})

afterEach(() => {
  __resetForTests()
})

describe('captureBridgeRegistry — unload keepalive contract', () => {
  it('closeMountSync attaches keepalive: true to the underlying fetch', () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
    __setHostFetchForTests(
      fetchStub as unknown as Parameters<typeof __setHostFetchForTests>[0],
    )
    closeMountSync(MOUNT_ID, noopLog)
    expect(fetchStub).toHaveBeenCalledOnce()
    const init = fetchStub.mock.calls[0][1] as RequestInit
    expect((init as RequestInit & { keepalive?: boolean }).keepalive).toBe(true)
    expect(init.method).toBe('POST')
    const body = typeof init.body === 'string' ? init.body : ''
    expect(JSON.parse(body)).toEqual({ mountId: MOUNT_ID })
  })

  it('closeMount does NOT set keepalive (normal async cleanup path)', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
    __setHostFetchForTests(
      fetchStub as unknown as Parameters<typeof __setHostFetchForTests>[0],
    )
    await closeMount(MOUNT_ID, noopLog)
    expect(fetchStub).toHaveBeenCalledOnce()
    const init = fetchStub.mock.calls[0][1] as RequestInit
    expect(
      (init as RequestInit & { keepalive?: boolean }).keepalive,
    ).toBeUndefined()
  })

  it('closeMountSync drops the active-bridge registration before issuing the fetch', () => {
    let fetchedAfterDelete = false
    const fetchStub = vi.fn(async () => {
      fetchedAfterDelete = __activeBridgesForTests().get(MOUNT_ID) === undefined
      return new Response(null, { status: 200 })
    })
    __setHostFetchForTests(
      fetchStub as unknown as Parameters<typeof __setHostFetchForTests>[0],
    )
    registerBridge({
      mountId: MOUNT_ID,
      appId: 'app-a',
      setToken: () => {},
      rejectPending: () => {},
    })
    expect(__activeBridgesForTests().get(MOUNT_ID)).toBeDefined()
    closeMountSync(MOUNT_ID, noopLog)
    expect(__activeBridgesForTests().get(MOUNT_ID)).toBeUndefined()
    expect(fetchStub).toHaveBeenCalledOnce()
    expect(fetchedAfterDelete).toBe(true)
  })

  it('closeMountSync swallows synchronous fetch errors so unload does not block', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('synchronous failure')
    })
    __setHostFetchForTests(
      fetchStub as unknown as Parameters<typeof __setHostFetchForTests>[0],
    )
    expect(() => closeMountSync(MOUNT_ID, noopLog)).not.toThrow()
    expect(noopLog.warn).toHaveBeenCalled()
  })
})
