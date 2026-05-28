/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Apps screen — v0.2.1 3-tab restructure of the legacy "App recipes"
 * page.
 *
 * Tabs (judgement doc §4'.2 wireframe):
 *   1. Apps         — unified list of installed apps, four sources
 *                     (self-made / bundled / import / url) plus the
 *                     scanner-derived `'sample'` grandfather badge.
 *                     Default tab.
 *   2. Sample apps  — bundled-recipe enable / disable surface.
 *   3. Recipes      — v0.3.0 KovitoHub preview mock-up (disabled).
 *
 * Replaces `RecipesPage.tsx` at the `/recipes` route (the key was
 * preserved for backward compatibility; the label was rebranded in
 * commit `e70a4f9`).
 *
 * SSOT:
 *   - judgement doc §4'.2 / §4'.3 / §4'.4 / §4'.5
 *   - app-directory-extension.md v1.6 §6.7 / §6.8 (display label
 *     resolution + persisted source enum)
 *   - http-api-contract.md v1.7.1 §6.3.8.B / §6.3.9.A
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import type {
  AgentInfo,
  NewSessionResponse,
  SessionOrigin,
} from '../types'
import type { AppMenuEntry } from '../types/app-types'
import { AppsTab } from './AppsTab'
import { SamplesTab } from './SamplesTab'
import { RecipesTab } from './RecipesTab'
import {
  AppCreateModal,
  type AppCreateSubmission,
} from './AppCreateModal'
import { buildAppCreationPrompt } from '../../shared/app-creation-prompt'

/** Top-level tab discriminator. `'apps'` is the default landing tab. */
export type AppsScreenTabId = 'apps' | 'samples' | 'recipes'

interface AppsScreenProps {
  /**
   * User menu entries from `loadUserMenuEntries()` (already AppManifest-
   * augmented by the v0.2.1 wire). The Apps tab reads from this list
   * directly; SamplesTab refetches `/api/recipes/sample` independently.
   */
  userMenuEntries: AppMenuEntry[]
  /**
   * Server-supplied menu-order snapshot (from the
   * `X-Apps-Menu-Snapshot` response header of
   * `GET /api/app/menu-entries`). Forwarded into AppsTab so the very
   * first reorder seeds `snapshotVersionRef` and engages the
   * `MenuOrderSnapshotDrift` (HTTP 409) protection on first write.
   * `null` when the server omitted the header (legacy fallback path).
   */
  menuOrderSnapshot: string | null
  agents: AgentInfo[]
  startNewSession: (
    message: string,
    agentId?: string,
    options?: { origin?: SessionOrigin },
  ) => Promise<NewSessionResponse>
  theme?: 'dark' | 'light'
  /**
   * Monotonic counter from `useIPC()` that bumps whenever the server
   * broadcasts `recipe_apps_changed`. Forwarded to SamplesTab so it
   * refetches `/api/recipes/sample` after a bundled enable / disable
   * transaction completes (ws-event-contract v1.4 §7.6.3).
   */
  sampleRecipeVersion?: number
  /** App removal entry point (DEC-024 #3 / §F4). */
  onRequestAppRemoval: (request: {
    appId: string
    displayName: string
  }) => void
  /** Recipe export entry point (DEC-024 #5 / §F5). */
  onRequestRecipeExport: (request: {
    appId: string
    displayName: string
  }) => void
}

/**
 * Top-level Apps screen — orchestrates the three tabs and the shared
 * "+ Create self-made app" modal.
 */
export function AppsScreen({
  userMenuEntries,
  menuOrderSnapshot,
  agents,
  startNewSession,
  theme = 'dark',
  sampleRecipeVersion,
  onRequestAppRemoval,
  onRequestRecipeExport,
}: AppsScreenProps) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<AppsScreenTabId>('apps')
  const [showCreateAppModal, setShowCreateAppModal] = useState(false)
  const [noAgentsError, setNoAgentsError] = useState<string | null>(null)

  // "+ Add app" on the Apps tab jumps to the Sample apps tab (BS-L8 /
  // network-silence: it does NOT call `/api/recipes/install`, which is
  // 410 Gone in v0.2.x). Wrapping in a callback so AppsTab can stay a
  // pure presentational component.
  const handleJumpToSamples = useCallback(() => {
    setActiveTab('samples')
  }, [])

  const handleOpenCreateApp = useCallback(() => {
    if (agents.length === 0) {
      // Spec §4.4 / §6.3: agents-empty case shows an inline error
      // banner instead of opening the modal so the user sees the
      // missing prerequisite immediately.
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
      // to /sessions/{id} from this response. Hand the navigation
      // off to AgentDetailPage's `?openLatestSession=1` mechanism,
      // which already handles the watcher race for the onboarding
      // hand-off and redirects to the freshly-created session as
      // soon as it appears. `&awaitNewSession=1` switches
      // AgentDetailPage to baseline-the-current-sessions mode so a
      // pre-existing finished session for the picked agent does not
      // win the race (RC-4).
      await startNewSession(prompt, submission.agentId, {
        origin: 'recipe-create-app',
      })
      setShowCreateAppModal(false)
      navigate(
        `/agents/${submission.agentId}?openLatestSession=1&awaitNewSession=1`,
      )
    },
    [startNewSession, navigate],
  )

  const tabs: Array<{ id: AppsScreenTabId; label: string }> = [
    { id: 'apps', label: t('appsScreen.tab.apps') },
    { id: 'samples', label: t('appsScreen.tab.samples') },
    { id: 'recipes', label: t('appsScreen.tab.recipes') },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header — single "Apps" title (no per-tab title; the tab bar
          itself is the discriminator). */}
      <div className="px-6 pt-4 pb-0">
        <div className="flex items-center justify-between mb-3 gap-3">
          <h1 className="text-lg font-bold text-[var(--text-primary)]">
            {t('recipe.title')}
          </h1>
        </div>

        {/* Inline error: agents-empty when "+ Create self-made app"
            was attempted with no agents defined. Cleared on the next
            successful open. */}
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
        <div
          role="tablist"
          aria-label={t('recipe.title')}
          className="flex gap-1 border-b border-[var(--border)]"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`apps-screen-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
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
      <div
        className="flex-1 overflow-y-auto px-6 py-4"
        data-testid={`apps-screen-panel-${activeTab}`}
      >
        {activeTab === 'apps' && (
          <AppsTab
            userMenuEntries={userMenuEntries}
            menuOrderSnapshot={menuOrderSnapshot}
            onJumpToSamples={handleJumpToSamples}
            onCreateSelfMade={handleOpenCreateApp}
            onRequestAppRemoval={onRequestAppRemoval}
            onRequestRecipeExport={onRequestRecipeExport}
          />
        )}
        {activeTab === 'samples' && (
          <SamplesTab sampleRecipeVersion={sampleRecipeVersion} />
        )}
        {activeTab === 'recipes' && <RecipesTab />}
      </div>

      {/* Create-self-made-app modal (reused from the legacy
          RecipesPage flow; the UX entry point moved to the Apps
          tab's "+ Create self-made app" button per judgement doc
          §4'.3). */}
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
