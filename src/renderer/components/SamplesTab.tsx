/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sample apps tab — v0.2.1 bundled enable / disable surface.
 *
 * Replaces the legacy `RecipeSample.tsx` read-only listing with an
 * Enable button surface (judgement doc §4'.4). The bundled enable
 * path lives entirely outside the install flow (recipe-system v1.12
 * §10.9, structural separation §5) — clicking `Enable` POSTs
 * `/api/recipes/sample/:recipeId/enable`, which:
 *   1. copies bundled artifacts into `app/<appId>/`
 *   2. writes the `AppManifest` (`source.recipeSource: 'bundled'`)
 *   3. appends a `menu.ts` entry for `<appId>`
 *   4. broadcasts `recipe_apps_changed` so the Apps tab refetches
 *
 * Disable is NOT triggered from this tab — once enabled, the user
 * manages the app from the Apps tab's Actions menu (judgement doc
 * §4'.4 v2.0 UX rule: a single source of truth for disable so a
 * Sample apps tab race cannot fight an Apps tab disable). Enabled
 * cards render as read-only with a "Manage in Apps tab" link.
 *
 * Network silence after enable: no install-warning dialog, no
 * tmux-bridge agent spawn, no `/api/recipes/install` call. The
 * banner ("Coming in v0.3.0...") makes the v0.3.0 install path
 * explicit to the user.
 *
 * SSOT:
 *   - judgement doc §4'.4
 *   - http-api-contract.md v1.7.1 §6.3.8.B (enable endpoint wire)
 *   - recipe-system.md v1.12 §10.9
 *   - ws-event-contract.md v1.4 §7.6.3 (`recipe_apps_changed`)
 */
import { useCallback, useEffect, useState } from 'react'
import { getRecipeDescription, getRecipeName } from '../utils/recipe-display'
import { t } from '../i18n'
import { kbFetch } from '../lib/kbFetch'

/** Sample recipe info from the server. */
interface SampleRecipeInfo {
  id: string
  metadata: {
    name: string
    description: string
    version: string
    author?: string
    tags?: string[]
    i18n?: Record<string, { name?: string; description?: string }>
  }
  sourcePath: string
  sourceFormat: 'directory' | 'markdown'
  hash: string
  /** Legacy install flag, superseded by `enabled` from v0.2.1. */
  installed: boolean
  /** v0.2.1 enable/disable model — `true` when a coherent manifest exists. */
  enabled?: boolean
  /**
   * UI display alias for the persisted `manifest.source`:
   *   - `'bundled'` — fresh v0.2.1 bundled enable
   *   - `'sample (grandfather)'` — pre-v0.2.1 grandfather sample
   */
  source?: 'bundled' | 'sample (grandfather)'
  historyEntry?: {
    id: string
    appliedAt: string
    recipeId?: string
    menu?: string[]
  }
}

interface SamplesTabProps {
  /**
   * Monotonic counter from `useIPC()`. Refetch `/api/recipes/sample`
   * whenever this bumps (ws-event-contract v1.4 §7.6.3 — server
   * broadcasts `recipe_apps_changed` after a bundled enable / disable
   * transaction completes).
   */
  sampleRecipeVersion?: number
}

type LoadState = 'loading' | 'loaded' | 'error'

export function SamplesTab({ sampleRecipeVersion }: SamplesTabProps) {
  const [recipes, setRecipes] = useState<SampleRecipeInfo[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  // Per-recipe Enable button state. Keyed by recipe id so multiple
  // clicks in flight (or one stuck behind a slow disk) do not block
  // each other. The server's idempotent retry semantics
  // (`isEnabledAndManifestCoherent`) make a stuck button safe to
  // re-click after a manual reload.
  const [enablingIds, setEnablingIds] = useState<Set<string>>(new Set())
  // Per-recipe enable error map, keyed by recipe id (parallel to
  // `enablingIds`). A single global error slot would let a later
  // failure overwrite an earlier one and let a single dismiss clear
  // every card's error — both of which contradict the per-recipe
  // state model. The Map shape gives each card its own slot and
  // makes dismiss / retry affect only the targeted recipe.
  const [enableErrors, setEnableErrors] = useState<Map<string, string>>(
    () => new Map(),
  )

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await kbFetch('/api/recipes/sample')
      if (!res.ok) {
        throw new Error(`Failed to fetch sample recipes: ${res.status}`)
      }
      const data = (await res.json()) as SampleRecipeInfo[]
      setRecipes(data)
      setState('loaded')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
      setState('error')
    }
  }, [])

  useEffect(() => {
    fetchRecipes()
  }, [fetchRecipes, sampleRecipeVersion])

  const isEnabled = (r: SampleRecipeInfo): boolean =>
    r.enabled ?? r.installed

  const dismissEnableError = useCallback((recipeId: string) => {
    setEnableErrors((prev) => {
      if (!prev.has(recipeId)) return prev
      const next = new Map(prev)
      next.delete(recipeId)
      return next
    })
  }, [])

  const handleEnable = useCallback(
    async (recipeId: string) => {
      // Clear only this card's stale error before retrying — peers
      // keep theirs visible until their owners dismiss them.
      setEnableErrors((prev) => {
        if (!prev.has(recipeId)) return prev
        const next = new Map(prev)
        next.delete(recipeId)
        return next
      })
      setEnablingIds((prev) => {
        const next = new Set(prev)
        next.add(recipeId)
        return next
      })
      try {
        const res = await kbFetch(
          `/api/recipes/sample/${encodeURIComponent(recipeId)}/enable`,
          { method: 'POST' },
        )
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(data.error ?? `Enable failed: ${res.status}`)
        }
        // Refetch immediately on 2xx so the card moves out of the
        // pre-enable state without waiting for the asynchronous
        // `recipe_apps_changed` ws broadcast. The broadcast is kept
        // as the secondary reconciliation path: a disconnected /
        // delayed / dropped socket would otherwise leave the card
        // stale and tempt the user to retry an already-successful
        // enable. Concurrent fetches with the ws-driven refetch are
        // safe because `fetchRecipes` overwrites the full list
        // (`setRecipes(data)`) rather than merging incrementally.
        await fetchRecipes()
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Enable failed'
        setEnableErrors((prev) => {
          const next = new Map(prev)
          next.set(recipeId, message)
          return next
        })
      } finally {
        setEnablingIds((prev) => {
          const next = new Set(prev)
          next.delete(recipeId)
          return next
        })
      }
    },
    [fetchRecipes],
  )

  // v0.2.x announcement banner — recipe install is on hold until
  // v0.3.0 brings the KovitoHub signed publisher model. Rendered
  // outside the state branches below so the explanation stays
  // visible on loading / error / empty / loaded.
  const banner = (
    <div
      data-testid="samples-tab-coming-soon-banner"
      className="px-3 py-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-secondary)]"
    >
      {t('samplesTab.info.comingSoon')}
    </div>
  )

  if (state === 'loading') {
    return (
      <div className="space-y-6">
        {banner}
        <div className="flex items-center justify-center py-8">
          <div className="text-[var(--text-dim)] text-sm">
            {t('recipe.sample.status.loading')}
          </div>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="space-y-6">
        {banner}
        <div className="space-y-3">
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {error}
          </div>
          <button
            onClick={() => {
              setState('loading')
              setError(null)
              fetchRecipes()
            }}
            className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"
          >
            {t('recipe.sample.button.reload')}
          </button>
        </div>
      </div>
    )
  }

  if (recipes.length === 0) {
    return (
      <div className="space-y-6">
        {banner}
        <div className="py-8 text-center">
          <p className="text-sm text-[var(--text-dim)]">
            {t('recipe.sample.empty')}
          </p>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            {t('recipe.sample.emptyHint')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {banner}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        data-testid="samples-tab-grid"
      >
        {recipes.map((recipe) => (
          <SampleCard
            key={recipe.id}
            recipe={recipe}
            enabled={isEnabled(recipe)}
            isEnabling={enablingIds.has(recipe.id)}
            error={enableErrors.get(recipe.id) ?? null}
            onEnable={() => handleEnable(recipe.id)}
            onDismissError={() => dismissEnableError(recipe.id)}
          />
        ))}
      </div>
    </div>
  )
}

interface SampleCardProps {
  recipe: SampleRecipeInfo
  enabled: boolean
  isEnabling: boolean
  error: string | null
  onEnable: () => void
  onDismissError: () => void
}

function SampleCard({
  recipe,
  enabled,
  isEnabling,
  error,
  onEnable,
  onDismissError,
}: SampleCardProps) {
  return (
    <div
      data-testid={`samples-tab-card-${recipe.id}`}
      data-enabled={enabled ? 'true' : 'false'}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 flex flex-col gap-3"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-bold text-[var(--text-primary)] truncate">
            {getRecipeName(recipe.metadata)}
          </h4>
          <span className="text-xs text-[var(--text-dim)] shrink-0">
            v{recipe.metadata.version}
          </span>
          {enabled && (
            <span
              data-testid={`samples-tab-card-${recipe.id}-enabled-badge`}
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 shrink-0"
            >
              {t('samplesTab.label.enabled')}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-3">
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
      </div>

      {error && (
        <div
          data-testid={`samples-tab-card-${recipe.id}-error`}
          role="alert"
          className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300 flex items-start justify-between gap-2"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="shrink-0 text-red-300 hover:text-red-200"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {enabled ? (
          // v2.0 UX rule (§4'.4): disable trigger lives on the Apps
          // tab Actions menu. Here we render an informational hint
          // so users discover the move without spec-reading.
          <span
            data-testid={`samples-tab-card-${recipe.id}-manage-hint`}
            className="text-[11px] text-[var(--text-dim)]"
          >
            {t('samplesTab.label.openInAppsTab')}
          </span>
        ) : (
          <button
            type="button"
            data-testid={`samples-tab-card-${recipe.id}-enable-button`}
            onClick={onEnable}
            disabled={isEnabling}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEnabling
              ? t('recipe.sample.status.loading')
              : t('samplesTab.button.enable')}
          </button>
        )}
      </div>
    </div>
  )
}
