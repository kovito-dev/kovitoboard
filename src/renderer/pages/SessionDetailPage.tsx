/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { Session, SessionSummary, AgentConfig, TmuxStatus, SessionOrigin } from '../types'
import { t } from '../i18n'
import { ChatTimeline } from '../components/ChatTimeline'
import { FilePreview } from '../components/FilePreview'
import { kbFetch } from '../lib/kbFetch'

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
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)

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

  // Send message to the current session
  const handleSendMessage = useCallback(async (sessionId: string, message: string) => {
    const windowName = resolveTmuxWindow(sessionId)
    if (windowName) {
      const session = sessions.find((s) => s.id === sessionId)
      const agentId = sessionAgentMap[sessionId]
      if (session?.status === 'idle' && agentId) {
        startPendingNewSession(agentId)
      }
      await tmuxSend(windowName, message, sessionId)
    } else {
      await sendMessage(sessionId, message)
    }
  }, [resolveTmuxWindow, sessions, sessionAgentMap, tmuxSend, sendMessage, startPendingNewSession])

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
