/**
 * KB Bridge — window.kb.call() の実装.
 *
 * WebSocket 経由で BE の handler dispatcher にリクエストを送信し、
 * requestId をキーに Promise を解決する JSON-RPC 風実装。
 *
 * @see recipe-backend-critical-reviews.md §3 (Q-J1: WebSocket 採用)
 * @see recipe-backend-critical-reviews.md §4 (Q-K1: グローバル注入)
 * @stable v0.1.0
 */

// =========================================
// Types (window.kb 型定義と同一構造を再定義)
// =========================================

/** handler のレスポンス型（window.kb 型定義と同一） */
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

/** requestId → pending Promise のマップ */
const pendingCalls = new Map<string, PendingCall>()

/** 現在の WebSocket 接続（既存のものを再利用） */
let ws: WebSocket | null = null

/** WebSocket メッセージハンドラを登録済みか */
let listenerAttached = false

/**
 * WebSocket 接続を取得する.
 * 既存の接続があればそれを返す。なければ新規接続する。
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
 * WebSocket のメッセージリスナーを設定する.
 * kb-call-response メッセージを受信して pending Promise を解決する。
 */
function ensureListener(): void {
  if (listenerAttached) return

  // 既存の WS 接続で message イベントを listen
  // アプリ全体で共有するため、ページ遷移をまたいでも有効
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

  // 既存の WebSocket が開いたら listener を付ける
  const attachToWs = (socket: WebSocket) => {
    socket.addEventListener('message', handler)
    socket.addEventListener('close', () => {
      // WS 切断時に pending を全て reject
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

  // 初回は getWebSocket で接続
  const socket = getWebSocket()
  if (socket.readyState === WebSocket.OPEN) {
    attachToWs(socket)
  } else {
    socket.addEventListener('open', () => attachToWs(socket))
  }

  listenerAttached = true
}

/**
 * UUID v4 を生成する（crypto.randomUUID を使用）.
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
 * KB Bridge API の call 実装.
 *
 * @param recipeId - レシピ ID
 * @param callId - 呼び出し ID（api.calls[].id）
 * @param input - 入力値
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

    // タイムアウト
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

    // WebSocket 送信
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
 * window.kb オブジェクトを作成する.
 * recipeId をクロージャに保持し、call 時に自動付与する。
 */
export function createKbBridge(recipeId: string): NonNullable<Window['kb']> {
  return {
    call: <T = unknown>(callId: string, input?: Record<string, unknown>) =>
      kbCall<T>(recipeId, callId, input),
  }
}
