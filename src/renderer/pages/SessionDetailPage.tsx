/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import type { Session, SessionSummary, AgentConfig, TmuxStatus, SessionOrigin, ParsedEvent } from '../types'
import { t } from '../i18n'
import { ChatTimeline } from '../components/ChatTimeline'
import { FilePreview } from '../components/FilePreview'
import { kbFetch } from '../lib/kbFetch'

/**
 * S2 safety timeout (T2) for the onboarding first-session loading state
 * machine (onboarding-scenarios.md §5.3.3). After this budget the
 * `awaitingFirstResponse` spinner is force-cleared so it cannot linger
 * if the agent never replies.
 */
export const AWAITING_FIRST_RESPONSE_TIMEOUT_MS = 90000

/**
 * Whether the onboarding first-response wait (S2) should clear based on
 * the session's content / status.
 *
 * Pure so it is unit-testable. Clears when (i) an assistant or tool_use
 * event has appeared, or (ii) the status moved on to `thinking` /
 * `ready`. The third clear condition — the T2 safety timeout — is
 * time-based and handled by the effect, not this predicate
 * (onboarding-scenarios.md §5.3.3, BL-2026-294).
 */
export function shouldClearAwaitingFirstResponse(session: {
  events: { type: ParsedEvent['type'] }[]
  status: Session['status']
}): boolean {
  const hasResponse = session.events.some(
    (e) => e.type === 'assistant' || e.type === 'tool_use',
  )
  return hasResponse || session.status === 'thinking' || session.status === 'ready'
}

interface SessionDetailPageProps {
  sessions: SessionSummary[]
  currentSession: Session | null
  selectedId: string | null
  sessionAgentMap: Record<string, string>
  agentConfigs: Record<string, AgentConfig>
  defaultAgentConfig: AgentConfig
  userConfig: AgentConfig
  tmuxStatus: TmuxStatus | null
  selectSession: (id: string) => void
  reloadCurrentSession: () => void
  sendMessage: (sessionId: string, message: string) => Promise<unknown>
  tmuxSend: (windowName: string, message: string, sessionId?: string) => Promise<unknown>
  tmuxClearAndSend: (
    windowName: string,
    message: string,
    options?: { agentId?: string; origin?: SessionOrigin },
  ) => Promise<unknown>
  /** Q6 / SS-5: dispatch Ctrl-C to a tmux window. Best-effort. */
  tmuxInterrupt: (windowName: string) => Promise<void>
  startNewSession: (
    message: string,
    agentId?: string,
    options?: { origin?: SessionOrigin },
  ) => Promise<unknown>
  setSessionAgent: (sessionId: string, agentId: string) => void
  isSessionSendable: (sessionId: string) => boolean
  rollbackOptimisticMessage: (sessionId: string) => void
  /** Read the per-session draft for the message input (see useIPC). */
  getDraft: (sessionId: string) => string
  /** Write the per-session draft for the message input (empty string clears). */
  setDraft: (sessionId: string, value: string) => void
  /** Latest agent activity line per session (see useIPC.agentActivities). */
  agentActivities: Record<string, string>
  theme: 'dark' | 'light'
}

export function SessionDetailPage({
  sessions, currentSession, selectedId, sessionAgentMap, agentConfigs,
  defaultAgentConfig, userConfig, tmuxStatus,
  selectSession, reloadCurrentSession, sendMessage,
  tmuxSend, tmuxClearAndSend, tmuxInterrupt, startNewSession, setSessionAgent,
  isSessionSendable, rollbackOptimisticMessage,
  getDraft, setDraft, agentActivities, theme,
}: SessionDetailPageProps) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)

  // S2 of the onboarding first-session loading state machine
  // (onboarding-scenarios.md §5.3.3). AgentDetailPage's Path B hands off
  // `pendingFirstResponse` via router state when it redirects to the
  // freshly-created concierge session. The new session's JSONL was
  // restored as historical, so `status` sits at `idle` until Kobi's
  // first reply and the status-driven typing indicator never fires;
  // `awaitingFirstResponse` keeps the indicator lit across that gap.
  const [awaitingFirstResponse, setAwaitingFirstResponse] = useState(
    () =>
      (location.state as { pendingFirstResponse?: boolean } | null)
        ?.pendingFirstResponse === true,
  )

  // Arm the T2 safety timeout once when the wait begins. Depending only
  // on `awaitingFirstResponse` (not on the session) keeps a single timer
  // alive across session updates instead of resetting it on every event.
  useEffect(() => {
    if (!awaitingFirstResponse) return
    const timer = setTimeout(
      () => setAwaitingFirstResponse(false),
      AWAITING_FIRST_RESPONSE_TIMEOUT_MS,
    )
    return () => clearTimeout(timer)
  }, [awaitingFirstResponse])

  // Clear as soon as a response appears or the status moves on.
  useEffect(() => {
    if (!awaitingFirstResponse || !currentSession) return
    if (shouldClearAwaitingFirstResponse(currentSession)) {
      setAwaitingFirstResponse(false)
    }
  }, [awaitingFirstResponse, currentSession])

  // --- New session creation logic ---
  const pendingAgentIdRef = useRef<string | null>(null)
  const pendingKnownSessionIdsRef = useRef<Set<string>>(new Set())
  const [isPendingNewSession, setIsPendingNewSession] = useState(false)

  // Sync URL param with useIPC's selectSession
  useEffect(() => {
    if (id && id !== selectedId) {
      selectSession(id)
    }
  }, [id, selectedId, selectSession])

  // Reset file preview when session changes
  useEffect(() => {
    setPreviewFilePath(null)
  }, [id])

  // Detect new sessions created after pending request
  useEffect(() => {
    const pendingAgentId = pendingAgentIdRef.current
    if (!pendingAgentId) return

    const unknownSessions = sessions.filter((s) => !pendingKnownSessionIdsRef.current.has(s.id))
    const newSession =
      unknownSessions.find((s) => sessionAgentMap[s.id] === pendingAgentId) ||
      unknownSessions.find((s) => !sessionAgentMap[s.id])

    if (newSession) {
      if (!sessionAgentMap[newSession.id]) {
        setSessionAgent(newSession.id, pendingAgentId)
      }
      pendingAgentIdRef.current = null
      pendingKnownSessionIdsRef.current = new Set()
      setIsPendingNewSession(false)
      navigate(`/sessions/${newSession.id}`)
    }
  }, [sessions, sessionAgentMap, setSessionAgent, navigate])

  const startPendingNewSession = useCallback((agentId: string) => {
    pendingKnownSessionIdsRef.current = new Set(sessions.map((s) => s.id))
    pendingAgentIdRef.current = agentId
    setIsPendingNewSession(true)
  }, [sessions])

  // Resolve tmux window name for the current session
  const resolveTmuxWindow = useCallback((sessionId: string): string | null => {
    if (!tmuxStatus?.hasSession) return null
    const agentId = sessionAgentMap[sessionId]
    if (!agentId) return null
    const windowName = tmuxStatus.agentWindowMap?.[agentId]
    if (!windowName) return null
    const window = tmuxStatus.windows.find((w) => w.name === windowName)
    return window ? window.name : null
  }, [tmuxStatus, sessionAgentMap])

  // Send message to the current session.
  //
  // An `idle` session is not a terminated one: the 5-minute idle timer
  // only flips the status label while the claude process and its tmux
  // window stay alive. A plain `tmuxSend` to such a session appends to
  // the SAME claude session (claude only starts a fresh JSONL session on
  // `/clear`), so we must NOT arm `startPendingNewSession` here — doing
  // so would wait for a new session that never appears, leaving the
  // Continue button stuck in its loading state and the typing indicator
  // showing forever while the reply is in fact streamed into the session
  // already on screen. Starting a brand new topic goes through
  // `handleStartNewTopic` (the `/clear` path), which is where the pending
  // new-session navigation belongs.
  const handleSendMessage = useCallback(async (sessionId: string, message: string) => {
    const windowName = resolveTmuxWindow(sessionId)
    if (windowName) {
      await tmuxSend(windowName, message, sessionId)
    } else {
      await sendMessage(sessionId, message)
    }
  }, [resolveTmuxWindow, tmuxSend, sendMessage])

  // Start new topic for the current session
  const handleStartNewTopic = useCallback(async (agentId: string, message: string) => {
    try {
      await kbFetch(`/api/agents/${agentId}/deactivate-sessions`, { method: 'POST' })
    } catch {
      // Continue
    }

    if (tmuxStatus?.hasSession) {
      const windowName = tmuxStatus.agentWindowMap?.[agentId]
      if (windowName) {
        const window = tmuxStatus.windows.find((w) => w.name === windowName)
        if (window) {
          startPendingNewSession(agentId)
          // SS-1 fix: park `origin: 'sessions'` so the new session
          // inherits an agentId via the SessionManager reservation
          // (mirrors AgentDetailPage). Required for the Q13 / AA-7
          // default agent which never emits `agent-setting`.
          await tmuxClearAndSend(windowName, message, {
            agentId,
            origin: 'sessions',
          })
          return
        }
      }
    }

    startPendingNewSession(agentId)
    await startNewSession(message, agentId, { origin: 'sessions' })
  }, [tmuxStatus, tmuxClearAndSend, startNewSession, startPendingNewSession])

  // Send error handler (rollback optimistic message)
  const handleSendError = useCallback((sessionId: string) => {
    return (_error: Error) => {
      rollbackOptimisticMessage(sessionId)
    }
  }, [rollbackOptimisticMessage])

  // Q6 / SS-5: stop the in-flight response by dispatching Ctrl-C to
  // the agent's tmux window. Resolves silently when the session has
  // no associated tmux window (the API would 400 anyway, and the
  // Stop button is hidden in that case so this branch is defensive).
  const handleInterrupt = useCallback(async () => {
    if (!id) return
    const windowName = resolveTmuxWindow(id)
    if (!windowName) return
    try {
      await tmuxInterrupt(windowName)
    } catch {
      // Best-effort — agent will continue producing the response,
      // and the user can hit Stop again on the next idle tick.
    }
  }, [id, resolveTmuxWindow, tmuxInterrupt])

  // Determine agent config for the current session
  const currentAgentId = id ? sessionAgentMap[id] : undefined
  const agentConfig = useMemo(() => {
    if (currentAgentId && currentAgentId !== 'default' && agentConfigs[currentAgentId]) {
      return agentConfigs[currentAgentId]
    }
    return defaultAgentConfig
  }, [currentAgentId, agentConfigs, defaultAgentConfig])

  // Agent name/color for ChatTimeline header
  const agentName = agentConfig.name
  const agentColor = agentConfig.color

  if (!currentSession || currentSession.id !== id) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-sm">
        {t('session.detail.status.loading')}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-row overflow-hidden">
      <ChatTimeline
        session={currentSession}
        agentConfig={agentConfig}
        userConfig={userConfig}
        onSendMessage={id && (isSessionSendable(id) || currentSession.status !== 'idle')
          ? handleSendMessage : undefined}
        onReload={reloadCurrentSession}
        onStartNewTopic={currentAgentId ? handleStartNewTopic : undefined}
        agentId={currentAgentId}
        isPendingNewSession={isPendingNewSession}
        onContinueSession={currentAgentId ? handleStartNewTopic : undefined}
        onFilePathClick={(path) => setPreviewFilePath(path)}
        onSendError={id ? handleSendError(id) : undefined}
        onInterrupt={handleInterrupt}
        agentName={agentName}
        agentColor={agentColor}
        draftValue={getDraft(currentSession.id)}
        onDraftChange={(value) => setDraft(currentSession.id, value)}
        activityLine={agentActivities[currentSession.id]}
        awaitingFirstResponse={awaitingFirstResponse}
        theme={theme}
      />
      {previewFilePath && (
        <FilePreview
          filePath={previewFilePath}
          onClose={() => setPreviewFilePath(null)}
        />
      )}
    </div>
  )
}
