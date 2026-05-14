/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * WebSocket connection heartbeat (supplementary review §S5).
 *
 * The vanilla `ws` server does not detect dead connections — when a
 * client disappears due to NAT timeout, network drop, or a hard browser
 * close that bypasses TCP FIN, the server side never receives a
 * `close` event. The connection stays in `wss.clients`, every broadcast
 * still calls `client.send(...)` against it, and over a long-running
 * session the client set grows monotonically.
 *
 * This module implements the canonical `ws` heartbeat pattern:
 *
 *   1. On every connection, mark the socket as `isAlive`.
 *   2. On every `pong`, refresh the `isAlive` mark.
 *   3. On every `interval` tick:
 *      - if `isAlive` is still `false` from the previous tick (i.e.
 *        the client never replied to the previous `ping`), call
 *        `terminate()` to forcibly close the socket and let `ws`
 *        emit the `close` event so the client falls out of
 *        `wss.clients`.
 *      - otherwise clear the `isAlive` mark and send a fresh `ping()`.
 *
 * The `isAlive` flag lives in a `WeakMap` rather than being attached
 * directly to the socket via `(ws as any).isAlive = ...`. The map
 * keeps the type contract clean (`WebSocket` from `ws` does not
 * declare an `isAlive` field) and is GC-safe — once the socket is
 * dropped from `wss.clients`, its `WeakMap` entry is collected too,
 * so a long-running server cannot accumulate stale entries.
 */
import type { Logger } from 'pino'
import type { WebSocket, WebSocketServer } from 'ws'

/** Default heartbeat interval (30 s) — matches the `ws` README pattern. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

export interface HeartbeatOptions {
  /**
   * Tick interval in milliseconds. Defaults to 30 s. Tests should
   * pass a much shorter value (e.g. 20 ms) so the dead-connection
   * detection path runs inside reasonable runtime bounds.
   */
  intervalMs?: number
  /**
   * Structured logger. The heartbeat emits warn-level events when a
   * dead client is terminated and warn-level events when the `ws`
   * connection itself reports an error. `console.*` is intentionally
   * not used so the redaction pipeline in
   * `logger.ts` / `buildLogRedactor()` applies.
   */
  log: Pick<Logger, 'warn' | 'info' | 'debug'>
}

/**
 * Stops a previously started heartbeat. Idempotent; safe to call
 * multiple times.
 */
export interface HeartbeatHandle {
  stop(): void
}

/**
 * Install the heartbeat loop on a `WebSocketServer`. Returns a
 * handle so the caller can stop the timer on shutdown (the timer is
 * also stopped automatically when the server emits `close`).
 *
 * Idempotency: calling `installWebSocketHeartbeat` twice on the same
 * server is supported but spawns two independent intervals — callers
 * should not do that. The exported `attachConnectionHooks` helper
 * lets callers wire the per-connection listeners themselves when
 * they already own a `wss.on('connection')` handler (which the main
 * server does for message dispatch); in that case the caller passes
 * `attachOnConnection: false` to avoid double-binding.
 */
export function installWebSocketHeartbeat(
  wss: WebSocketServer,
  options: HeartbeatOptions & {
    /**
     * When `true` (default) the helper installs its own
     * `wss.on('connection')` listener that wires the pong / error
     * hooks for every connecting socket. Pass `false` when the
     * caller already owns a `wss.on('connection')` handler and
     * intends to wire the hooks itself through
     * `attachConnectionHooks` (see `createHeartbeatTracker`).
     */
    attachOnConnection?: boolean
    /**
     * Optional external tracker so callers using the
     * `attachOnConnection: false` mode can share the same map
     * between their per-connection hook and the tick loop.
     * Without this every helper would allocate its own `WeakMap`
     * and the tick would observe an empty tracker.
     */
    aliveTracker?: WeakMap<WebSocket, boolean>
  } = { log: silentLogger() },
): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const log = options.log
  const aliveTracker = options.aliveTracker ?? new WeakMap<WebSocket, boolean>()

  if (options.attachOnConnection !== false) {
    wss.on('connection', (ws) => {
      attachConnectionHooks(ws, aliveTracker, log)
    })
  }

  const timer = setInterval(() => {
    for (const client of wss.clients) {
      // `aliveTracker.get` returning `undefined` means the
      // connection was opened so recently that the server has not
      // run a single tick against it yet. Treat that as "alive"
      // (do not terminate) and seed the entry on the spot.
      const isAlive = aliveTracker.get(client)
      if (isAlive === false) {
        log.warn(
          { readyState: client.readyState },
          'Terminating unresponsive WebSocket client (no pong since last tick)',
        )
        try {
          client.terminate()
        } catch (err) {
          log.warn({ err }, 'WebSocket terminate() threw; ignoring')
        }
        continue
      }
      aliveTracker.set(client, false)
      try {
        client.ping()
      } catch (err) {
        // A ping against an already-broken socket can throw before
        // the server has observed the close event. Swallow the
        // error and let the next tick terminate the client.
        log.warn({ err }, 'WebSocket ping() threw; will retry on next tick')
      }
    }
  }, intervalMs)

  // Ensure the interval does not keep the Node process alive on
  // shutdown. `Timeout.unref` is a no-op when called twice, so this
  // is safe regardless of how the timer was created.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref?: () => void }).unref?.()
  }

  const stop = (): void => {
    clearInterval(timer)
  }
  wss.on('close', stop)

  return {
    stop,
  }
}

/**
 * Bind the `pong` / `error` listeners required for the heartbeat
 * tracker on a single socket. Exposed separately so the main server
 * — which already owns its own `wss.on('connection')` handler for
 * message dispatch — can call this from inside that handler instead
 * of asking `installWebSocketHeartbeat` to install a second one.
 *
 * The same `aliveTracker` instance must be passed to
 * `installWebSocketHeartbeat({ attachOnConnection: false })` for the
 * tick loop to see the marks written here. The exported
 * `createHeartbeatTracker` helper bundles that wiring.
 */
export function attachConnectionHooks(
  ws: WebSocket,
  aliveTracker: WeakMap<WebSocket, boolean>,
  log: Pick<Logger, 'warn' | 'info' | 'debug'>,
): void {
  aliveTracker.set(ws, true)
  ws.on('pong', () => {
    aliveTracker.set(ws, true)
  })
  // The `error` event is non-fatal at the `ws` layer — without a
  // listener Node escalates it to an `uncaughtException`. Record it
  // through the structured logger so the redaction pipeline applies
  // and the supervisor's log volume stays bounded (the heartbeat
  // tick will follow up with a `terminate()` if the socket never
  // recovers).
  ws.on('error', (err: Error) => {
    log.warn({ err }, 'WebSocket connection error')
  })
}

/**
 * Convenience bundle for callers that want to manage `attachConnectionHooks`
 * inside their own `wss.on('connection')` handler while still using the
 * heartbeat tick loop.
 *
 * Usage:
 *
 * ```ts
 * const heartbeat = createHeartbeatTracker(wss, { log: wsLogger })
 * wss.on('connection', (ws) => {
 *   heartbeat.attach(ws)
 *   // existing per-connection listeners (message dispatch, replay, ...)
 * })
 * ```
 */
export function createHeartbeatTracker(
  wss: WebSocketServer,
  options: HeartbeatOptions,
): {
  attach(ws: WebSocket): void
  handle: HeartbeatHandle
} {
  const aliveTracker = new WeakMap<WebSocket, boolean>()
  const log = options.log
  const handle = installWebSocketHeartbeat(wss, {
    ...options,
    attachOnConnection: false,
    aliveTracker,
  })
  return {
    attach: (ws: WebSocket) => attachConnectionHooks(ws, aliveTracker, log),
    handle,
  }
}

function silentLogger(): Pick<Logger, 'warn' | 'info' | 'debug'> {
  return {
    warn: () => {
      /* no-op */
    },
    info: () => {
      /* no-op */
    },
    debug: () => {
      /* no-op */
    },
  } as unknown as Pick<Logger, 'warn' | 'info' | 'debug'>
}
