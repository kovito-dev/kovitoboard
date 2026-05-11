/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipes page — tab container for Sample and History.
 *
 * The legacy "Export" tab was retired earlier so recipe export now
 * runs from the AmbientSidebar's per-app actions popover. The
 * "Import" tab and `RecipeImport.tsx` were retired in v0.2.x when
 * recipe install was temporarily disabled (recipe-system.md §10.6
 * / http-api-contract.md §4.3.8.A). The v0.3.0 release will bring
 * back recipe install via the KovitoHub signed publisher model.
 *
 * Header also hosts the "Create new app" entry point. Clicking the
 * button opens an AppCreateModal that captures purpose / optional
 * details / target agent, then starts a new agent session and
 * navigates to it.
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import type { AgentInfo, NewSessionResponse, SessionOrigin } from '../types'
import { RecipeSample } from '../components/RecipeSample'
import { RecipeHistory } from '../components/RecipeHistory'
import { AppCreateModal, type AppCreateSubmission } from '../components/AppCreateModal'
import { buildAppCreationPrompt } from '../../shared/app-creation-prompt'

type TabId = 'sample' | 'history'

// Built at module evaluation. See i18n/index.ts `readPersistedLocale()`
// for how the locale used here is restored from localStorage before
// this constant is computed (OSS fallback: en).
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'sample', label: t('recipe.tab.sample') },
  { id: 'history', label: t('recipe.tab.history') },
]

interface RecipesPageProps {
  agents: AgentInfo[]
  startNewSession: (
    message: string,
    agentId?: string,
    options?: { origin?: SessionOrigin },
  ) => Promise<NewSessionResponse>
  theme?: 'dark' | 'light'
}

export function RecipesPage({ agents, startNewSession, theme = 'dark' }: RecipesPageProps) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabId>('sample')
  const [showCreateAppModal, setShowCreateAppModal] = useState(false)
  const [noAgentsError, setNoAgentsError] = useState<string | null>(null)

  const handleOpenCreateApp = useCallback(() => {
    if (agents.length === 0) {
      // Spec §4.4 / §6.3: agents-empty case shows an error (toast-style
      // here: a transient inline banner) and does not open the modal.
      setNoAgentsError(t('appCreate.error.noAgents'))
      return
    }
    setNoAgentsError(null)
    setShowCreateAppModal(true)
  }, [agents.length])

  const handleCreate = useCallback(
    async (submission: AppCreateSubmission) => {
      const prompt = buildAppCreationPrompt({
        purpose: submission.purpose,
        input: submission.input,
        output: submission.output,
        frequency: submission.frequency,
      })
      // POST /api/sessions/new is asynchronous: Claude writes the
      // session JSONL after the call returns, so we cannot navigate
      // to /sessions/{id} from this response (NewSessionResponse only
      // carries `processId` / `windowName`). Instead we hand the
      // navigation off to AgentDetailPage's `?openLatestSession=1`
      // mechanism, which already handles the watcher race for the
      // onboarding hand-off and redirects to the freshly-created
      // session as soon as it appears. `&awaitNewSession=1` switches
      // AgentDetailPage to baseline-the-current-sessions mode so a
      // pre-existing finished session for the picked agent does not
      // win the race (RC-4).
      await startNewSession(prompt, submission.agentId, {
        origin: 'recipe-create-app',
      })
      setShowCreateAppModal(false)
      navigate(`/agents/${submission.agentId}?openLatestSession=1&awaitNewSession=1`)
    },
    [startNewSession, navigate],
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-4 pb-0">
        <div className="flex items-center justify-between mb-3 gap-3">
          <h1 className="text-lg font-bold text-[var(--text-primary)]">
            {t('recipe.title')}
          </h1>
          <button
            type="button"
            data-testid="recipe-create-app-button"
            onClick={handleOpenCreateApp}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 transition-opacity shrink-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('recipe.button.createApp')}
          </button>
        </div>

        {/* Inline notice when an open attempt failed because no agents
            are defined. Cleared automatically the next time we open
            successfully. */}
        {noAgentsError && (
          <div
            data-testid="recipe-create-app-no-agents-error"
            role="alert"
            className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 flex items-start justify-between gap-3"
          >
            <span className="flex-1">{noAgentsError}</span>
            <button
              type="button"
              onClick={() => setNoAgentsError(null)}
              className="shrink-0 text-red-300 hover:text-red-200"
              aria-label="dismiss"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-[var(--border)]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === tab.id
                  ? 'text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-text)]" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {activeTab === 'sample' && <RecipeSample agents={agents} theme={theme} />}
        {activeTab === 'history' && <RecipeHistory />}
      </div>

      {/* Create-new-app modal */}
      <AppCreateModal
        isOpen={showCreateAppModal}
        agents={agents}
        theme={theme}
        onCancel={() => setShowCreateAppModal(false)}
        onCreate={handleCreate}
      />
    </div>
  )
}
