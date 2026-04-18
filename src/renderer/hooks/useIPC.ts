import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { SessionSummary, Session, ParsedEvent, ViewerConfig, AgentInfo, SendMessageResponse, NewSessionResponse, TmuxStatus } from '../types'
import type {
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
  TrustPromptResolvedPayload,
  ClientToServerEvent,
} from '../../shared/ws-events'

const API_BASE = '/api'

/** ID prefix for optimistic UI temporary messages */
const OPTIMISTIC_ID_PREFIX = 'optimistic_'

/**
 * Trust prompt queue item (Phase 5d)
 *
 * Both detected and fallback items coexist in the same queue;
 * the modal differentiates by kind.
 * Phase 5c only had detected; fallback was added in 5d.
 */
export type TrustPromptItem =
  | { kind: 'detected'; payload: TrustPromptDetectedPayload }
  | { kind: 'fallback'; payload: TrustPromptFallbackPayload }

/**
 * Normalize message text for comparison.
 * Matches server-side sanitization (newlines to \n literals, control char removal, etc.)
 * so that optimistic UI messages (with real newlines) and server events (\n literals) are treated as equal.
 */
function normalizeForComparison(text: string): string {
  return text
    // Normalize real newlines to \n literals
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n')
    // Normalize real tabs to \t literals
    .replace(/\t/g, '\\t')
    // Remove harmful control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
}

/** Polling interval for tmux status (ms) */
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

  // --- Trust prompt relay (Phase 5c / 5d) ---
  // When prompts occur in multiple windows simultaneously, they are queued (FIFO) and shown one at a time.
  // The first item (index 0) is the one currently displayed in the modal.
  // Phase 5d added fallback (raw-keys input) support. Items are stored as a
  // discriminated union in the same queue; the modal branches by kind.
  const [trustPromptQueue, setTrustPromptQueue] = useState<TrustPromptItem[]>([])
  // WebSocket ref (used to send trust-prompt responses)
  const wsRef = useRef<WebSocket | null>(null)

  // Track selectedId via ref so WebSocket callbacks can access the latest value
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // Load initial data
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
      console.error('Failed to load initial data:', err)
      setIsLoading(false)
    })
  }, [])

  // Fetch full session data when a session is selected
  useEffect(() => {
    if (!selectedId) return
    fetchJson<Session>(`${API_BASE}/sessions/${selectedId}`).then(setCurrentSession)
  }, [selectedId])

  // Poll tmux status periodically (every 60 seconds)
  useEffect(() => {
    const timer = setInterval(() => {
      fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`)
        .then(setTmuxStatus)
        .catch(() => setTmuxStatus(null))
    }, TMUX_POLL_INTERVAL)

    return () => clearInterval(timer)
  }, [])

  // --- Determine whether a session can accept messages ---
  // Compute the latest session ID per agent
  const latestSessionByAgent = useMemo(() => {
    const map: Record<string, string> = {}
    // sessions are returned from the server in descending order of lastEventAt (newest first)
    // The first match for each agent is the latest session
    for (const s of sessions) {
      const agentId = sessionAgentMap[s.id] || '_default'
      if (!map[agentId]) {
        map[agentId] = s.id
      }
    }
    return map
  }, [sessions, sessionAgentMap])

  /**
   * Determine whether a session can accept messages.
   *
   * A session is sendable if either condition is met:
   * 1. The agent has a tmux window and this is the agent's latest session
   * 2. The session is not idle (i.e. currently active, including CLI sessions started outside tmux)
   */
  const isSessionSendable = useCallback((sessionId: string): boolean => {
    const agentId = sessionAgentMap[sessionId] || '_default'
    const session = sessions.find((s) => s.id === sessionId)

    // Condition 1: Agent has a tmux window and this is the agent's latest session
    if (tmuxStatus?.hasSession) {
      const lookupAgentId = agentId === '_default' ? 'default' : agentId
      const windowName = tmuxStatus.agentWindowMap?.[lookupAgentId]
      if (windowName && tmuxStatus.windows.some((w) => w.name === windowName)) {
        if (latestSessionByAgent[agentId] === sessionId) return true
      }
    }

    // Condition 2: Session is not idle (actively running)
    if (session && session.status !== 'idle') return true

    return false
  }, [tmuxStatus, sessionAgentMap, sessions, latestSessionByAgent])

  // --- Optimistic UI: immediately add a temporary message to the timeline ---
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

    // If this is the currently displayed session, append the event immediately and set status to waiting
    if (sessionId === selectedIdRef.current) {
      setCurrentSession((prev) => {
        if (!prev) return prev
        return { ...prev, status: 'waiting', events: [...prev.events, optimisticEvent] }
      })
    }

    // Also update lastMessage and status in the session list
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: 'waiting', lastEventAt: now, lastMessage: message.slice(0, 80) }
          : s
      )
    )
  }, [])

  // --- Optimistic UI: remove temporary message on send failure ---
  const rollbackOptimisticMessage = useCallback((sessionId: string) => {
    // Remove optimistic messages from currentSession and restore status
    if (sessionId === selectedIdRef.current) {
      setCurrentSession((prev) => {
        if (!prev) return prev
        const filteredEvents = prev.events.filter((e) => !e.id.startsWith(OPTIMISTIC_ID_PREFIX))
        // Restore status to idle
        return { ...prev, status: 'idle', events: filteredEvents }
      })
    }

    // Also restore status in the session list
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, status: 'idle' } : s
      )
    )
  }, [])

  // Receive real-time events via WebSocket (with automatic reconnection)
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

              // Deduplication: when a user event arrives from the server,
              // replace any optimistic message with matching text.
              // Normalize before comparison to account for server-side sanitization.
              if (event.type === 'user' && event.content.text) {
                const normalizedIncoming = normalizeForComparison(event.content.text)
                const optimisticIndex = prev.events.findIndex(
                  (e) => e.id.startsWith(OPTIMISTIC_ID_PREFIX) && e.content.text && normalizeForComparison(e.content.text) === normalizedIncoming
                )
                if (optimisticIndex !== -1) {
                  // Replace the optimistic message with the real one
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
          // If agentId is present, update sessionAgentMap immediately (no delay)
          if (summary.agentId) {
            setSessionAgentMap((prev) => ({ ...prev, [summary.id]: summary.agentId! }))
          }
        } else if (type === 'process_end') {
          // Claude CLI process completion notification
        } else if (type === 'trust_prompt_detected') {
          // Trust prompt detected: add to queue as 'detected' (deduplicate by promptId)
          const detectedPayload = payload as TrustPromptDetectedPayload
          setTrustPromptQueue((prev) => {
            if (prev.some((p) => p.payload.promptId === detectedPayload.promptId)) {
              return prev
            }
            return [...prev, { kind: 'detected', payload: detectedPayload }]
          })
        } else if (type === 'trust_prompt_fallback') {
          // Phase 5d: add unknown prompt to queue as 'fallback'
          const fallbackPayload = payload as TrustPromptFallbackPayload
          setTrustPromptQueue((prev) => {
            if (prev.some((p) => p.payload.promptId === fallbackPayload.promptId)) {
              return prev
            }
            return [...prev, { kind: 'fallback', payload: fallbackPayload }]
          })
        } else if (type === 'trust_prompt_resolved') {
          // Prompt resolved on the server side -> remove the corresponding promptId from the queue
          const resolvedPayload = payload as TrustPromptResolvedPayload
          setTrustPromptQueue((prev) => prev.filter((p) => p.payload.promptId !== resolvedPayload.promptId))
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
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[WS] Connection established')
        // Sync data to latest on reconnection
        fetchJson<SessionSummary[]>(`${API_BASE}/sessions`).then(setSessions).catch(() => {})
        fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`).then(setTmuxStatus).catch(() => {})
        if (selectedIdRef.current) {
          fetchJson<Session>(`${API_BASE}/sessions/${selectedIdRef.current}`).then(setCurrentSession).catch(() => {})
        }
      }

      ws.onmessage = handleMessage

      ws.onclose = () => {
        console.log('[WS] Connection closed')
        if (!disposed) {
          // Reconnect after 2 seconds
          reconnectTimer = setTimeout(connect, 2000)
        }
      }

      ws.onerror = () => {
        // No-op here; onclose will fire immediately after
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      wsRef.current = null
    }
  }, [])

  const selectSession = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const refreshSessions = useCallback(() => {
    fetchJson<SessionSummary[]>(`${API_BASE}/sessions`).then(setSessions)
  }, [])

  // Force-reload the currently selected session
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

  // Send a message to an existing session
  const sendMessage = useCallback(async (sessionId: string, message: string): Promise<SendMessageResponse> => {
    // Optimistic UI: display temporary message immediately
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

  // Start a new session
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

  // Send a message via tmux (with optimistic UI)
  const tmuxSend = useCallback(async (windowName: string, message: string, sessionId?: string): Promise<void> => {
    // Optimistic UI: display temporary message if sessionId is known
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

  // Clear existing session via tmux and send a new message
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

  // Manually assign an agentId to a session (for sessions created by /clear)
  const setSessionAgent = useCallback(async (sessionId: string, agentId: string) => {
    // Update local state immediately
    setSessionAgentMap((prev) => ({ ...prev, [sessionId]: agentId }))
    // Also persist to the server
    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/set-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      })
    } catch {
      // Keep local state even if server update fails
    }
  }, [])

  // --- Trust prompt response (Phase 5c / 5d) ---
  /**
   * Respond to the currently displayed prompt modal with a choice.
   * The server performs choiceId -> keys conversion on the detector side
   * (by design, the UI is not allowed to send arbitrary keys).
   * When `trust_prompt_resolved` is received from the server, the item
   * is automatically removed from the queue, so we do not modify the queue here.
   */
  const respondTrustPromptChoice = useCallback(
    (promptId: string, windowName: string, choiceId: string) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[trust-prompt] Skipping choice response: WebSocket not connected')
        return
      }
      const msg: ClientToServerEvent = {
        type: 'trust_prompt_respond',
        payload: {
          promptId,
          windowName,
          response: { mode: 'choice', choiceId },
        },
      }
      ws.send(JSON.stringify(msg))
    },
    [],
  )

  /**
   * Respond from the fallback modal with raw-keys (Phase 5d).
   * The server sends them via send-keys -l (literal mode) and also
   * enforces a 1024-character limit. The UI performs a pre-check as well;
   * if the limit is exceeded, a warning is logged and the send is skipped.
   */
  const respondTrustPromptRawKeys = useCallback(
    (promptId: string, windowName: string, rawKeys: string) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[trust-prompt] Skipping raw-keys response: WebSocket not connected')
        return
      }
      if (rawKeys.length > 1024) {
        console.warn(`[trust-prompt] raw-keys too long (${rawKeys.length} chars > 1024): send aborted`)
        return
      }
      const msg: ClientToServerEvent = {
        type: 'trust_prompt_respond',
        payload: {
          promptId,
          windowName,
          response: { mode: 'raw-keys', rawKeys },
        },
      }
      ws.send(JSON.stringify(msg))
    },
    [],
  )

  /**
   * When the user closes the modal via ESC or overlay click,
   * remove only the corresponding promptId from the queue. The server's
   * lastDetectedPromptId remains, so the prompt will either be resolved when
   * the capture changes, or re-notified on the next tick. Common to both detected and fallback.
   */
  const dismissTrustPrompt = useCallback((promptId: string) => {
    setTrustPromptQueue((prev) => prev.filter((p) => p.payload.promptId !== promptId))
  }, [])

  // Refresh tmux status
  const refreshTmuxStatus = useCallback(async () => {
    try {
      const status = await fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`)
      setTmuxStatus(status)
    } catch {
      setTmuxStatus(null)
    }
  }, [])

  // The first item in the queue is the one to display in the modal (Phase 5c / 5d)
  const currentTrustPrompt = trustPromptQueue[0] ?? null

  return {
    sessions, currentSession, selectedId, config, agents, sessionAgentMap, tmuxStatus, isLoading,
    selectSession, refreshSessions, reloadCurrentSession, refreshAgents, refreshTmuxStatus,
    sendMessage, startNewSession, tmuxSend, tmuxClearAndSend, setSessionAgent,
    isSessionSendable, rollbackOptimisticMessage,
    // Trust prompt relay (Phase 5c / 5d)
    currentTrustPrompt, respondTrustPromptChoice, respondTrustPromptRawKeys, dismissTrustPrompt,
  }
}
