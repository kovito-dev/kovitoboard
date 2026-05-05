/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Tests for src/renderer/lib/global-errors.ts
 *
 * Verifies that:
 * - `setupGlobalErrorHandlers()` registers exactly one handler per
 *   target ('error' and 'unhandledrejection') and is idempotent
 *   (calling it twice does not double-register).
 * - Both handlers forward to the renderer logger via log.error.
 * - Neither handler calls `event.preventDefault()` (Playwright
 *   pageerror compatibility).
 *
 * We construct a minimal `window`-like stand-in instead of pulling in
 * jsdom; the module only consumes `addEventListener`.
 */

interface FakeWindowEvent {
  preventDefault: () => void
  preventDefaultCalled: boolean
}

function makeErrorEvent(extra: Partial<FakeWindowEvent> & Record<string, unknown>): FakeWindowEvent {
  const ev: FakeWindowEvent = {
    preventDefault: () => {
      ev.preventDefaultCalled = true
    },
    preventDefaultCalled: false,
    ...extra,
  } as FakeWindowEvent
  return ev
}

describe('renderer global-errors', () => {
  let listeners: Map<string, Array<(ev: unknown) => void>>
  let addSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // Fresh module state per test
    vi.resetModules()

    listeners = new Map()
    addSpy = vi.fn((type: string, fn: (ev: unknown) => void) => {
      const arr = listeners.get(type) ?? []
      arr.push(fn)
      listeners.set(type, arr)
    })
    ;(globalThis as unknown as { window: { addEventListener: typeof addSpy } }).window = {
      addEventListener: addSpy,
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as Record<string, unknown>).window
  })

  it('registers exactly one error and one unhandledrejection listener', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../../src/renderer/lib/global-errors'
    )
    setupGlobalErrorHandlers()

    expect(addSpy).toHaveBeenCalledTimes(2)
    expect(listeners.get('error')).toHaveLength(1)
    expect(listeners.get('unhandledrejection')).toHaveLength(1)
  })

  it('is idempotent — second call does not register duplicates', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../../src/renderer/lib/global-errors'
    )
    setupGlobalErrorHandlers()
    setupGlobalErrorHandlers()
    expect(addSpy).toHaveBeenCalledTimes(2)
  })

  it('forwards uncaught errors to the logger via console.error', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../../src/renderer/lib/global-errors'
    )
    setupGlobalErrorHandlers()

    const handler = listeners.get('error')![0]
    const ev = makeErrorEvent({
      message: 'boom',
      filename: 'app.tsx',
      lineno: 42,
      colno: 7,
      error: new Error('boom'),
    })
    handler(ev)

    expect(console.error).toHaveBeenCalled()
    const args = (console.error as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]
    expect(args[0]).toBe('[global-errors] Uncaught error')
    // Did NOT call preventDefault — pageerror compat
    expect(ev.preventDefaultCalled).toBe(false)
  })

  it('forwards unhandledrejection (Error reason) to the logger', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../../src/renderer/lib/global-errors'
    )
    setupGlobalErrorHandlers()

    const handler = listeners.get('unhandledrejection')![0]
    const ev = makeErrorEvent({ reason: new Error('rejected') })
    handler(ev)

    expect(console.error).toHaveBeenCalled()
    const args = (console.error as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]
    expect(args[0]).toBe('[global-errors] Unhandled promise rejection')
    expect(ev.preventDefaultCalled).toBe(false)
  })

  it('forwards unhandledrejection (non-Error reason) to the logger', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../../src/renderer/lib/global-errors'
    )
    setupGlobalErrorHandlers()

    const handler = listeners.get('unhandledrejection')![0]
    const ev = makeErrorEvent({ reason: 'string-reason' })
    handler(ev)

    expect(console.error).toHaveBeenCalled()
    expect(ev.preventDefaultCalled).toBe(false)
  })
})
