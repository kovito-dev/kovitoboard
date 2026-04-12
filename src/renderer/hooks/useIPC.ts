import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { SessionSummary, Session, ParsedEvent, ViewerConfig, AgentInfo, SendMessageResponse, NewSessionResponse, TmuxStatus } from '../types'

const API_BASE = '/api'

/** オプティミスティックUIで追加した仮メッセージのIDプレフィックス */
const OPTIMISTIC_ID_PREFIX = 'optimistic_'

/**
 * メッセージテキストを正規化して比較用にする
 * サーバー側のサニタイズ（改行→\nリテラル、制御文字除去等）と一致させるため
 * オプティミスティックUI（改行あり）とサーバーイベント（\nリテラル）を同一視する
 */
function normalizeForComparison(text: string): string {
  return text
    // 実際の改行を \n リテラルに統一
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n')
    // 実際のタブを \t リテラルに統一
    .replace(/\t/g, '\\t')
    // 有害な制御文字を除去
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
}

/** tmuxステータスのポーリング間隔（ms） */
const TMUX_POLL_INTERVAL = 60_000

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export function useIPC() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [config, setConfig] = useState<ViewerConfig | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [sessionAgentMap, setSessionAgentMap] = useState<Record<string, string>>({})
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const selectedIdRef = useRef<string | null>(null)

  // selectedId を ref でも追跡（WebSocket コールバック内で最新値を参照するため）
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // 初期データ読み込み
  useEffect(() => {
    Promise.all([
      fetchJson<SessionSummary[]>(`${API_BASE}/sessions`),
      fetchJson<ViewerConfig>(`${API_BASE}/config`),
      fetchJson<AgentInfo[]>(`${API_BASE}/agents`),
      fetchJson<Record<string, string>>(`${API_BASE}/session-agent-map`),
      fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`).catch(() => null),
    ]).then(([sessionList, cfg, agentList, saMap, tmux]) => {
      setSessions(sessionList)
      setConfig(cfg)
      setAgents(agentList)
      setSessionAgentMap(saMap)
      if (tmux) setTmuxStatus(tmux)
      setIsLoading(false)
      if (sessionList.length > 0) {
        setSelectedId(sessionList[0].id)
      }
    }).catch((err) => {
      console.error('初期データ読み込みエラー:', err)
      setIsLoading(false)
    })
  }, [])

  // セッション選択時にフルデータ取得
  useEffect(() => {
    if (!selectedId) return
    fetchJson<Session>(`${API_BASE}/sessions/${selectedId}`).then(setCurrentSession)
  }, [selectedId])

  // tmuxステータスの定期ポーリング（60秒ごと）
  useEffect(() => {
    const timer = setInterval(() => {
      fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`)
        .then(setTmuxStatus)
        .catch(() => setTmuxStatus(null))
    }, TMUX_POLL_INTERVAL)

    return () => clearInterval(timer)
  }, [])

  // --- セッション送信可否の判定 ---
  // エージェントごとの最新セッションIDを算出
  const latestSessionByAgent = useMemo(() => {
    const map: Record<string, string> = {}
    // sessions は lastEventAt の降順（新しい順）でサーバーから返る
    // 最初に見つかったものが最新
    for (const s of sessions) {
      const agentId = sessionAgentMap[s.id] || '_default'
      if (!map[agentId]) {
        map[agentId] = s.id
      }
    }
    return map
  }, [sessions, sessionAgentMap])

  /**
   * セッションがメッセージ送信可能かどうかを判定
   *
   * 送信可能な条件（いずれか）:
   * 1. tmuxにエージェントのウィンドウがあり、そのエージェントの最新セッションである
   * 2. セッションが idle でない（= 現在アクティブ。tmux外で起動されたCLIセッション含む）
   */
  const isSessionSendable = useCallback((sessionId: string): boolean => {
    const agentId = sessionAgentMap[sessionId] || '_default'
    const session = sessions.find((s) => s.id === sessionId)

    // 条件1: tmuxにエージェントウィンドウがあり、そのエージェントの最新セッション
    if (tmuxStatus?.hasSession) {
      const lookupAgentId = agentId === '_default' ? 'default' : agentId
      const windowName = tmuxStatus.agentWindowMap?.[lookupAgentId]
      if (windowName && tmuxStatus.windows.some((w) => w.name === windowName)) {
        if (latestSessionByAgent[agentId] === sessionId) return true
      }
    }

    // 条件2: セッションが idle でない（アクティブに動作中）
    if (session && session.status !== 'idle') return true

    return false
  }, [tmuxStatus, sessionAgentMap, sessions, latestSessionByAgent])

  // --- オプティミスティックUI: 仮メッセージをタイムラインに即追加 ---
  const addOptimisticMessage = useCallback((sessionId: string, message: string) => {
    const now = new Date().toISOString()
    const optimisticEvent: ParsedEvent = {
      id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}`,
      sessionId,
      type: 'user',
      timestamp: now,
      content: { text: message },
      metadata: {},
    }

    // 現在表示中のセッションなら即座にイベント追加 + ステータスを waiting に
    if (sessionId === selectedIdRef.current) {
      setCurrentSession((prev) => {
        if (!prev) return prev
        return { ...prev, status: 'waiting', events: [...prev.events, optimisticEvent] }
      })
    }

    // セッション一覧の lastMessage・ステータスも更新
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: 'waiting', lastEventAt: now, lastMessage: message.slice(0, 80) }
          : s
      )
    )
  }, [])

  // --- オプティミスティックUI: 送信失敗時に仮メッセージを除去 ---
  const rollbackOptimisticMessage = useCallback((sessionId: string) => {
    // currentSession からオプティミスティックメッセージを除去し、ステータスを復元
    if (sessionId === selectedIdRef.current) {
      setCurrentSession((prev) => {
        if (!prev) return prev
        const filteredEvents = prev.events.filter((e) => !e.id.startsWith(OPTIMISTIC_ID_PREFIX))
        // 元のステータスを推定: イベントがあれば idle、なければ idle
        return { ...prev, status: 'idle', events: filteredEvents }
      })
    }

    // セッション一覧のステータスも復元
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, status: 'idle' } : s
      )
    )
  }, [])

  // WebSocket でリアルタイムイベント受信（自動再接続付き）
  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    function handleMessage(e: MessageEvent) {
      try {
        const msg = JSON.parse(e.data)
        const { type, payload } = msg

        if (type === 'new_event') {
          const { sessionId, event } = payload as { sessionId: string; event: ParsedEvent }
          if (sessionId === selectedIdRef.current) {
            setCurrentSession((prev) => {
              if (!prev) return prev

              // 重複排除: サーバーからの user イベントが到着したら、
              // 同じテキストの仮メッセージ（optimistic）を置換する
              // サーバー側でサニタイズされるため、正規化して比較する
              if (event.type === 'user' && event.content.text) {
                const normalizedIncoming = normalizeForComparison(event.content.text)
                const optimisticIndex = prev.events.findIndex(
                  (e) => e.id.startsWith(OPTIMISTIC_ID_PREFIX) && e.content.text && normalizeForComparison(e.content.text) === normalizedIncoming
                )
                if (optimisticIndex !== -1) {
                  // 仮メッセージを実メッセージで置換
                  const newEvents = [...prev.events]
                  newEvents[optimisticIndex] = event
                  return { ...prev, events: newEvents }
                }
              }

              return { ...prev, events: [...prev.events, event] }
            })
          }
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? { ...s, lastEventAt: event.timestamp, lastMessage: event.content.text?.slice(0, 80) || s.lastMessage }
                : s
            )
          )
        } else if (type === 'status_change') {
          const { sessionId, status } = payload as { sessionId: string; status: string }
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, status } : s)))
          if (sessionId === selectedIdRef.current) {
            setCurrentSession((prev) => (prev ? { ...prev, status: status as Session['status'] } : prev))
          }
        } else if (type === 'new_session') {
          const { summary } = payload as { summary: SessionSummary }
          setSessions((prev) => [summary, ...prev])
          // agentId があれば sessionAgentMap も即座に更新（遅延なし）
          if (summary.agentId) {
            setSessionAgentMap((prev) => ({ ...prev, [summary.id]: summary.agentId! }))
          }
        } else if (type === 'process_end') {
          // Claude CLI プロセス完了通知
        }
      } catch {
        // ignore parse errors
      }
    }

    function connect() {
      if (disposed) return

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${wsProtocol}//${location.host}/ws`
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('[WS] 接続確立')
        // 再接続時はデータを最新に同期
        fetchJson<SessionSummary[]>(`${API_BASE}/sessions`).then(setSessions).catch(() => {})
        fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`).then(setTmuxStatus).catch(() => {})
        if (selectedIdRef.current) {
          fetchJson<Session>(`${API_BASE}/sessions/${selectedIdRef.current}`).then(setCurrentSession).catch(() => {})
        }
      }

      ws.onmessage = handleMessage

      ws.onclose = () => {
        console.log('[WS] 接続切断')
        if (!disposed) {
          // 2秒後に再接続
          reconnectTimer = setTimeout(connect, 2000)
        }
      }

      ws.onerror = () => {
        // onclose が続けて発火するので、ここでは何もしない
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  const selectSession = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const refreshSessions = useCallback(() => {
    fetchJson<SessionSummary[]>(`${API_BASE}/sessions`).then(setSessions)
  }, [])

  // 現在選択中のセッションを強制再取得
  const reloadCurrentSession = useCallback(() => {
    if (!selectedIdRef.current) return
    fetchJson<Session>(`${API_BASE}/sessions/${selectedIdRef.current}`).then(setCurrentSession)
  }, [])

  const refreshAgents = useCallback(() => {
    Promise.all([
      fetchJson<AgentInfo[]>(`${API_BASE}/agents`),
      fetchJson<Record<string, string>>(`${API_BASE}/session-agent-map`)
    ]).then(([agentList, saMap]) => {
      setAgents(agentList)
      setSessionAgentMap(saMap)
    })
  }, [])

  // 既存セッションにメッセージを送信
  const sendMessage = useCallback(async (sessionId: string, message: string): Promise<SendMessageResponse> => {
    // オプティミスティックUI: 即座に仮メッセージを表示
    addOptimisticMessage(sessionId, message)

    const res = await fetch(`${API_BASE}/sessions/${sessionId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `API error: ${res.status}`)
    }
    return res.json()
  }, [addOptimisticMessage])

  // 新規セッションを開始
  const startNewSession = useCallback(async (message: string, agentId?: string): Promise<NewSessionResponse> => {
    const res = await fetch(`${API_BASE}/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `API error: ${res.status}`)
    }
    return res.json()
  }, [])

  // tmux 経由でメッセージ送信（オプティミスティックUI付き）
  const tmuxSend = useCallback(async (windowName: string, message: string, sessionId?: string): Promise<void> => {
    // オプティミスティックUI: sessionId が分かれば仮メッセージを表示
    if (sessionId) {
      addOptimisticMessage(sessionId, message)
    }

    const res = await fetch(`${API_BASE}/tmux/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowName, message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `API error: ${res.status}`)
    }
  }, [addOptimisticMessage])

  // tmux 経由で既存セッションをクリアして新規メッセージ送信
  const tmuxClearAndSend = useCallback(async (windowName: string, message: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/tmux/clear-and-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowName, message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `API error: ${res.status}`)
    }
  }, [])

  // セッションに agentId を手動設定（/clear で作成されたセッション用）
  const setSessionAgent = useCallback(async (sessionId: string, agentId: string) => {
    // ローカル状態を即更新
    setSessionAgentMap((prev) => ({ ...prev, [sessionId]: agentId }))
    // サーバーにも反映
    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/set-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      })
    } catch {
      // サーバー更新失敗してもローカルは維持
    }
  }, [])

  // tmux ステータスを更新
  const refreshTmuxStatus = useCallback(async () => {
    try {
      const status = await fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`)
      setTmuxStatus(status)
    } catch {
      setTmuxStatus(null)
    }
  }, [])

  return {
    sessions, currentSession, selectedId, config, agents, sessionAgentMap, tmuxStatus, isLoading,
    selectSession, refreshSessions, reloadCurrentSession, refreshAgents, refreshTmuxStatus,
    sendMessage, startNewSession, tmuxSend, tmuxClearAndSend, setSessionAgent,
    isSessionSendable, rollbackOptimisticMessage,
  }
}
