/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sample recipes — shows pre-installed recipes split into Available
 * / Installed sections.
 *
 * v2.0 install flow (DEC-024 #2 / spec §3.1):
 *   parse → (warning if non-pure) → agent picker → POST /install
 *   → navigate to `/agents/<agentId>?openLatestSession=1`
 *
 * v2.0 reinstall flow (DEC-024 #4 / spec §3 / §4):
 *   "Installed" cards expose a "Reinstall" button that runs the
 *   same install flow. The server-side `buildRecipePrompt` injects
 *   a reinstall-detection section listing every existing app from
 *   the same `recipeId`, and the agent walks the user through
 *   picking a fresh appId (collision-avoidance API) or aborting if
 *   the user actually wanted to overwrite (which v0.1.0 does not
 *   support — they must remove the app first via the NavMenu's
 *   Remove App button, DEC-024 #3).
 *
 * Uninstall is no longer reachable from this surface (DEC-024 D-6).
 * App deletion happens through the NavMenu's RemoveAppButton while
 * viewing `/ext/<appId>`.
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ParsedRecipe, InspectionResult } from '../../shared/recipe-types'
import type { AgentInfo } from '../types'
import { RecipeInstallWarningDialog } from './RecipeInstallWarningDialog'
import { RecipeInstallAgentPickerModal } from './RecipeInstallAgentPickerModal'
import { getRecipeDescription, getRecipeName } from '../utils/recipe-display'
import { t } from '../i18n'

/** Sample recipe info from the server. */
interface SampleRecipeInfo {
  id: string
  metadata: {
    name: string
    description: string
    version: string
    author?: string
    tags?: string[]
    /** Optional locale-specific overrides; see RecipeMetadata.i18n. */
    i18n?: Record<string, { name?: string; description?: string }>
  }
  sourcePath: string
  sourceFormat: 'directory' | 'markdown'
  hash: string
  installed: boolean
  historyEntry?: {
    id: string
    appliedAt: string
    /** Recipe author's id; legacy entries without it fall back to
     *  `menu[0]` via the server's findHistoryMatch helper. */
    recipeId?: string
    menu?: string[]
  }
}

type LoadState = 'loading' | 'loaded' | 'error'

interface PendingInstall {
  recipe: SampleRecipeInfo
  parsed: ParsedRecipe
  inspection: InspectionResult
  /** True when this dialog was launched via the "Reinstall" button
   *  (vs the first-time "Install" button). The two paths share the
   *  same modals + API; this flag drives status text only. */
  isReinstall: boolean
}

interface RecipeSampleProps {
  agents: AgentInfo[]
  theme?: 'dark' | 'light'
}

export function RecipeSample({ agents, theme = 'dark' }: RecipeSampleProps) {
  const navigate = useNavigate()
  const [recipes, setRecipes] = useState<SampleRecipeInfo[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  // Whether the inflight install is a reinstall (status text differs).
  const [reinstallingId, setReinstallingId] = useState<string | null>(null)
  // Name of the most recently installed recipe (drives the post-install
  // notification banner). With the API + ws-driven menu refresh path
  // the navigation updates automatically — the banner is purely a
  // confirmation that the install succeeded; users no longer need to
  // reload the page or restart the server.
  const [justInstalledName, setJustInstalledName] = useState<string | null>(null)

  // 2-stage modal: (warning | picker) when an install is queued.
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)
  const [installStage, setInstallStage] = useState<'warning' | 'picker' | null>(null)
  const [installPostError, setInstallPostError] = useState<string | null>(null)

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await fetch('/api/recipes/sample')
      if (!res.ok) {
        throw new Error(`Failed to fetch sample recipes: ${res.status}`)
      }
      const data = await res.json() as SampleRecipeInfo[]
      setRecipes(data)
      setState('loaded')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
      setState('error')
    }
  }, [])

  useEffect(() => {
    fetchRecipes()
  }, [fetchRecipes])

  /**
   * Start the install / reinstall flow.
   * Parse the recipe and decide which modal to surface first:
   *   - Non-pure-declarative recipe → warning dialog, then picker.
   *   - Pure-declarative recipe       → picker directly.
   */
  const startInstallFlow = useCallback(
    async (recipe: SampleRecipeInfo, isReinstall: boolean) => {
      setInstallPostError(null)
      if (isReinstall) {
        setReinstallingId(recipe.id)
      } else {
        setInstallingId(recipe.id)
      }
      try {
        const parseRes = await fetch('/api/recipes/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: recipe.sourcePath }),
        })
        if (!parseRes.ok) {
          const data = await parseRes.json()
          throw new Error(data.error || 'Parse failed')
        }
        const { recipe: parsed, inspection } = await parseRes.json() as {
          recipe: ParsedRecipe
          inspection: InspectionResult
        }

        if (inspection.verdict === 'blocked') {
          throw new Error('This recipe was blocked by the security check')
        }

        setPendingInstall({ recipe, parsed, inspection, isReinstall })
        setInstallStage(inspection.pureDeclarative ? 'picker' : 'warning')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Install failed')
      } finally {
        setInstallingId(null)
        setReinstallingId(null)
      }
    },
    [],
  )

  const handleInstall = useCallback(
    (recipe: SampleRecipeInfo) => startInstallFlow(recipe, false),
    [startInstallFlow],
  )
  const handleReinstall = useCallback(
    (recipe: SampleRecipeInfo) => startInstallFlow(recipe, true),
    [startInstallFlow],
  )

  /** Warning dialog → continue. Move to the agent-picker stage. */
  const handleWarningContinue = useCallback(() => {
    setInstallStage('picker')
  }, [])

  /** Warning / picker → cancel. Drop the pending install. */
  const handleCancel = useCallback(() => {
    setPendingInstall(null)
    setInstallStage(null)
    setInstallPostError(null)
  }, [])

  /**
   * Agent picker → confirm. POST `/api/recipes/install` and navigate
   * to `/agents/<agentId>?openLatestSession=1&awaitNewSession=1`. The
   * `awaitNewSession=1` flag makes AgentDetailPage wait for a fresh
   * session to appear (rather than opening the latest pre-existing
   * one) — the picked agent typically has prior finished sessions
   * that would otherwise win the race (RC-4). The same path services
   * first-time installs and reinstalls; the server-side
   * `buildRecipePrompt` adds the reinstall-detection section when an
   * app with the same recipeId already exists.
   */
  const handlePickerConfirm = useCallback(
    async (agentId: string) => {
      if (!pendingInstall) return
      const { parsed, inspection, recipe, isReinstall } = pendingInstall
      setInstallPostError(null)
      if (isReinstall) {
        setReinstallingId(recipe.id)
      } else {
        setInstallingId(recipe.id)
      }
      try {
        const res = await fetch('/api/recipes/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipe: parsed,
            inspection,
            agentId,
            recipeSource: 'sample',
          }),
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error || 'Install failed')
        }
        setJustInstalledName(parsed.metadata.name)
        setPendingInstall(null)
        setInstallStage(null)
        navigate(`/agents/${agentId}?openLatestSession=1&awaitNewSession=1`)
      } catch (err) {
        setInstallPostError(err instanceof Error ? err.message : 'Install failed')
      } finally {
        setInstallingId(null)
        setReinstallingId(null)
      }
    },
    [pendingInstall, navigate],
  )

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-[var(--text-dim)] text-sm">{t('recipe.sample.status.loading')}</div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="space-y-3">
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {error}
        </div>
        <button
          onClick={() => { setState('loading'); setError(null); fetchRecipes() }}
          className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"
        >
          {t('recipe.sample.button.reload')}
        </button>
      </div>
    )
  }

  if (recipes.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--text-dim)]">
          {t('recipe.sample.empty')}
        </p>
        <p className="text-xs text-[var(--text-dim)] mt-1">
          {t('recipe.sample.emptyHint')}
        </p>
      </div>
    )
  }

  const available = recipes.filter((r) => !r.installed)
  const installed = recipes.filter((r) => r.installed)

  return (
    <div className="space-y-6">
      {/* Warning dialog: shown for non-pure-declarative recipes
          before the agent picker. Same path for install / reinstall. */}
      {pendingInstall && installStage === 'warning' && (
        <RecipeInstallWarningDialog
          recipeName={pendingInstall.parsed.metadata.name}
          detectedPatterns={pendingInstall.inspection.detectedNonDeclarativePatterns}
          onContinue={handleWarningContinue}
          onCancel={handleCancel}
        />
      )}

      {/* Agent picker: chosen agent receives the install handover
          prompt and walks the user through the 7 steps. The same
          path services reinstalls — the prompt's reinstall-detection
          section asks the user about overwrite vs new-appId. */}
      {pendingInstall && installStage === 'picker' && (
        <RecipeInstallAgentPickerModal
          recipeName={pendingInstall.parsed.metadata.name}
          agents={agents}
          isInstalling={
            installingId === pendingInstall.recipe.id ||
            reinstallingId === pendingInstall.recipe.id
          }
          error={installPostError}
          theme={theme}
          onCancel={handleCancel}
          onConfirm={handlePickerConfirm}
        />
      )}

      {/* Post-install notification banner.
          The renderer fetches `/api/app/menu-entries` on first load and
          re-fetches whenever the server broadcasts `app_menu_changed`
          (chokidar -> ws). A freshly-installed recipe's menu entry
          therefore appears in the side nav automatically; the banner
          is just a confirmation cue. */}
      {justInstalledName && (
        <div
          data-testid="recipe-sample-reload-banner"
          className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-[var(--text-secondary)] flex items-center justify-between gap-3"
        >
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-green-400">
              {t('recipe.sample.justInstalled.title')}: {justInstalledName}
            </div>
            <div className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t('recipe.sample.justInstalled.body')}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setJustInstalledName(null)}
              className="text-[var(--text-dim)] hover:text-[var(--text-secondary)] text-sm"
              aria-label={t('recipe.sample.justInstalled.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-300 ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Available section */}
      {available.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
            {t('recipe.sample.section.available', { count: available.length })}
          </h3>
          <div className="space-y-2">
            {available.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                isInstalling={installingId === recipe.id}
                onInstall={() => handleInstall(recipe)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Installed section */}
      {installed.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
            {t('recipe.sample.section.installed', { count: installed.length })}
          </h3>
          <div className="space-y-2">
            {installed.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                isInstalling={false}
                isReinstalling={reinstallingId === recipe.id}
                onReinstall={() => handleReinstall(recipe)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Individual recipe card. */
function RecipeCard({
  recipe,
  isInstalling,
  onInstall,
  isReinstalling = false,
  onReinstall,
}: {
  recipe: SampleRecipeInfo
  isInstalling: boolean
  onInstall?: () => void
  /** Disables the reinstall button while a request is in flight. */
  isReinstalling?: boolean
  /** When provided on an installed recipe, renders a "Reinstall" button. */
  onReinstall?: () => void
}) {
  return (
    <div data-testid={`recipe-card-${recipe.id}`} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-bold text-[var(--text-primary)] truncate">
            {getRecipeName(recipe.metadata)}
          </h4>
          <span className="text-xs text-[var(--text-dim)] shrink-0">
            v{recipe.metadata.version}
          </span>
          {recipe.installed && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 shrink-0">
              {t('recipe.sample.badge.installed')}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
          {getRecipeDescription(recipe.metadata)}
        </p>
        {recipe.metadata.author && (
          <p className="text-[10px] text-[var(--text-dim)] mt-1">
            Author: {recipe.metadata.author}
          </p>
        )}
        {recipe.metadata.tags && recipe.metadata.tags.length > 0 && (
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {recipe.metadata.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-elevated)] text-[var(--text-dim)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {recipe.installed && recipe.historyEntry && (
          <p className="text-[10px] text-[var(--text-dim)] mt-1">
            {t('recipe.sample.installedDate')}: {new Date(recipe.historyEntry.appliedAt).toLocaleDateString('ja-JP')}
          </p>
        )}
      </div>

      {/* Action button */}
      <div className="shrink-0">
        {!recipe.installed && onInstall && (
          <button
            data-testid={`recipe-install-button-${recipe.id}`}
            onClick={onInstall}
            disabled={isInstalling}
            className="px-3 py-1.5 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-xs font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
          >
            {isInstalling ? t('recipe.sample.status.installing') : t('recipe.sample.button.install')}
          </button>
        )}
        {recipe.installed && onReinstall && (
          <button
            data-testid={`recipe-reinstall-button-${recipe.id}`}
            onClick={onReinstall}
            disabled={isReinstalling}
            className="px-3 py-1.5 border border-[var(--accent-border)] text-[var(--accent-text)] rounded-lg text-xs font-medium hover:bg-[var(--accent-bg)]/10 disabled:opacity-40 transition-colors"
          >
            {isReinstalling
              ? t('recipe.sample.status.reinstalling')
              : t('recipe.sample.button.reinstall')}
          </button>
        )}
      </div>
    </div>
  )
}
