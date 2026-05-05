/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the `window.kb.log` exposure added in DEC-017 v1.3 P5-7.
 *
 * Verifies that injectKb(recipeId):
 *  - Attaches a `log` field to `window.kb` alongside the existing
 *    `call` bridge.
 *  - Routes log records through the renderer logger such that they
 *    are tagged with `component: "app.<recipeId>"` (the prefix is
 *    added by injectKb so recipe authors only specify the recipe id).
 *  - Cleans up `window.kb` (including `log`) on unmount.
 *  - Does not break the existing `window.kb.call` shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetLoggerForTests, attachLogWebSocket } from '../../src/renderer/lib/logger'
import { injectKb } from '../../src/renderer/app-host/injectKb'

class FakeSocket {
  readyState = 1
  static readonly OPEN = 1
  private listeners = new Map<string, Array<(ev?: unknown) => void>>()
  sent: string[] = []

  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  send(data: string): void {
    this.sent.push(data)
  }
}

beforeEach(() => {
  _resetLoggerForTests()
  // Make WebSocket constants resolvable in node — the logger references
  // `WebSocket.OPEN` at runtime.
  ;(globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket =
    FakeSocket as unknown as typeof FakeSocket
  // Stub `window` for injectKb (it assigns to window.kb).
  ;(globalThis as unknown as { window: { kb?: unknown } }).window = {}
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  _resetLoggerForTests()
  delete (globalThis as Record<string, unknown>).window
  vi.restoreAllMocks()
})

describe('injectKb / window.kb.log exposure', () => {
  it('attaches both call and log fields to window.kb', () => {
    const cleanup = injectKb('research-reports')
    const w = globalThis as unknown as { window: { kb?: unknown } }
    expect(w.window.kb).toBeDefined()
    const kb = w.window.kb as { call: unknown; log: unknown }
    expect(typeof kb.call).toBe('function')
    expect(kb.log).toBeDefined()
    cleanup()
  })

  it('exposes the four pino-shaped log methods', () => {
    injectKb('demo')
    const w = globalThis as unknown as { window: { kb?: { log?: Record<string, unknown> } } }
    const log = w.window.kb!.log!
    expect(typeof log.debug).toBe('function')
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
  })

  it('emits log records tagged with component "app.<recipeId>"', () => {
    const sock = new FakeSocket()
    attachLogWebSocket(sock as unknown as WebSocket)

    injectKb('research-reports')
    const w = globalThis as unknown as {
      window: { kb?: { log: { info: (data: object, msg: string) => void } } }
    }
    w.window.kb!.log.info({ jobId: 'j-1' }, 'started')

    // injectKb itself emits a "window.kb injected" log under
    // 'injectKb', so the SECOND send is the recipe-side log we triggered.
    expect(sock.sent.length).toBeGreaterThanOrEqual(2)
    const last = JSON.parse(sock.sent[sock.sent.length - 1]) as {
      type: string
      payload: { component: string; level: string; msg: string; data?: object }
    }
    expect(last.type).toBe('client_log')
    expect(last.payload.component).toBe('app.research-reports')
    expect(last.payload.level).toBe('info')
    expect(last.payload.msg).toBe('started')
    expect(last.payload.data).toEqual({ jobId: 'j-1' })
  })

  it('restores the ambient bridge shape on cleanup', () => {
    // Cleanup must NOT set window.kb to undefined: the always-on
    // ambient bridge (`exposeContext` + noop call + fallback log) is
    // bootstrapped at app start by installAmbientKbBridge() and has to
    // remain reachable from any non-recipe page after the recipe
    // unmounts. Setting undefined would silently break exposeContext
    // for builtin pages until a full reload.
    const cleanup = injectKb('demo')
    const w = globalThis as unknown as {
      window: {
        kb?: {
          call: (...args: unknown[]) => Promise<unknown>
          log: { info: (...args: unknown[]) => void }
          exposeContext: (payload: Record<string, unknown>) => void
        }
      }
    }
    expect(w.window.kb).toBeDefined()
    cleanup()
    expect(w.window.kb).toBeDefined()
    expect(typeof w.window.kb!.call).toBe('function')
    expect(typeof w.window.kb!.log.info).toBe('function')
    expect(typeof w.window.kb!.exposeContext).toBe('function')
  })

  it("does not reset window.kb when a sibling has already replaced it", () => {
    // React Router page-to-page navigation runs the new
    // RecipePageHost's useState lazy init (which calls injectKb) BEFORE
    // the old RecipePageHost's useEffect cleanup fires. If cleanup
    // unconditionally reset window.kb, the new recipe's bridge would be
    // wiped immediately and its first kb.call would either land on the
    // ambient noop or on whatever bridge happens to be active — which
    // is exactly the production bug the `=== self` guard fixes.
    const cleanupTodo = injectKb('todo')
    const w = globalThis as unknown as { window: { kb?: { log: { info: (...args: unknown[]) => void } } } }
    const todoLog = w.window.kb!.log

    // Sibling renders before our cleanup fires.
    injectKb('document-viewer')
    const docViewerLog = w.window.kb!.log
    expect(docViewerLog).not.toBe(todoLog)

    // Old wrapper unmounts and runs its cleanup; that must NOT clobber
    // the doc-viewer bridge.
    cleanupTodo()
    expect(w.window.kb!.log).toBe(docViewerLog)
  })
})
