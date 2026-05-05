/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KB Bridge — Implementation of window.kb.call().
 *
 * Sends requests to the backend handler dispatcher via WebSocket
 * and resolves Promises keyed by requestId (JSON-RPC-like pattern).
 *
 * @see recipe-backend-critical-reviews.md §3 (Q-J1: WebSocket adoption)
 * @see recipe-backend-critical-reviews.md §4 (Q-K1: Global injection)
 * @stable v0.1.0
 */

import { createLogger } from './logger'

const log = createLogger('kbBridge')

// =========================================
// Types (mirrored from window.kb type definitions)
// =========================================

/** Handler response type (same as window.kb type definition) */
type KbCallResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

interface PendingCall {
  resolve: (result: KbCallResult) => void
  timer: ReturnType<typeof setTimeout>
}

// =========================================
// Bridge
// =========================================

const TIMEOUT_MS = 30_000

/** Map of requestId -> pending Promise */
const pendingCalls = new Map<string, PendingCall>()

/** Current WebSocket connection (reuse existing one) */
let ws: WebSocket | null = null

/**
 * Resolve the kb-call response back to the pending Promise. Attached
 * to every socket created by `getWebSocket` so a reconnected socket
 * also delivers responses (a single global "listener attached" flag
 * stays true across reconnects and silently drops responses on the
 * fresh socket).
 */
function handleResponse(event: MessageEvent): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(event.data as string) as Record<string, unknown>
  } catch {
    // JSON parse failure — most likely a non-kb message frame (e.g.
    // binary). We can't distinguish "silent drop legitimate" from
    // "malformed kb response" without a successful parse, so drop
    // silently.
    return
  }
  if (msg.type !== 'kb-call-response') return

  // From here on, the message claims to be a kb-call-response —
  // surface protocol violations as warnings so they don't go
  // unnoticed.
  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    log.warn({ msg }, 'Malformed kb-call-response (missing or invalid requestId)')
    return
  }

  const requestId = msg.requestId
  const pending = pendingCalls.get(requestId)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingCalls.delete(requestId)
  pending.resolve(msg.result as KbCallResult)
}

/**
 * Get (or create) the kb-call WebSocket connection.
 *
 * The connection is reused while it is OPEN *or* CONNECTING. Treating
 * CONNECTING as "create a new one" was a race-condition trap: kbCall
 * called getWebSocket twice (once via the old ensureListener helper,
 * once for send), so the second invocation would create a separate
 * socket while the first was still mid-handshake. The kb-call frame
 * landed on the second socket, the response came back on the second
 * socket, but the message listener was attached to the first — every
 * call timed out after 30 s.
 *
 * The message and close listeners are attached at creation time
 * (rather than via a one-shot ensureListener flag) so a reconnect
 * produces a fully wired-up socket too.
 */
function getWebSocket(): WebSocket {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return ws
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Use the same `/api/ws` endpoint as useIPC. The bare `/ws` path is
  // commandeered by Vite's HMR WebSocket during dev, which silently
  // swallows kb-call frames and produces a 30s client-side timeout.
  // The server-side migration to `/api/ws` was done in 35b6677 along
  // with useIPC, but this bridge was missed at the time.
  const url = `${protocol}//${location.host}/api/ws`
  const fresh = new WebSocket(url)
  ws = fresh

  fresh.addEventListener('message', handleResponse)
  fresh.addEventListener('close', () => {
    if (ws === fresh) {
      ws = null
    }
    // Reject all pending calls on WS disconnection so callers don't
    // hang for the full 30 s timeout.
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer)
      pending.resolve({
        ok: false,
        error: { code: 'Internal', message: 'WebSocket connection closed' },
      })
      pendingCalls.delete(id)
    }
  })

  return fresh
}

/**
 * Generate a UUID v4 (using crypto.randomUUID).
 */
function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * KB Bridge API call implementation.
 *
 * @param appId - KB-local app identifier (dispatcher routing key)
 * @param callId - Call ID (api.calls[].id)
 * @param input - Input value
 * @returns HandlerResponse
 */
export function kbCall<T = unknown>(
  appId: string,
  callId: string,
  input?: Record<string, unknown>,
): Promise<KbCallResult<T>> {
  return new Promise<KbCallResult<T>>((resolve) => {
    const requestId = generateRequestId()

    // Timeout
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId)
      resolve({
        ok: false,
        error: { code: 'Internal', message: `Handler call timed out after ${TIMEOUT_MS}ms` },
      } as KbCallResult<T>)
    }, TIMEOUT_MS)

    pendingCalls.set(requestId, {
      resolve: resolve as (result: KbCallResult) => void,
      timer,
    })

    // Send via WebSocket
    const socket = getWebSocket()
    const msg = JSON.stringify({
      type: 'kb-call',
      requestId,
      appId,
      callId,
      input: input || {},
    })

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg)
    } else {
      socket.addEventListener('open', () => socket.send(msg), { once: true })
    }
  })
}

/**
 * Create the call-bridge half of `window.kb`.
 *
 * Returns only the `call` field — the matching `log` field is added by
 * the caller (`injectKb`) which knows the recipe id and constructs the
 * recipe-scoped logger separately. Splitting the two responsibilities
 * keeps `kbBridge.ts` independent of the renderer logger module.
 */
export type KbCallBridge = Pick<NonNullable<Window['kb']>, 'call'>

export function createKbBridge(appId: string): KbCallBridge {
  return {
    call: <T = unknown>(callId: string, input?: Record<string, unknown>) =>
      kbCall<T>(appId, callId, input),
  }
}
