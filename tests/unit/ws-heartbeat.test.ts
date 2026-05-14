/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * WebSocket heartbeat — unit-level coverage for the supplementary
 * review §S5 hardening. Real `ws` sockets are not used here; instead
 * we drive the tracker against a hand-rolled fake whose surface
 * matches the slice of the `ws` API the heartbeat actually touches
 * (`on(event, handler)`, `ping()`, `terminate()`, `readyState`).
 *
 * The Vitest fake timers are used to advance the tick loop
 * deterministically — the production interval defaults to 30 s, but
 * the helper accepts an `intervalMs` knob so the test can run a tick
 * at any virtual moment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { WebSocket, WebSocketServer } from 'ws'
import {
  createHeartbeatTracker,
  installWebSocketHeartbeat,
  attachConnectionHooks,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from '../../src/server/ws-heartbeat'

interface FakeSocket extends EventEmitter {
  readyState: number
  ping: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
}

function makeFakeSocket(): FakeSocket {
  const sock = new EventEmitter() as FakeSocket
  sock.readyState = 1 // OPEN
  sock.ping = vi.fn()
  sock.terminate = vi.fn()
  return sock
}

interface FakeServer extends EventEmitter {
  clients: Set<FakeSocket>
  /** Helper used by the tests to fire the `connection` event. */
  emitConnection(ws: FakeSocket): void
}

function makeFakeServer(): FakeServer {
  const server = new EventEmitter() as FakeServer
  server.clients = new Set<FakeSocket>()
  server.emitConnection = (ws: FakeSocket) => {
    server.clients.add(ws)
    server.emit('connection', ws)
  }
  return server
}

function silentLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ws-heartbeat — DEFAULT_HEARTBEAT_INTERVAL_MS', () => {
  it('matches the ws-library recommended 30 s tick', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })
})

describe('ws-heartbeat — alive cycle', () => {
  it('pings every client on every tick when sockets remain responsive', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // Tick 1: tracker flips `isAlive` to false, calls ping.
    vi.advanceTimersByTime(100)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    expect(ws.terminate).not.toHaveBeenCalled()

    // Simulate the pong response — refreshes `isAlive` to true.
    ws.emit('pong')

    // Tick 2: still alive, pings again.
    vi.advanceTimersByTime(100)
    expect(ws.ping).toHaveBeenCalledTimes(2)
    expect(ws.terminate).not.toHaveBeenCalled()

    tracker.handle.stop()
  })

  it('refreshes the alive marker every time a pong arrives between ticks', () => {
    const server = makeFakeServer()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // Ping once, pong returns, ping again, pong returns, ping again.
    // After three full alive cycles the socket must never be
    // terminated.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(100)
      ws.emit('pong')
    }
    expect(ws.ping).toHaveBeenCalledTimes(3)
    expect(ws.terminate).not.toHaveBeenCalled()

    tracker.handle.stop()
  })
})

describe('ws-heartbeat — dead-connection detection', () => {
  it('terminates a client that misses the pong window', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // Tick 1: flips `isAlive` to false, pings.
    vi.advanceTimersByTime(100)
    expect(ws.ping).toHaveBeenCalledTimes(1)

    // No pong arrives.

    // Tick 2: `isAlive` is still false → terminate is called and
    // no new ping is sent against the dead socket.
    vi.advanceTimersByTime(100)
    expect(ws.terminate).toHaveBeenCalledTimes(1)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalled()

    tracker.handle.stop()
  })

  it('does not terminate a client that has never received a tick yet', () => {
    const server = makeFakeServer()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // No tick fires — terminate must never be called even though
    // `isAlive` has not been explicitly refreshed since the
    // connection moment.
    vi.advanceTimersByTime(50)
    expect(ws.terminate).not.toHaveBeenCalled()

    tracker.handle.stop()
  })

  it('continues to terminate further dead clients after the first one', () => {
    const server = makeFakeServer()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
    })
    const wsA = makeFakeSocket()
    const wsB = makeFakeSocket()
    server.emitConnection(wsA)
    server.emitConnection(wsB)
    tracker.attach(wsA as unknown as WebSocket)
    tracker.attach(wsB as unknown as WebSocket)

    // Tick 1: pings both.
    vi.advanceTimersByTime(100)
    expect(wsA.ping).toHaveBeenCalledTimes(1)
    expect(wsB.ping).toHaveBeenCalledTimes(1)

    // wsA responds, wsB does not.
    wsA.emit('pong')

    // Tick 2: wsA stays alive (gets pinged again), wsB is
    // terminated.
    vi.advanceTimersByTime(100)
    expect(wsA.ping).toHaveBeenCalledTimes(2)
    expect(wsB.terminate).toHaveBeenCalledTimes(1)
    expect(wsB.ping).toHaveBeenCalledTimes(1) // no new ping on the dead socket

    tracker.handle.stop()
  })
})

describe('ws-heartbeat — error handling', () => {
  it('logs `ws.error` events through the structured logger instead of throwing', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    const boom = new Error('socket boom')
    // `EventEmitter.emit('error', ...)` throws when no listener is
    // attached; the heartbeat's `attachConnectionHooks` MUST install
    // a listener so this call does not escalate to an
    // `uncaughtException`.
    expect(() => ws.emit('error', boom)).not.toThrow()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.stringContaining('WebSocket connection error'),
    )

    tracker.handle.stop()
  })

  it('swallows a throwing ping() and retries the client on the next tick', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
    })
    const ws = makeFakeSocket()
    ws.ping = vi.fn().mockImplementationOnce(() => {
      throw new Error('ping failed')
    })
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // Tick 1: ping throws; the loop must continue and not crash.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    expect(log.warn).toHaveBeenCalled()

    // Tick 2: still alive flag is false → terminate is called.
    vi.advanceTimersByTime(100)
    expect(ws.terminate).toHaveBeenCalledTimes(1)

    tracker.handle.stop()
  })

  it('swallows a throwing terminate() and continues the loop on later ticks', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
    })
    const ws = makeFakeSocket()
    ws.terminate = vi.fn().mockImplementation(() => {
      throw new Error('terminate failed')
    })
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    // Tick 1: ping fires, isAlive flips to false.
    vi.advanceTimersByTime(100)
    // Tick 2: terminate throws; the loop must not propagate.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    expect(log.warn).toHaveBeenCalled()

    tracker.handle.stop()
  })
})

describe('ws-heartbeat — lifecycle', () => {
  it('clears the interval when stop() is called explicitly', () => {
    const server = makeFakeServer()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    tracker.handle.stop()
    vi.advanceTimersByTime(1000)
    expect(ws.ping).not.toHaveBeenCalled()
  })

  it('clears the interval automatically when the server emits `close`', () => {
    const server = makeFakeServer()
    const tracker = createHeartbeatTracker(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)
    tracker.attach(ws as unknown as WebSocket)

    server.emit('close')
    vi.advanceTimersByTime(1000)
    expect(ws.ping).not.toHaveBeenCalled()
  })
})

describe('ws-heartbeat — installWebSocketHeartbeat default attach', () => {
  it('auto-wires the per-connection listeners when attachOnConnection defaults to true', () => {
    const server = makeFakeServer()
    const log = silentLog()
    const aliveTracker = new WeakMap<WebSocket, boolean>()
    const handle = installWebSocketHeartbeat(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log,
      aliveTracker,
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)

    expect(aliveTracker.get(ws as unknown as WebSocket)).toBe(true)

    vi.advanceTimersByTime(100)
    expect(ws.ping).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('skips the auto-wire when attachOnConnection is false', () => {
    const server = makeFakeServer()
    const aliveTracker = new WeakMap<WebSocket, boolean>()
    const handle = installWebSocketHeartbeat(server as unknown as WebSocketServer, {
      intervalMs: 100,
      log: silentLog(),
      attachOnConnection: false,
      aliveTracker,
    })
    const ws = makeFakeSocket()
    server.emitConnection(ws)

    // Without a manual `attachConnectionHooks` call the tracker
    // never sees this socket, so it stays untouched by ticks.
    expect(aliveTracker.get(ws as unknown as WebSocket)).toBeUndefined()

    handle.stop()
  })
})

describe('ws-heartbeat — attachConnectionHooks unit', () => {
  it('writes the alive mark into the supplied tracker', () => {
    const aliveTracker = new WeakMap<WebSocket, boolean>()
    const ws = makeFakeSocket()
    attachConnectionHooks(ws as unknown as WebSocket, aliveTracker, silentLog())
    expect(aliveTracker.get(ws as unknown as WebSocket)).toBe(true)
  })

  it('refreshes the alive mark to true on every pong', () => {
    const aliveTracker = new WeakMap<WebSocket, boolean>()
    const ws = makeFakeSocket()
    attachConnectionHooks(ws as unknown as WebSocket, aliveTracker, silentLog())

    aliveTracker.set(ws as unknown as WebSocket, false)
    ws.emit('pong')
    expect(aliveTracker.get(ws as unknown as WebSocket)).toBe(true)
  })
})
