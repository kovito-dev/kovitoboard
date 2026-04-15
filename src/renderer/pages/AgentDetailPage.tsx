import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import type { AgentInfo, SessionSummary, AgentConfig, TmuxStatus } from '../types'
import { AgentDetail } from '../components/AgentDetail'

interface AgentDetailPageProps {
  agents: AgentInfo[]
  sessions: SessionSummary[]
  sessionAgentMap: Record<string, string>
  config: { agents: Record<string, AgentConfig> } | null
  tmuxStatus: TmuxStatus | null
  tmuxClearAndSend: (windowName: string, message: string) => Promise<unknown>
  startNewSession: (message: string, agentId?: string) => Promise<unknown>
  setSessionAgent: (sessionId: string, agentId: string) => void
  theme: 'dark' | 'light'
}

export function AgentDetailPage({
  agents, sessions, sessionAgentMap, config, tmuxStatus,
  tmuxClearAndSend, startNewSession, setSessionAgent, theme,
}: AgentDetailPageProps) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const agent = useMemo(() => {
    if (!id) return null
    return agents.find((a) => a.id === id) || null
  }, [agents, id])

  // Sessions filtered by this agent
  const agentSessions = useMemo(() => {
    if (!id) return []
    return sessions.filter((s) => sessionAgentMap[s.id] === id)
  }, [sessions, sessionAgentMap, id])

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
      await fetch(`/api/agents/${agentId}/deactivate-sessions`, { method: 'POST' })
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
          await tmuxClearAndSend(windowName, message)
          return
        }
      }
    }

    // Fallback: start via CLI
    startPendingNewSession(agentId)
    await startNewSession(message, agentId)
  }, [tmuxStatus, tmuxClearAndSend, startNewSession, startPendingNewSession])

  const handleSelectSession = useCallback((sessionId: string) => {
    navigate(`/sessions/${sessionId}`)
  }, [navigate])

  const handleBack = useCallback(() => {
    navigate('/agents')
  }, [navigate])

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
      theme={theme}
    />
  )
}
