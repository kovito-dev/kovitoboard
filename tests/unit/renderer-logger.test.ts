/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _queueLengthForTests,
  _resetLoggerForTests,
  attachLogWebSocket,
  createLogger,
} from '../../src/renderer/lib/logger'

/**
 * Minimal in-memory WebSocket stand-in. Captures sent payloads and
 * exposes hooks to drive `open` / `close` events the same way a real
 * socket would. Avoids depending on jsdom/happy-dom for this suite.
 */
class FakeSocket {
  readyState = 0 // CONNECTING
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  private listeners = new Map<string, Array<(ev?: unknown) => void>>()
  sent: string[] = []
  sendShouldThrow = false

  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  send(data: string): void {
    if (this.sendShouldThrow) throw new Error('send failed')
    this.sent.push(data)
  }

  open(): void {
    this.readyState = 1
    for (const fn of this.listeners.get('open') ?? []) fn()
  }

  close(): void {
    this.readyState = 3
    for (const fn of this.listeners.get('close') ?? []) fn()
  }
}

// Make `WebSocket.OPEN` etc. resolve at runtime since the logger
// references it (the value is the same as FakeSocket.OPEN === 1).
;(globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket as unknown as typeof FakeSocket

beforeEach(() => {
  _resetLoggerForTests()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderer logger / createLogger', () => {
  it('emits to console with the [component] prefix', () => {
    const log = createLogger('foo')
    log.info('hello')
    expect(console.info).toHaveBeenCalledWith('[foo] hello')
  })

  it('passes the structured data object as the second console arg', () => {
    const log = createLogger('foo')
    log.warn({ count: 3 }, 'something')
    expect(console.warn).toHaveBeenCalledWith('[foo] something', { count: 3 })
  })

  it('routes debug to console.log, info to console.info, warn to warn, error to error', () => {
    const log = createLogger('mix')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(console.log).toHaveBeenCalledWith('[mix] d')
    expect(console.info).toHaveBeenCalledWith('[mix] i')
    expect(console.warn).toHaveBeenCalledWith('[mix] w')
    expect(console.error).toHaveBeenCalledWith('[mix] e')
  })
})

describe('renderer logger / WS transport', () => {
  it('queues entries until the socket opens, then flushes', () => {
    const log = createLogger('q')
    log.info('first')
    log.warn({ x: 1 }, 'second')
    expect(_queueLengthForTests()).toBe(2)

    const sock = new FakeSocket()
    attachLogWebSocket(sock as unknown as WebSocket)
    sock.open()

    expect(_queueLengthForTests()).toBe(0)
    expect(sock.sent).toHaveLength(2)
    const first = JSON.parse(sock.sent[0])
    expect(first.type).toBe('client_log')
    expect(first.payload).toMatchObject({ level: 'info', component: 'q', msg: 'first' })
    const second = JSON.parse(sock.sent[1])
    expect(second.payload).toMatchObject({
      level: 'warn',
      component: 'q',
      msg: 'second',
      data: { x: 1 },
    })
  })

  it('sends immediately when the socket is already open', () => {
    const sock = new FakeSocket()
    attachLogWebSocket(sock as unknown as WebSocket)
    sock.open()

    const log = createLogger('live')
    log.info('hot')
    expect(sock.sent).toHaveLength(1)
    expect(_queueLengthForTests()).toBe(0)
  })

  it('returns to queueing mode after the socket closes', () => {
    const sock = new FakeSocket()
    attachLogWebSocket(sock as unknown as WebSocket)
    sock.open()
    sock.close()

    const log = createLogger('post-close')
    log.info('queued')
    expect(_queueLengthForTests()).toBe(1)
    expect(sock.sent).toHaveLength(0)
  })

  it('drops oldest entries on queue overflow and warns once', () => {
    const log = createLogger('overflow')
    // Push 600 entries (MAX_QUEUE = 500)
    for (let i = 0; i < 600; i++) log.info({ i }, 'spam')
    expect(_queueLengthForTests()).toBe(500)

    // Exactly one overflow warning
    const calls = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const overflowWarnings = calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('queue overflow'),
    )
    expect(overflowWarnings).toHaveLength(1)
  })
})

describe('renderer logger / attachLogWebSocket idempotence (HMR-safety)', () => {
  it('keeps the existing OPEN socket and ignores re-attach', () => {
    const first = new FakeSocket()
    attachLogWebSocket(first as unknown as WebSocket)
    first.open()

    const second = new FakeSocket()
    attachLogWebSocket(second as unknown as WebSocket)
    second.open() // should be a no-op for the logger

    const log = createLogger('hmr')
    log.info('which socket?')
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
  })

  it('replaces the socket if the previous one is closed', () => {
    const first = new FakeSocket()
    attachLogWebSocket(first as unknown as WebSocket)
    first.open()
    first.close()

    const second = new FakeSocket()
    attachLogWebSocket(second as unknown as WebSocket)
    second.open()

    const log = createLogger('hmr2')
    log.info('to second')
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(1)
  })
})

describe('renderer logger / send failure fallback', () => {
  it('falls back to the queue when ws.send throws', () => {
    const sock = new FakeSocket()
    attachLogWebSocket(sock as unknown as WebSocket)
    sock.open()
    sock.sendShouldThrow = true

    const log = createLogger('flaky')
    log.info('will throw')
    // Send was attempted but failed -> entry now in queue
    expect(_queueLengthForTests()).toBe(1)
  })
})
