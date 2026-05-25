/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { OnboardingPage } from './pages/OnboardingPage'
import { useIPC } from './hooks/useIPC'
import { useTheme } from './hooks/useTheme'
import { useAdminStatus } from './hooks/useAdminStatus'
import { TitleBar, type AgentStatus } from './components/TitleBar'
import { Layout } from './components/Layout'
import { SecurityRecommendationsToast } from './components/SecurityRecommendationsToast'
import { ProjectRootBanner } from './components/ProjectRootBanner'
import { AmbientSidebar } from './components/AmbientSidebar'
import { NavMenu, Icons, getIcon, type MenuEntry } from './components/NavMenu'
import { AppRemovalModal } from './components/AppRemovalModal'
import { RecipeExportModal } from './components/RecipeExportModal'
import { SessionList } from './components/SessionList'
import { SettingsModal } from './components/SettingsModal'
import { TrustPromptModal } from './components/TrustPromptModal'
import { AgentsPage } from './pages/AgentsPage'
import { AgentCreatePage } from './pages/AgentCreatePage'
import { AgentEditPage } from './pages/AgentEditPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { SessionsPage } from './pages/SessionsPage'
import { SessionDetailPage } from './pages/SessionDetailPage'
import { RecipesPage } from './pages/RecipesPage'
import WorkRootsPage from './pages/WorkRootsPage'
import { loadUserMenuEntries, loadUserStyles } from './app-loader'
import { RecipePageHost } from './app-host/RecipePageHost'
import type { AppMenuEntry } from './types/app-types'
import { t } from './i18n'
import { createLogger } from './lib/logger'
import { kbFetch } from './lib/kbFetch'

const log = createLogger('App')

// --- Menu definition ---
// Built once at module evaluation. The locale used here is whatever
// the i18n module resolves at load time — see `i18n/index.ts`
// `readPersistedLocale()`, which restores the choice the user made
// during onboarding from `localStorage` and falls back to `en` when
// nothing has been recorded yet (OSS fallback).
const menuEntries: MenuEntry[] = [
  {
    id: 'agents',
    label: t('nav.menu.agents'),
    icon: Icons.agents,
  },
  {
    id: 'sessions',
    label: t('nav.menu.sessions'),
    icon: Icons.sessions,
  },
  {
    id: 'recipes',
    label: t('nav.menu.recipes'),
    icon: Icons.seeds,
  },
  {
    id: 'work-roots',
    label: t('nav.menu.workRoots'),
    icon: Icons.settings,
  },
]

export function App() {
  const ipc = useIPC()
  const { sessions, config, agents, sessionAgentMap, tmuxStatus, isLoading,
    currentSession, selectedId, selectSession, reloadCurrentSession,
    sendMessage, startNewSession, tmuxSend, tmuxClearAndSend, tmuxInterrupt,
    setSessionAgent, isSessionSendable, rollbackOptimisticMessage,
    getDraft, setDraft, agentActivities,
    currentTrustPrompt, respondTrustPromptChoice, respondTrustPromptRawKeys, dismissTrustPrompt,
    wsConnected, appMenuVersion,
  } = ipc

  // Admin status polling (5s interval, combined with WS state)
  const adminStatus = useAdminStatus(wsConnected)
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  // Onboarding state: null = loading, true = completed, false = not completed
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null)

  useEffect(() => {
    kbFetch('/api/config/setting')
      .then((res) => {
        if (!res.ok) {
          // Setting file not found = onboarding not completed
          setOnboardingComplete(false)
          return null
        }
        return res.json()
      })
      .then((data) => {
        // Body may be `null` when setting.json does not exist (onboarding not yet started)
        if (data == null) {
          setOnboardingComplete(false)
          return
        }
        setOnboardingComplete(data.onboarding?.completedAt != null)
      })
      .catch((err) => {
        log.warn({ err }, 'Failed to check onboarding status, treating as not completed')
        setOnboardingComplete(false)
      })
  }, [])

  // User extension menu entries from app/menu.ts
  const [userMenuEntries, setUserMenuEntries] = useState<AppMenuEntry[]>([])

  useEffect(() => {
    // `appMenuVersion` bumps whenever the server detects a change to
    // `app/menu.ts` (chokidar -> ws `app_menu_changed`). Re-running
    // the loader picks up newly installed recipes without a page
    // reload — see `app-loader.ts` for why the legacy
    // `import.meta.glob` path could not see those files.
    loadUserMenuEntries().then(setUserMenuEntries)
    loadUserStyles()
  }, [appMenuVersion])

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
    if (location.pathname.startsWith('/recipes')) return 'recipes'
    if (location.pathname.startsWith('/work-roots')) return 'work-roots'
    if (location.pathname.startsWith('/ext/')) {
      const parts = location.pathname.split('/')
      return `ext/${parts[2] ?? ''}`
    }
    return 'agents'
  }, [location.pathname])

  // Settings modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Nav rail compact state — lifted out of NavMenu so the rail wrapper
  // (`<div className="flex flex-col h-full ...">` in the Layout nav
  // slot) can drive its own width and so ProjectRootBanner can be
  // hidden when collapsed. Previously the state lived inside NavMenu,
  // which left the wrapper unconstrained: ProjectRootBanner's natural
  // (min-content) width then dictated the rail width, so the expanded
  // rail showed dead space to the right of the menu and compact mode
  // failed to shrink the rail at all (the banner kept it wide).
  const [navCompact, setNavCompact] = useState(false)

  // App removal modal (DEC-024 #3 / DEC-024 #5, spec §F4 — opened via
  // the AmbientSidebar's per-app actions popover instead of the legacy
  // NavMenu actionSlot button).
  const [appRemovalState, setAppRemovalState] = useState<{
    appId: string
    displayName: string
  } | null>(null)
  const [appRemovalSubmitting, setAppRemovalSubmitting] = useState(false)
  const [appRemovalError, setAppRemovalError] = useState<string | null>(null)

  // Recipe export modal (DEC-024 #5 / spec §F5). Opened via the same
  // AmbientSidebar popover that triggers app removal so the two
  // app-scoped actions live side by side.
  const [recipeExportState, setRecipeExportState] = useState<{
    appId: string
    displayName: string
  } | null>(null)

  const projectName = config?.project?.name || 'KovitoBoard'
  const projectDescription = config?.project?.description
  const userConfig = config?.user || { name: 'User', color: '#7C3AED' }
  const defaultAgentConfig = config?.agents?.default || { name: t('agent.default.name'), color: '#A67B5B' }

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

  // Single-source trust-prompt modal. Claude Code shows a folder-trust
  // prompt on the very first launch of a new project, so the modal has
  // to be mounted during onboarding as well — otherwise the user has no
  // way to approve folder trust, and the tmux-bridge prompt-ready wait
  // sits on the trust screen until it times out.
  const trustPromptModal = (
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
  )

  // Onboarding routing logic
  if (location.pathname === '/onboarding') {
    if (onboardingComplete === true) {
      return <Navigate to="/" replace />
    }
    // Notify the App so the onboarding-complete guard releases before
    // <OnboardingPage> triggers the full-page reload. The reload itself
    // rehydrates every state tree from the freshly-written setting.json,
    // but updating the guard first avoids a brief re-redirect flicker.
    return (
      <>
        <OnboardingPage
          onCompleted={() => setOnboardingComplete(true)}
          isTrustPromptPending={currentTrustPrompt != null}
        />
        {trustPromptModal}
      </>
    )
  }
  if (onboardingComplete === null) {
    // Still checking onboarding status — show blank screen to avoid flash
    return <div className="h-screen bg-[var(--bg-base)]" />
  }
  if (onboardingComplete === false) {
    return <Navigate to="/onboarding" replace />
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
        serverIndicatorState={adminStatus.indicatorState}
        serverStatusData={adminStatus.data}
        wsConnected={wsConnected}
        onServerStopped={adminStatus.markStopped}
      />

      {/* Stopped banner (shown after POST /api/admin/stop) */}
      {adminStatus.isStopped && (
        <div className="bg-red-900/30 border-b border-red-500/30 px-6 py-4 text-sm">
          <h3 className="font-semibold text-red-300 mb-1">{t('admin.stopped.banner.title')}</h3>
          <p className="text-[var(--text-muted)] mb-2">{t('admin.stopped.banner.body')}</p>
          <code className="block bg-black/30 rounded px-3 py-2 text-xs text-[var(--text-secondary)] font-mono">
            {t('admin.stopped.banner.command')}
          </code>
          <p className="text-[var(--text-muted)] text-xs mt-2">{t('admin.stopped.banner.footer')}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[var(--text-dim)] text-sm">{t('session.detail.status.loading')}</div>
        </div>
      ) : (
        <>
        <Layout
          nav={
            // Wrap NavMenu + ProjectRootBanner in a single column so
            // the banner pins to the bottom of the nav rail. The
            // banner uses `mt-auto`, which only takes effect when the
            // flex container has a resolved height — `h-full` makes
            // the wrapper consume the parent Layout's nav slot so the
            // banner sits inside the nav rail rather than being
            // pushed outside it (KB-2026-05 hardening).
            //
            // The width class lives on this wrapper (rather than on
            // NavMenu alone) so the rail width is decided in exactly
            // one place. Without a width here ProjectRootBanner's
            // long path/source text would drive the wrapper's
            // min-content width, leaving NavMenu (w-40) with dead
            // space on its right and preventing compact mode from
            // actually shrinking the rail.
            <div
              className={`flex flex-col h-full ${navCompact ? 'w-12' : 'w-40'} transition-[width] duration-200`}
            >
              <NavMenu
                entries={allMenuEntries}
                activeId={activeMenuId}
                onSelect={(id) => navigate(`/${id}`)}
                compact={navCompact}
                onToggleCompact={() => setNavCompact((prev) => !prev)}
                actionSlot={null /* moved to AmbientSidebar popover (DEC-024 #5 / spec §F4) */}
              />
              {/* The banner stays mounted in compact mode as an
                  icon-only surface so the shared-installation-
                  prevention spec requirement to keep the project
                  root continuously visible in the UI remains
                  satisfied. The folder icon carries the hover
                  tooltip for the full path, and a red dot signals
                  the cwd-fallback warning state. */}
              <ProjectRootBanner compact={navCompact} />
            </div>
          }
          sidebar={renderSidebar()}
          /*
           * DEC-020 / EU8 (revised by DEC-024 #3 spec §F7): ambient
           * sidebar is shown on most pages, suppressed on:
           * - Sessions: owns its own conversation surface
           * - Agents (list / detail / create / edit): the agent
           *   screens themselves are the agent-interaction context
           * - Recipes: the recipe install/import flows now spawn
           *   their own agent dialogs via `recipe-install` /
           *   `app-removal`, and the ambient sidebar would compete
           *   for the same affordance.
           */
          rightSidebar={
            activeMenuId === 'sessions' ||
            activeMenuId === 'agents' ||
            activeMenuId === 'recipes'
              ? null
              : (() => {
                  // Resolve the active app once so both `currentAppId`
                  // and `currentAppDisplayName` derive from the same
                  // route observation. `null` when the route is not an
                  // `/ext/<appId>` page; the sidebar hides the per-app
                  // popover in that case (DEC-024 #5 / spec §F3).
                  const activeAppId = activeMenuId.startsWith('ext/')
                    ? activeMenuId.slice('ext/'.length)
                    : null
                  const activeAppEntry = activeAppId
                    ? userMenuEntries.find((e) => e.id === activeAppId)
                    : undefined
                  const activeAppDisplayName = activeAppEntry?.label ?? activeAppId
                  return (
                    <AmbientSidebar
                      agents={agents}
                      sessions={sessions}
                      sessionAgentMap={sessionAgentMap}
                      currentSession={currentSession}
                      tmuxStatus={tmuxStatus}
                      tmuxInterrupt={tmuxInterrupt}
                      selectSession={selectSession}
                      startNewSession={startNewSession}
                      sendMessage={sendMessage}
                      userMenuEntries={userMenuEntries}
                      currentAppId={activeAppId}
                      currentAppDisplayName={activeAppDisplayName}
                      onRequestAppRemoval={({ appId, displayName }) => {
                        setAppRemovalError(null)
                        setAppRemovalState({ appId, displayName })
                      }}
                      onRequestRecipeExport={({ appId, displayName }) => {
                        setRecipeExportState({ appId, displayName })
                      }}
                      theme={theme}
                    />
                  )
                })()
          }
          isMobileSidebarOpen={false}
          onCloseMobileSidebar={() => {}}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/agents" replace />} />
            {/* Onboarding-complete users see the toast surface as a
                portal at the top-right; the inline <StepSecurity>
                step covers the not-yet-onboarded path so the toast
                is gated on `onboardingComplete`. */}
            <Route path="/agents" element={
              <AgentsPage
                agents={agents}
                sessions={sessions}
                config={config}
                theme={theme}
              />
            } />
            <Route path="/agents/new" element={<AgentCreatePage />} />
            <Route path="/agents/:id/edit" element={<AgentEditPage />} />
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
            <Route path="/recipes" element={
              <RecipesPage
                agents={agents}
                startNewSession={startNewSession}
                theme={theme}
              />
            } />
            <Route path="/sessions" element={<SessionsPage defaultSessionId={selectedId} />} />
            <Route path="/work-roots" element={<WorkRootsPage />} />
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
                tmuxInterrupt={tmuxInterrupt}
                startNewSession={startNewSession}
                setSessionAgent={setSessionAgent}
                isSessionSendable={isSessionSendable}
                rollbackOptimisticMessage={rollbackOptimisticMessage}
                getDraft={getDraft}
                setDraft={setDraft}
                agentActivities={agentActivities}
                theme={theme}
              />
            } />
            {/* User extension pages.
                Each page is wrapped in <RecipePageHost> so window.kb.call
                / window.kb.log are bound to the recipe before the page's
                first render. We assume the menu entry id matches the
                recipe id (this is the convention `recipe-applicator.ts`
                generates and the sample recipes follow). When they
                diverge the dispatcher returns HandlerNotDeclared, which
                is clearer than the previous "outside recipe page scope"
                warning. */}
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
                        {t('common.loading')}
                      </div>
                    }>
                      <RecipePageHost
                        appId={entry.id}
                        Page={LazyPage}
                        trustLevel={entry.trustLevel}
                      />
                    </Suspense>
                  }
                />
              )
            })}
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        </Layout>

        {/* Phase 1 prompt injection ② Claude Code recommended-settings
            startup warn (spec trust-prompt-relay v1.3 §10.5; handoff
            v1.1 §3.3). The toast is self-contained: it fetches
            /api/security/settings-check on mount, hides itself when
            suppressed by the 24h dismiss cooldown, and offers a
            dismiss action that POSTs to /api/security/dismiss.
            The `onboardingComplete` prop gates the toast off during
            the onboarding wizard so it does not double up with the
            inline StepSecurity surface (CodeX review attempt 1). */}
        <SecurityRecommendationsToast onboardingComplete={onboardingComplete === true} />


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

      {/* App removal modal (DEC-024 #3, spec §6.1).
          Opens when the NavMenu RemoveAppButton is clicked.
          On confirm, posts /api/apps/<appId>/request-removal and
          navigates to /agents/<agentId>?openLatestSession=1&awaitNewSession=1.
          The `awaitNewSession=1` flag avoids the RC-4-style race where
          a pre-existing finished session for the picked agent would
          otherwise be opened instead of the freshly-dispatched one. */}
      {appRemovalState && (
        <AppRemovalModal
          appId={appRemovalState.appId}
          displayName={appRemovalState.displayName}
          agents={agents}
          isSubmitting={appRemovalSubmitting}
          error={appRemovalError}
          theme={theme}
          onCancel={() => {
            if (appRemovalSubmitting) return
            setAppRemovalState(null)
            setAppRemovalError(null)
          }}
          onConfirm={async (agentId) => {
            if (!appRemovalState) return
            setAppRemovalError(null)
            setAppRemovalSubmitting(true)
            try {
              const res = await kbFetch(
                `/api/apps/${appRemovalState.appId}/request-removal`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ agentId }),
                },
              )
              if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as {
                  error?: string
                }
                throw new Error(data.error || 'Removal request failed')
              }
              setAppRemovalState(null)
              navigate(`/agents/${agentId}?openLatestSession=1&awaitNewSession=1`)
            } catch (err) {
              setAppRemovalError(
                err instanceof Error
                  ? err.message
                  : 'Removal request failed',
              )
            } finally {
              setAppRemovalSubmitting(false)
            }
          }}
        />
      )}

      {/* Recipe export modal (DEC-024 #5 / spec §F5).
          Opens when the AmbientSidebar's per-app actions popover
          chooses "Export recipe". */}
      {recipeExportState && (
        <RecipeExportModal
          appId={recipeExportState.appId}
          displayName={recipeExportState.displayName}
          onClose={() => setRecipeExportState(null)}
        />
      )}

      {/* Trust prompt relay modal (prepared above so it can also be
          mounted inside the onboarding flow). */}
      {trustPromptModal}
    </div>
  )
}
