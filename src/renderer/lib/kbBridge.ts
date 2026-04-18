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

/** Whether the WebSocket message handler has been attached */
let listenerAttached = false

/**
 * Get the WebSocket connection.
 * Returns the existing connection if available; otherwise creates a new one.
 */
function getWebSocket(): WebSocket {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${location.host}/ws`
  ws = new WebSocket(url)

  ws.addEventListener('close', () => {
    ws = null
  })

  return ws
}

/**
 * Set up the WebSocket message listener.
 * Receives kb-call-response messages and resolves the corresponding pending Promise.
 */
function ensureListener(): void {
  if (listenerAttached) return

  // Listen for message events on the existing WS connection
  // Shared across the entire app, so it remains active across page transitions
  const handler = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>
      if (msg.type !== 'kb-call-response') return

      const requestId = msg.requestId as string
      const pending = pendingCalls.get(requestId)
      if (!pending) return

      clearTimeout(pending.timer)
      pendingCalls.delete(requestId)
      pending.resolve(msg.result as KbCallResult)
    } catch {
      // JSON parse failure — ignore non-kb messages
    }
  }

  // Attach the listener once the existing WebSocket opens
  const attachToWs = (socket: WebSocket) => {
    socket.addEventListener('message', handler)
    socket.addEventListener('close', () => {
      // Reject all pending calls on WS disconnection
      for (const [id, pending] of pendingCalls) {
        clearTimeout(pending.timer)
        pending.resolve({
          ok: false,
          error: { code: 'Internal', message: 'WebSocket connection closed' },
        })
        pendingCalls.delete(id)
      }
    })
  }

  // On first call, establish connection via getWebSocket
  const socket = getWebSocket()
  if (socket.readyState === WebSocket.OPEN) {
    attachToWs(socket)
  } else {
    socket.addEventListener('open', () => attachToWs(socket))
  }

  listenerAttached = true
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
 * @param recipeId - Recipe ID
 * @param callId - Call ID (api.calls[].id)
 * @param input - Input value
 * @returns HandlerResponse
 */
export function kbCall<T = unknown>(
  recipeId: string,
  callId: string,
  input?: Record<string, unknown>,
): Promise<KbCallResult<T>> {
  ensureListener()

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
      recipeId,
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
 * Create the window.kb object.
 * Captures recipeId in a closure and automatically attaches it on each call.
 */
export function createKbBridge(recipeId: string): NonNullable<Window['kb']> {
  return {
    call: <T = unknown>(callId: string, input?: Record<string, unknown>) =>
      kbCall<T>(recipeId, callId, input),
  }
}
