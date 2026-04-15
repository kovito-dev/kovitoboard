import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useIPC } from './hooks/useIPC'
import { useTheme } from './hooks/useTheme'
import { TitleBar, type AgentStatus } from './components/TitleBar'
import { Layout } from './components/Layout'
import { NavMenu, Icons, getIcon, type MenuEntry } from './components/NavMenu'
import { SessionList } from './components/SessionList'
import { SettingsModal } from './components/SettingsModal'
import { TrustPromptModal } from './components/TrustPromptModal'
import { AgentsPage } from './pages/AgentsPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { SessionsPage } from './pages/SessionsPage'
import { SessionDetailPage } from './pages/SessionDetailPage'
import { loadUserMenuEntries, loadUserStyles } from './app-loader'
import type { AppMenuEntry } from './types/app-types'

// --- Menu definition ---
const menuEntries: MenuEntry[] = [
  {
    id: 'agents',
    label: 'エージェント',
    icon: Icons.agents,
  },
  {
    id: 'sessions',
    label: 'セッション',
    icon: Icons.sessions,
  },
]

export function App() {
  const ipc = useIPC()
  const { sessions, config, agents, sessionAgentMap, tmuxStatus, isLoading,
    currentSession, selectedId, selectSession, reloadCurrentSession,
    sendMessage, startNewSession, tmuxSend, tmuxClearAndSend,
    setSessionAgent, isSessionSendable, rollbackOptimisticMessage,
    currentTrustPrompt, respondTrustPromptChoice, respondTrustPromptRawKeys, dismissTrustPrompt,
  } = ipc
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  // User extension menu entries from app/menu.ts
  const [userMenuEntries, setUserMenuEntries] = useState<AppMenuEntry[]>([])

  useEffect(() => {
    loadUserMenuEntries().then(setUserMenuEntries)
    loadUserStyles()
  }, [])

  // Merge builtin + user menu entries for NavMenu
  const allMenuEntries: MenuEntry[] = useMemo(() => {
    const userEntries: MenuEntry[] = userMenuEntries.map((entry) => ({
      id: `ext/${entry.id}`,
      label: entry.label,
      icon: getIcon(entry.icon),
    }))
    return [...menuEntries, ...userEntries]
  }, [userMenuEntries])

  // Lazy components for user pages
  const userPageComponents = useMemo(() => {
    const map = new Map<string, React.LazyExoticComponent<React.ComponentType>>()
    for (const entry of userMenuEntries) {
      map.set(entry.id, lazy(entry.component))
    }
    return map
  }, [userMenuEntries])

  // Active menu determined by URL path
  const activeMenuId = useMemo(() => {
    if (location.pathname.startsWith('/sessions')) return 'sessions'
    if (location.pathname.startsWith('/ext/')) {
      const parts = location.pathname.split('/')
      return `ext/${parts[2] ?? ''}`
    }
    return 'agents'
  }, [location.pathname])

  // Settings modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  const projectName = config?.project?.name || 'KovitoBoard'
  const projectDescription = config?.project?.description
  const userConfig = config?.user || { name: 'User', color: '#7C3AED' }
  const defaultAgentConfig = config?.agents?.default || { name: 'デフォルト', color: '#A67B5B' }

  // Set browser tab title
  useEffect(() => {
    document.title = projectName
  }, [projectName])

  // --- Header: agent active status (sorted by employee_id) ---
  const agentStatuses: AgentStatus[] = useMemo(() => {
    if (!config) return []
    const agentIds = Object.keys(config.agents).filter((id) => id !== 'default')
    const statuses = agentIds.map((agentId) => {
      const agentSessions = sessions.filter((s) => sessionAgentMap[s.id] === agentId)
      const hasActiveSession = agentSessions.some((s) => s.status !== 'idle')
      return { agentId, hasActiveSession }
    })
    statuses.sort((a, b) => {
      const agentA = agents.find((ag) => ag.id === a.agentId)
      const agentB = agents.find((ag) => ag.id === b.agentId)
      const numA = agentA?.employeeId ? parseInt(agentA.employeeId, 10) : Infinity
      const numB = agentB?.employeeId ? parseInt(agentB.employeeId, 10) : Infinity
      return numA - numB
    })
    return statuses
  }, [config, sessions, sessionAgentMap, agents])

  // --- Header agent icon click ---
  const handleHeaderAgentClick = useCallback((agentId: string) => {
    const activeSessions = sessions
      .filter((s) => sessionAgentMap[s.id] === agentId && s.status !== 'idle')
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())

    if (activeSessions.length > 0) {
      navigate(`/sessions/${activeSessions[0].id}`)
    } else {
      navigate(`/agents/${agentId}`)
    }
  }, [sessions, sessionAgentMap, navigate])

  // --- Session list click ---
  const handleSelectSession = useCallback((sessionId: string) => {
    navigate(`/sessions/${sessionId}`)
  }, [navigate])

  // --- Sidebar rendering ---
  const renderSidebar = () => {
    if (activeMenuId === 'sessions') {
      return (
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          onSelect={handleSelectSession}
          sessionAgentMap={sessionAgentMap}
          agentConfigs={config?.agents || {}}
          defaultAgentConfig={defaultAgentConfig}
          theme={theme}
        />
      )
    }
    return null
  }

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)]">
      <TitleBar
        projectName={projectName}
        projectDescription={projectDescription}
        agentConfigs={config?.agents || {}}
        agentStatuses={agentStatuses}
        onAgentClick={handleHeaderAgentClick}
        onOpenSettings={() => setIsSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[var(--text-dim)] text-sm">セッションを読み込み中...</div>
        </div>
      ) : (
        <>
        <Layout
          nav={
            <NavMenu
              entries={allMenuEntries}
              activeId={activeMenuId}
              onSelect={(id) => navigate(`/${id}`)}
            />
          }
          sidebar={renderSidebar()}
          isMobileSidebarOpen={false}
          onCloseMobileSidebar={() => {}}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/agents" replace />} />
            <Route path="/agents" element={
              <AgentsPage
                agents={agents}
                sessions={sessions}
                config={config}
                theme={theme}
              />
            } />
            <Route path="/agents/:id" element={
              <AgentDetailPage
                agents={agents}
                sessions={sessions}
                sessionAgentMap={sessionAgentMap}
                config={config}
                tmuxStatus={tmuxStatus}
                tmuxClearAndSend={tmuxClearAndSend}
                startNewSession={startNewSession}
                setSessionAgent={setSessionAgent}
                theme={theme}
              />
            } />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:id" element={
              <SessionDetailPage
                sessions={sessions}
                currentSession={currentSession}
                selectedId={selectedId}
                sessionAgentMap={sessionAgentMap}
                agentConfigs={config?.agents || {}}
                defaultAgentConfig={defaultAgentConfig}
                userConfig={userConfig}
                tmuxStatus={tmuxStatus}
                selectSession={selectSession}
                reloadCurrentSession={reloadCurrentSession}
                sendMessage={sendMessage}
                tmuxSend={tmuxSend}
                tmuxClearAndSend={tmuxClearAndSend}
                startNewSession={startNewSession}
                setSessionAgent={setSessionAgent}
                isSessionSendable={isSessionSendable}
                rollbackOptimisticMessage={rollbackOptimisticMessage}
                theme={theme}
              />
            } />
            {/* User extension pages */}
            {userMenuEntries.map((entry) => {
              const LazyPage = userPageComponents.get(entry.id)
              if (!LazyPage) return null
              return (
                <Route
                  key={`ext-${entry.id}`}
                  path={`/ext/${entry.id}`}
                  element={
                    <Suspense fallback={
                      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-sm">
                        読み込み中...
                      </div>
                    }>
                      <LazyPage />
                    </Suspense>
                  }
                />
              )
            })}
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        </Layout>

        {/* Mobile bottom nav */}
        <div className="md:hidden shrink-0 bg-[var(--bg-nav)] border-t border-[var(--border)] flex items-center justify-around py-1.5 px-2">
          {allMenuEntries.map((entry) => {
            const isActive = activeMenuId === entry.id
            return (
              <button
                key={entry.id}
                onClick={() => navigate(`/${entry.id}`)}
                className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors ${
                  isActive
                    ? 'text-[var(--accent-text)]'
                    : 'text-[var(--text-dim)]'
                }`}
              >
                <span className="w-5 h-5">{entry.icon}</span>
                <span className="text-[10px]">{entry.label}</span>
              </button>
            )
          })}
        </div>
        </>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* Trust prompt relay modal */}
      <TrustPromptModal
        item={currentTrustPrompt}
        onChoice={(choiceId) => {
          if (!currentTrustPrompt) return
          respondTrustPromptChoice(
            currentTrustPrompt.payload.promptId,
            currentTrustPrompt.payload.windowName,
            choiceId,
          )
        }}
        onRawKeys={(rawKeys) => {
          if (!currentTrustPrompt) return
          respondTrustPromptRawKeys(
            currentTrustPrompt.payload.promptId,
            currentTrustPrompt.payload.windowName,
            rawKeys,
          )
        }}
        onDismiss={() => {
          if (!currentTrustPrompt) return
          dismissTrustPrompt(currentTrustPrompt.payload.promptId)
        }}
      />
    </div>
  )
}
