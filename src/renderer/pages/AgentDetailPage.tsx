/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom'
import type { AgentInfo, SessionSummary, AgentConfig, TmuxStatus, SessionOrigin } from '../types'
import { AgentDetail } from '../components/AgentDetail'
import { kbFetch } from '../lib/kbFetch'

interface AgentDetailPageProps {
  agents: AgentInfo[]
  sessions: SessionSummary[]
  sessionAgentMap: Record<string, string>
  config: { agents: Record<string, AgentConfig> } | null
  tmuxStatus: TmuxStatus | null
  tmuxClearAndSend: (
    windowName: string,
    message: string,
    options?: { agentId?: string; origin?: SessionOrigin },
  ) => Promise<unknown>
  startNewSession: (
    message: string,
    agentId?: string,
    options?: { origin?: SessionOrigin },
  ) => Promise<unknown>
  setSessionAgent: (sessionId: string, agentId: string) => void
  theme: 'dark' | 'light'
}

export function AgentDetailPage({
  agents, sessions, sessionAgentMap, config, tmuxStatus,
  tmuxClearAndSend, startNewSession, setSessionAgent, theme,
}: AgentDetailPageProps) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  const agent = useMemo(() => {
    if (!id) return null
    return agents.find((a) => a.id === id) || null
  }, [agents, id])

  // Sessions filtered by this agent
  const agentSessions = useMemo(() => {
    if (!id) return []
    return sessions.filter((s) => sessionAgentMap[s.id] === id)
  }, [sessions, sessionAgentMap, id])

  // --- Hand-off: auto-open the freshly-created session ---
  //
  // Two callers navigate here with `?openLatestSession=1`:
  //
  //   1. Onboarding hand-off (Kobi added). The agent has no prior
  //      sessions, so opening the latest matching session — or, when
  //      the watcher has not yet attached the agent association,
  //      claiming the latest unmapped session — is correct.
  //
  //   2. Recipe install / recipe-create-app / app-removal hand-offs.
  //      These target an agent that LIKELY already has prior sessions
  //      (the user picked an existing agent in the modal), so the
  //      "latest mapped session" path would race against the still-
  //      pending new JSONL and open a stale, finished session
  //      (RC-4). For these callers the navigation also includes
  //      `&awaitNewSession=1`: we baseline the current set of session
  //      IDs and only redirect once a session appears OUTSIDE that
  //      baseline (i.e. a fresh JSONL the watcher has just picked up).
  //
  // The query flags are consumed on first use so reloads after the
  // redirect do not re-fire.
  const [autoOpenLatest, setAutoOpenLatest] = useState(
    () => new URLSearchParams(location.search).get('openLatestSession') === '1',
  )
  const awaitNewSession = useMemo(
    () => new URLSearchParams(location.search).get('awaitNewSession') === '1',
    [location.search],
  )
  // Baseline of session IDs at the moment we entered the page with
  // `awaitNewSession=1`. Captured lazily inside the effect (rather
  // than useState init) because the parent may push the sessions list
  // asynchronously after mount; capturing eagerly would risk an empty
  // baseline that matches every subsequent session.
  const awaitNewSessionBaselineRef = useRef<Set<string> | null>(null)
  // `setAutoOpenLatest(false)` flips on the next render, which leaves a
  // one-frame window where the same effect can fire twice (for example
  // when setSessionAgent's optimistic map update schedules another run
  // before the flag settles). Guarding with a ref ensures the claim and
  // redirect happen at most once per mount.
  const autoOpenHandledRef = useRef(false)
  useEffect(() => {
    if (!autoOpenLatest || !id) return
    if (autoOpenHandledRef.current) return

    // --- Path A: awaitNewSession=1 (install / create-app / removal) ---
    if (awaitNewSession) {
      if (awaitNewSessionBaselineRef.current === null) {
        // First settle on this mount: snapshot known session IDs so we
        // can detect additions. The new session JSONL is not yet on
        // disk (Claude writes it after `--print` returns) and we wait
        // for the watcher to surface it.
        awaitNewSessionBaselineRef.current = new Set(sessions.map((s) => s.id))
        return
      }

      const baseline = awaitNewSessionBaselineRef.current
      const fresh = sessions.filter((s) => !baseline.has(s.id))
      if (fresh.length === 0) return

      const latest = fresh
        .slice()
        .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())[0]

      // Claim the association if Claude has not emitted an
      // agent-setting event for the fresh session yet (mirrors the
      // onboarding fallback below).
      if (!sessionAgentMap[latest.id] || sessionAgentMap[latest.id] === 'default') {
        setSessionAgent(latest.id, id)
      }
      autoOpenHandledRef.current = true
      setAutoOpenLatest(false)
      navigate(`/sessions/${latest.id}`, { replace: true })
      return
    }

    // --- Path B: openLatestSession=1 only (onboarding hand-off) ---

    // 1) Prefer a session already mapped to this agent.
    if (agentSessions.length > 0) {
      const latest = agentSessions
        .slice()
        .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())[0]
      autoOpenHandledRef.current = true
      setAutoOpenLatest(false)
      navigate(`/sessions/${latest.id}`, { replace: true })
      return
    }

    // 2) Fallback for the onboarding hand-off: the watcher has just
    //    picked up Kobi's freshly-created JSONL, but Claude Code does
    //    not emit an agent-setting event on its own, so the session is
    //    still unmapped (or defaulted). Claim the most recent unmapped
    //    session for this agent so the server persists the association
    //    and the session view labels it correctly.
    const unmapped = sessions.filter(
      (s) => !sessionAgentMap[s.id] || sessionAgentMap[s.id] === 'default',
    )
    if (unmapped.length === 0) return

    const latest = unmapped
      .slice()
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())[0]

    autoOpenHandledRef.current = true
    setSessionAgent(latest.id, id)
    setAutoOpenLatest(false)
    navigate(`/sessions/${latest.id}`, { replace: true })
  }, [
    autoOpenLatest,
    awaitNewSession,
    agentSessions,
    sessions,
    sessionAgentMap,
    id,
    setSessionAgent,
    navigate,
  ])

  // --- New session creation logic ---
  const pendingAgentIdRef = useRef<string | null>(null)
  const pendingKnownSessionIdsRef = useRef<Set<string>>(new Set())
  const [isPendingNewSession, setIsPendingNewSession] = useState(false)

  // Detect new sessions created after pending request
  useEffect(() => {
    const pendingAgentId = pendingAgentIdRef.current
    if (!pendingAgentId) return

    const unknownSessions = sessions.filter((s) => !pendingKnownSessionIdsRef.current.has(s.id))
    const newSession =
      unknownSessions.find((s) => sessionAgentMap[s.id] === pendingAgentId) ||
      unknownSessions.find((s) => !sessionAgentMap[s.id])

    if (newSession) {
      // Set agent if not already mapped
      if (!sessionAgentMap[newSession.id]) {
        setSessionAgent(newSession.id, pendingAgentId)
      }

      // Clear pending state
      pendingAgentIdRef.current = null
      pendingKnownSessionIdsRef.current = new Set()
      setIsPendingNewSession(false)

      // Navigate to the new session
      navigate(`/sessions/${newSession.id}`)
    }
  }, [sessions, sessionAgentMap, setSessionAgent, navigate])

  const startPendingNewSession = useCallback((agentId: string) => {
    pendingKnownSessionIdsRef.current = new Set(sessions.map((s) => s.id))
    pendingAgentIdRef.current = agentId
    setIsPendingNewSession(true)
  }, [sessions])

  const handleStartNewSession = useCallback(async (agentId: string, message: string) => {
    // Deactivate existing active sessions
    try {
      await kbFetch(`/api/agents/${agentId}/deactivate-sessions`, { method: 'POST' })
    } catch {
      // Continue even if deactivation fails
    }

    // Send via tmux if available
    if (tmuxStatus?.hasSession) {
      const windowName = tmuxStatus.agentWindowMap?.[agentId]
      if (windowName) {
        const window = tmuxStatus.windows.find((w) => w.name === windowName)
        if (window) {
          startPendingNewSession(agentId)
          // SS-1 fix: park `origin: 'sessions'` so the new session
          // inherits an agentId via the SessionManager reservation
          // even when Claude Code does not emit `agent-setting` (the
          // Q13 / AA-7 default agent runs as plain `claude`). Without
          // this, agent-activity-monitor can never resolve the
          // resulting session and the typing-indicator stays empty.
          await tmuxClearAndSend(windowName, message, {
            agentId,
            origin: 'sessions',
          })
          return
        }
      }
    }

    // Fallback: start via CLI
    startPendingNewSession(agentId)
    await startNewSession(message, agentId, { origin: 'sessions' })
  }, [tmuxStatus, tmuxClearAndSend, startNewSession, startPendingNewSession])

  const handleSelectSession = useCallback((sessionId: string) => {
    navigate(`/sessions/${sessionId}`)
  }, [navigate])

  const handleBack = useCallback(() => {
    navigate('/agents')
  }, [navigate])

  const handleEdit = useCallback((agentId: string) => {
    navigate(`/agents/${agentId}/edit`)
  }, [navigate])

  const handleRestartAgent = useCallback(async (agentId: string) => {
    const res = await kbFetch(`/api/agents/${agentId}/restart`, { method: 'POST' })
    if (!res.ok) {
      throw new Error(`Agent restart failed: ${res.status}`)
    }
  }, [])

  if (!agent) {
    return <Navigate to="/agents" replace />
  }

  return (
    <AgentDetail
      agent={agent}
      sessions={agentSessions}
      onBack={handleBack}
      onSelectSession={handleSelectSession}
      onStartNewSession={handleStartNewSession}
      isPendingNewSession={isPendingNewSession}
      // Q13 / AA-7: system-managed agents (e.g. "Claude (default)")
      // are not editable. Suppressing onEdit drops the edit affordance
      // from the profile tab — the AgentEditPage route still exists
      // but is unreachable through the UI for these IDs.
      onEdit={agent.isSystem ? undefined : handleEdit}
      onRestartAgent={handleRestartAgent}
      theme={theme}
    />
  )
}
