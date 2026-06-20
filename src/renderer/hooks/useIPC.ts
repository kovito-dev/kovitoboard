/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { SessionSummary, Session, ParsedEvent, ViewerConfig, AgentInfo, SendMessageResponse, NewSessionResponse, TmuxStatus, SessionOrigin } from '../types'
import type {
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
  TrustPromptResolvedPayload,
  AgentActivityPayload,
  ClientToServerEvent,
} from '../../shared/ws-events'
import { attachLogWebSocket, createLogger } from '../lib/logger'
import { kbFetch, appendLaunchTokenQuery } from '../lib/kbFetch'

const log = createLogger('useIPC')
const trustPromptLog = createLogger('trust-prompt')

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
  const res = await kbFetch(url)
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
  const [wsConnected, setWsConnected] = useState(false)
  const selectedIdRef = useRef<string | null>(null)

  // --- Trust prompt relay (Phase 5c / 5d) ---
  // When prompts occur in multiple windows simultaneously, they are queued (FIFO) and shown one at a time.
  // The first item (index 0) is the one currently displayed in the modal.
  // Phase 5d added fallback (raw-keys input) support. Items are stored as a
  // discriminated union in the same queue; the modal branches by kind.
  const [trustPromptQueue, setTrustPromptQueue] = useState<TrustPromptItem[]>([])

  // Non-destructive dismiss set for degrade modals (BL-2026-263 Phase A,
  // trust-prompt-relay.md v1.8 §10.7.2, plan A). Closing a
  // `multi-question-unsupported` degrade modal must hide it in the UI
  // *without* removing the promptId from the queue — removing it would
  // leave Claude Code waiting in tmux (silent-stall). We instead record
  // the promptId here and skip dismissed items when picking the modal to
  // show. The queue item is finally dropped only on `trust_prompt_resolved`
  // (which also clears the matching dismissed entry). Existing detected /
  // fallback dismiss behavior (queue removal) is unchanged.
  const [dismissedTrustPromptIds, setDismissedTrustPromptIds] = useState<Set<string>>(
    () => new Set(),
  )

  // Per-session draft text for the message input.
  // Without this, switching sessions destroys the unsent text in
  // <MessageInput> because it lives in component-local state.
  // Drafts are intentionally not persisted across page reloads — keeping
  // them in memory is enough to fix the "I lost my half-typed reply by
  // peeking at another session" UX problem and avoids stale localStorage.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  // Latest activity line per session, populated from `agent_activity`
  // WebSocket events. The renderer surfaces this next to the typing
  // indicator so the user can see what the agent is doing right now
  // (e.g. `● Bash(npm install)` or `✻ Synthesizing... (12s)`).
  // Cleared on `status_change` once the session leaves thinking/waiting.
  const [agentActivities, setAgentActivities] = useState<Record<string, string>>({})
  // Monotonic counter bumped whenever the server reports `app_menu_changed`.
  // Consumers (e.g. App.tsx) use it as an effect dependency to refetch
  // `GET /api/app/menu-entries` when a recipe install writes `app/menu.ts`,
  // so the navigation updates without a manual page reload.
  const [appMenuVersion, setAppMenuVersion] = useState(0)
  // Monotonic counter bumped whenever the server reports
  // `recipe_apps_changed` (BL-2026-176 (b)). RecipeSample (and any other
  // sample-list consumer) uses it as a useEffect dependency to refetch
  // `GET /api/recipes/sample` so the new `enabled` / `source` fields
  // refresh without a manual page reload after a bundled enable /
  // disable transaction. Mirrors the `appMenuVersion` bump pattern.
  const [sampleRecipeVersion, setSampleRecipeVersion] = useState(0)
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
      log.error({ err }, 'Failed to load initial data')
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
        .catch((err) => {
          log.warn({ err, endpoint: 'tmux/status' }, 'Failed to poll tmux status')
          setTmuxStatus(null)
        })
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
          // Drop the cached activity line once the agent goes back to
          // a non-busy state. Otherwise the stale "Bash(...)" hint would
          // hang around even after the response arrives.
          if (status !== 'thinking' && status !== 'waiting') {
            setAgentActivities((prev) => {
              if (!(sessionId in prev)) return prev
              const next = { ...prev }
              delete next[sessionId]
              return next
            })
          }
        } else if (type === 'agent_activity') {
          const { sessionId, line } = payload as AgentActivityPayload
          setAgentActivities((prev) => {
            if (prev[sessionId] === line) return prev
            return { ...prev, [sessionId]: line }
          })
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
          // A fresh broadcast / reconnect replay for this promptId means the
          // prompt is still pending and should re-surface, even if its
          // degrade modal was closed earlier. Clearing the non-destructive
          // hide here honors the spec's "close re-surfaces on the next
          // broadcast / replay" contract (trust-prompt-relay.md v1.8
          // §10.7.2) without ever removing the item from the queue.
          setDismissedTrustPromptIds((prev) => {
            if (!prev.has(detectedPayload.promptId)) return prev
            const next = new Set(prev)
            next.delete(detectedPayload.promptId)
            return next
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
          // Clear any non-destructive dismiss record for the resolved prompt
          // so the set does not accumulate stale ids (Phase A, §10.7.2).
          setDismissedTrustPromptIds((prev) => {
            if (!prev.has(resolvedPayload.promptId)) return prev
            const next = new Set(prev)
            next.delete(resolvedPayload.promptId)
            return next
          })
        } else if (type === 'agent_restarted') {
          // Agent restarted via admin API — refresh agents and tmux status
          fetchJson<AgentInfo[]>(`${API_BASE}/agents`).then(setAgents).catch(() => {})
          fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`).then(setTmuxStatus).catch(() => {})
        } else if (type === 'agents_changed') {
          // On-disk agent set changed (create / update via agent write
          // API). Refetch both the agents list and the viewer config so
          // every consumer sees the new model / themeColor / avatar.
          //
          // The agents list backs AgentsPage / AgentDetail. The config
          // is the source of truth for ChatTimeline / SessionStatusBar
          // (they read agent metadata via `config.agents` props from
          // App.tsx), so updating only `agents` left the session view
          // showing the previous theme / model after an edit. This
          // dual refresh keeps both views in sync from a single event.
          fetchJson<AgentInfo[]>(`${API_BASE}/agents`).then(setAgents).catch(() => {})
          fetchJson<ViewerConfig>(`${API_BASE}/config`).then(setConfig).catch(() => {})
        } else if (type === 'app_menu_changed') {
          // `app/menu.ts` changed on disk (typically a recipe install).
          // Bumping the version triggers consumers to refetch the
          // menu entries so the new page appears immediately.
          setAppMenuVersion((v) => v + 1)
        } else if (type === 'recipe_apps_changed') {
          // A bundled sample recipe was enabled / disabled. Bump the
          // version so RecipeSample (and any other sample-list
          // consumer) refetches `/api/recipes/sample` and the new
          // `enabled` / `source` field state propagates without a
          // page reload (BL-2026-176 (b), spec ws-event-contract v1.4
          // §7.6.3 + recipe-system v1.10 §10.9).
          setSampleRecipeVersion((v) => v + 1)
        }
      } catch {
        // ignore parse errors
      }
    }

    function connect() {
      if (disposed) return

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = appendLaunchTokenQuery(`${wsProtocol}//${location.host}/api/ws`)
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // Attach logger transport so any queued client_log entries
        // emitted before the WS opened are flushed to the server.
        attachLogWebSocket(ws!)
        log.info('WS connection established')
        setWsConnected(true)
        // Sync data to latest on reconnection. Failures here used to
        // be silent; we now record them as warn so flaky reconnects
        // are visible in the merged log file.
        fetchJson<SessionSummary[]>(`${API_BASE}/sessions`).then(setSessions).catch((err) => {
          log.warn({ err, endpoint: 'sessions' }, 'Failed to sync on WS reconnect')
        })
        fetchJson<TmuxStatus>(`${API_BASE}/tmux/status`).then(setTmuxStatus).catch((err) => {
          log.warn({ err, endpoint: 'tmux/status' }, 'Failed to sync on WS reconnect')
        })
        if (selectedIdRef.current) {
          const sessionId = selectedIdRef.current
          fetchJson<Session>(`${API_BASE}/sessions/${sessionId}`).then(setCurrentSession).catch((err) => {
            log.warn({ err, endpoint: 'sessions/<id>', sessionId }, 'Failed to sync on WS reconnect')
          })
        }
      }

      ws.onmessage = handleMessage

      ws.onclose = () => {
        log.info('WS connection closed')
        setWsConnected(false)
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

  // Read the draft text for a session (empty string if none).
  const getDraft = useCallback((sessionId: string): string => {
    return drafts[sessionId] ?? ''
  }, [drafts])

  // Write the draft text for a session. Empty strings remove the entry
  // so the map does not grow indefinitely as sessions are visited.
  const setDraft = useCallback((sessionId: string, text: string) => {
    setDrafts((prev) => {
      if (text === '') {
        if (!(sessionId in prev)) return prev
        const next = { ...prev }
        delete next[sessionId]
        return next
      }
      if (prev[sessionId] === text) return prev
      return { ...prev, [sessionId]: text }
    })
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

    const res = await kbFetch(`${API_BASE}/sessions/${sessionId}/send`, {
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

  // Start a new session.
  //
  // `message` is optional: callers that supply `options.initialPrompt`
  // (a server-side dictionary key, e.g. 'security:add-deny-pattern')
  // let the server resolve the locale-aware prompt text instead of
  // passing a literal message. The server requires exactly one of the
  // two to be present.
  const startNewSession = useCallback(async (
    message: string | undefined,
    agentId?: string,
    options?: { origin?: SessionOrigin; initialPrompt?: string },
  ): Promise<NewSessionResponse> => {
    const body: Record<string, unknown> = { agentId }
    if (message !== undefined) body.message = message
    if (options?.origin) body.origin = options.origin
    if (options?.initialPrompt) body.initialPrompt = options.initialPrompt
    const res = await kbFetch(`${API_BASE}/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

    const res = await kbFetch(`${API_BASE}/tmux/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowName, message }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `API error: ${res.status}`)
    }
  }, [addOptimisticMessage])

  // Clear existing session via tmux and send a new message.
  //
  // SS-1 fix: callers can now park an origin reservation alongside
  // the /clear request. Without it the server cannot tag
  // `session.agentId` for vanilla `claude` agents (notably the
  // Q13 / AA-7 default) and the agent-activity-monitor goes silent
  // because it looks the session up via that exact field.
  const tmuxClearAndSend = useCallback(
    async (
      windowName: string,
      message: string,
      options?: { agentId?: string; origin?: SessionOrigin },
    ): Promise<void> => {
      const body: Record<string, unknown> = { windowName, message }
      if (options?.agentId) body.agentId = options.agentId
      if (options?.origin) body.origin = options.origin
      const res = await kbFetch(`${API_BASE}/tmux/clear-and-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(err.error || `API error: ${res.status}`)
      }
    },
    [],
  )

  // Q6 / SS-5: stop the current Claude Code response by sending Ctrl-C
  // to the agent's tmux window. Best-effort — failures are logged via
  // the throw so the caller can decide whether to surface an error.
  const tmuxInterrupt = useCallback(async (windowName: string): Promise<void> => {
    const res = await kbFetch(`${API_BASE}/tmux/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowName }),
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
      await kbFetch(`${API_BASE}/sessions/${sessionId}/set-agent`, {
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
        trustPromptLog.warn('Skipping choice response: WebSocket not connected')
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
        trustPromptLog.warn('Skipping raw-keys response: WebSocket not connected')
        return
      }
      if (rawKeys.length > 1024) {
        trustPromptLog.warn({ chars: rawKeys.length }, 'raw-keys too long, send aborted')
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

  /**
   * Non-destructive hide for the `multi-question-unsupported` degrade modal
   * (BL-2026-263 Phase A, trust-prompt-relay.md v1.8 §10.7.2, plan A).
   *
   * Unlike `dismissTrustPrompt`, this does NOT remove the item from the
   * queue — it only records the promptId so the UI stops showing it *now*.
   * The prompt stays pending on the server, so:
   *   - it re-surfaces on the next `trust_prompt_detected` broadcast /
   *     reconnect replay for the same promptId (that handler clears this
   *     entry), per the spec's "close re-surfaces" contract, and
   *   - it is finally dropped from the queue (and from this set) only when
   *     the server emits `trust_prompt_resolved` (e.g. after Esc cancel or
   *     operating the form via tmux).
   * Removing it from the queue here would leave Claude Code waiting in
   * tmux with no reminder (silent-stall).
   */
  const hideTrustPromptNonDestructive = useCallback((promptId: string) => {
    setDismissedTrustPromptIds((prev) => {
      if (prev.has(promptId)) return prev
      const next = new Set(prev)
      next.add(promptId)
      return next
    })
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

  // The first non-dismissed item in the queue is the one to display in the
  // modal (Phase 5c / 5d; Phase A added the non-destructive dismiss set so a
  // closed degrade modal stays out of view while its prompt remains pending).
  const currentTrustPrompt = useMemo(
    () => trustPromptQueue.find((p) => !dismissedTrustPromptIds.has(p.payload.promptId)) ?? null,
    [trustPromptQueue, dismissedTrustPromptIds],
  )

  return {
    sessions, currentSession, selectedId, config, agents, sessionAgentMap, tmuxStatus, isLoading,
    selectSession, refreshSessions, reloadCurrentSession, refreshAgents, refreshTmuxStatus,
    sendMessage, startNewSession, tmuxSend, tmuxClearAndSend, tmuxInterrupt, setSessionAgent,
    isSessionSendable, rollbackOptimisticMessage,
    // Per-session draft text for <MessageInput>
    getDraft, setDraft,
    // Latest agent activity line per session (cleared on status change)
    agentActivities,
    // Trust prompt relay (Phase 5c / 5d)
    currentTrustPrompt, respondTrustPromptChoice, respondTrustPromptRawKeys, dismissTrustPrompt,
    hideTrustPromptNonDestructive,
    // WebSocket connection state (used by admin status indicator)
    wsConnected,
    // Bumped when the server reports `app_menu_changed`; use as a
    // useEffect dependency to refetch user menu entries.
    appMenuVersion,
    // Bumped when the server reports `recipe_apps_changed`; use as a
    // useEffect dependency to refetch `/api/recipes/sample`.
    sampleRecipeVersion,
  }
}
