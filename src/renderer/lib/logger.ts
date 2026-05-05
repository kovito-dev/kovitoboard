/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Renderer-side structured logger (DEC-017 v1.2 §10, design §13.4).
 *
 * Mirrors the pino call-site convention used by the server-side
 * logger so call sites read the same in both layers:
 *
 *   const log = createLogger('useIPC')
 *   log.info('WS connection established')
 *   log.warn({ err }, 'Failed to load initial data')
 *
 * Each emit does two things in sequence:
 *
 *   1. console.* (always on, human-readable form `[component] msg { data }`)
 *      — kept as a DevTools convenience and as a fallback when the
 *      WebSocket route is unavailable.
 *
 *   2. WebSocket transport
 *      — the same record is forwarded to the server as a `client_log`
 *      event so it lands in `.kovitoboard/logs/server.*.log` tagged
 *      with `client.<component>`. When the WS is not yet open (or has
 *      dropped), records queue up to `MAX_QUEUE` items and flush on
 *      the next `open`.
 *
 * Design points from the architect review (renderer-logging-followup-notes
 * 2026-04-25):
 *
 * - HMR-safe attach: re-attaching while a previous socket is still
 *   `OPEN` is a no-op (avoids losing the in-flight queue and double-
 *   listening on the same socket).
 * - Queue overflow: oldest-first drop, single console.warn so a
 *   render-loop misuse doesn't spam.
 * - Timestamps: not stamped here. The server adds `ts` on receipt to
 *   keep all log records on a single trusted clock (DEC-017 §3.1).
 */
import type { ClientLogPayload } from '../../shared/ws-events'

type LogLevel = ClientLogPayload['level']

export interface RendererLogger {
  debug(msgOrData: string | object, msg?: string): void
  info(msgOrData: string | object, msg?: string): void
  warn(msgOrData: string | object, msg?: string): void
  error(msgOrData: string | object, msg?: string): void
}

const MAX_QUEUE = 500

const queue: ClientLogPayload[] = []
let ws: WebSocket | null = null
let queueOverflowWarned = false

/**
 * Bind a WebSocket to the logger. Subsequent log calls send through
 * this socket once it is `OPEN`; entries arriving before then are
 * queued and flushed on the `open` event.
 *
 * Idempotent under HMR / reconnect:
 * - If the previous socket is still `OPEN`, we keep it and ignore the
 *   call. This prevents Vite HMR re-mounts from clobbering a working
 *   connection and double-attaching listeners.
 * - If the previous socket is closed (or absent), we replace it.
 */
export function attachLogWebSocket(socket: WebSocket): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Existing connection is healthy — keep it. (HMR safety.)
    return
  }
  ws = socket

  socket.addEventListener('open', () => {
    flushQueue(socket)
  })
  socket.addEventListener('close', () => {
    if (ws === socket) ws = null
  })

  // The socket may already be OPEN at attach time (rare, but possible
  // if the caller awaited the open). Try a flush immediately.
  if (socket.readyState === WebSocket.OPEN) {
    flushQueue(socket)
  }
}

function flushQueue(socket: WebSocket): void {
  while (queue.length > 0) {
    const payload = queue[0]
    try {
      socket.send(JSON.stringify({ type: 'client_log', payload }))
      queue.shift()
    } catch {
      // Send failed — keep the entry at the head and stop flushing.
      // The next `open` (or a subsequent emit) will retry.
      break
    }
  }
}

function enqueue(payload: ClientLogPayload): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift() // drop oldest
    if (!queueOverflowWarned) {
      // eslint-disable-next-line no-console
      console.warn(
        '[logger] WS queue overflow — dropping oldest log entries (warned once)',
      )
      queueOverflowWarned = true
    }
  }
  queue.push(payload)
}

function consoleEmit(level: LogLevel, component: string, msg: string, data?: object): void {
  const tag = `[${component}] ${msg}`
  // Prefer console.error for fatal-equivalents, console.warn for warn,
  // console.info for info, console.log for debug (browser convention).
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'info'
          ? console.info
          : console.log
  if (data !== undefined) {
    fn(tag, data)
  } else {
    fn(tag)
  }
}

function emit(
  level: LogLevel,
  component: string,
  arg1: string | object,
  arg2?: string,
): void {
  // pino-style call shape: (msg) | (data, msg)
  let msg: string
  let data: Record<string, unknown> | undefined
  if (typeof arg1 === 'string') {
    msg = arg1
    data = undefined
  } else {
    data = arg1 as Record<string, unknown>
    msg = arg2 ?? ''
  }

  // (1) Console fallback / DevTools surface — always.
  consoleEmit(level, component, msg, data)

  // (2) WebSocket transport — immediate send if open, queue otherwise.
  const payload: ClientLogPayload = data
    ? { level, component, msg, data }
    : { level, component, msg }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'client_log', payload }))
      return
    } catch {
      // Fall through to enqueue on send failure.
    }
  }
  enqueue(payload)
}

/**
 * Build a logger bound to a specific component name. The component
 * surfaces as `client.<component>` on the server side so log records
 * can be filtered with a single `jq 'select(.component | startswith("client."))'`.
 */
export function createLogger(component: string): RendererLogger {
  return {
    debug: (a, b) => emit('debug', component, a, b),
    info: (a, b) => emit('info', component, a, b),
    warn: (a, b) => emit('warn', component, a, b),
    error: (a, b) => emit('error', component, a, b),
  }
}

/**
 * Test-only: reset internal state so subsequent tests start from a
 * clean slate. Not intended for production code.
 */
export function _resetLoggerForTests(): void {
  queue.length = 0
  ws = null
  queueOverflowWarned = false
}

/** Test-only inspector: returns the current pending queue length. */
export function _queueLengthForTests(): number {
  return queue.length
}
