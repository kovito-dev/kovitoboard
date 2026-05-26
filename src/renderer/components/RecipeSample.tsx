/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sample recipes — read-only listing.
 *
 * Install / reinstall flows are temporarily disabled in v0.2.x while
 * the prompt-injection defence is being finalised and the KovitoHub
 * signed publisher model lands in v0.3.0 (recipe-system.md §10.6 /
 * http-api-contract.md §4.3.8.A). The scanner still parses sample
 * recipes so existing install-grandfather cards keep showing the
 * installed badge + lineage, but `/api/recipes/install` returns 410
 * Gone and the install buttons are removed from this surface.
 *
 * App removal continues to work through the NavMenu's RemoveAppButton
 * while viewing `/ext/<appId>`.
 */
import { useState, useEffect, useCallback } from 'react'
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
    /** Optional locale-specific overrides; see RecipeMetadata.i18n. */
    i18n?: Record<string, { name?: string; description?: string }>
  }
  sourcePath: string
  sourceFormat: 'directory' | 'markdown'
  hash: string
  /**
   * Legacy install flag. `enabled` (below) supersedes this from v0.2.1
   * onward — kept on the wire for backward compatibility with older
   * clients that have not refetched the schema yet.
   */
  installed: boolean
  /**
   * v0.2.1 enable/disable model. `true` when a coherent bundled or
   * grandfather-sample manifest exists for the recipe id (spec
   * recipe-system v1.10 §10.9.5 BS-L2'). Drives the badge + section
   * routing.
   */
  enabled?: boolean
  /**
   * UI display alias for the persisted `manifest.source`:
   *   - `'bundled'` — fresh v0.2.1 bundled enable
   *   - `'sample (grandfather)'` — v0.1.x / v0.2.0 grandfather sample
   * Omitted when `enabled` is false (no manifest to read from).
   */
  source?: 'bundled' | 'sample (grandfather)'
  historyEntry?: {
    id: string
    appliedAt: string
    /** Recipe author's id; legacy entries without it fall back to
     *  `menu[0]` via the server's findHistoryMatch helper. */
    recipeId?: string
    menu?: string[]
  }
}

interface RecipeSampleProps {
  /**
   * Monotonic counter from `useIPC()`; refetch `/api/recipes/sample`
   * whenever this bumps (BL-2026-176 (b), ws-event-contract v1.4
   * §7.6.3, server broadcasts `recipe_apps_changed` after a bundled
   * enable / disable transaction). Optional so existing call sites
   * without the prop still work; the initial mount fetch covers them.
   */
  sampleRecipeVersion?: number
}

type LoadState = 'loading' | 'loaded' | 'error'

export function RecipeSample({ sampleRecipeVersion }: RecipeSampleProps = {}) {
  const [recipes, setRecipes] = useState<SampleRecipeInfo[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

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
    // Initial mount + every `recipe_apps_changed` bump. The
    // `sampleRecipeVersion` dependency makes the renderer state
    // converge after a bundled enable / disable transaction without
    // a manual page reload.
    fetchRecipes()
  }, [fetchRecipes, sampleRecipeVersion])

  // v0.2.x disable notice — recipe install is temporarily off until
  // the KovitoHub signed publisher model ships in v0.3.0. Rendered
  // outside the state-specific branches below so the explanation is
  // visible on loading / error / empty / loaded paths alike.
  const disableNotice = (
    <div
      data-testid="recipe-install-disabled-notice"
      className="px-3 py-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-secondary)]"
    >
      {t('recipe.install.comingSoon')}
    </div>
  )

  if (state === 'loading') {
    return (
      <div className="space-y-6">
        {disableNotice}
        <div className="flex items-center justify-center py-8">
          <div className="text-[var(--text-dim)] text-sm">{t('recipe.sample.status.loading')}</div>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="space-y-6">
        {disableNotice}
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
        {disableNotice}
        <div className="py-8 text-center">
          <p className="text-sm text-[var(--text-dim)]">{t('recipe.sample.empty')}</p>
          <p className="text-xs text-[var(--text-dim)] mt-1">{t('recipe.sample.emptyHint')}</p>
        </div>
      </div>
    )
  }

  // Prefer the v0.2.1 `enabled` flag when present; fall back to the
  // legacy `installed` flag so older server builds (pre-Phase 1 MVP)
  // still render correctly. The two never disagree at runtime once
  // the server has been refreshed against current manifests, but the
  // fallback keeps the renderer resilient to a partial deploy.
  const isEnabled = (r: SampleRecipeInfo): boolean =>
    r.enabled ?? r.installed
  const available = recipes.filter((r) => !isEnabled(r))
  const installed = recipes.filter((r) => isEnabled(r))

  return (
    <div className="space-y-6">
      {disableNotice}

      {/* Available section — read-only listing. Install buttons are
          removed; the sample metadata is still rendered so users can
          browse what will arrive with the v0.3.0 KovitoHub release. */}
      {available.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
            {t('recipe.sample.section.available', { count: available.length })}
          </h3>
          <div className="space-y-2">
            {available.map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))}
          </div>
        </section>
      )}

      {/* Installed section — grandfather listing. Reinstall buttons
          are removed alongside the install path; existing installs
          keep working through the dispatcher + removal flow. */}
      {installed.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
            {t('recipe.sample.section.installed', { count: installed.length })}
          </h3>
          <div className="space-y-2">
            {installed.map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Individual recipe card — read-only in v0.2.x. */
function RecipeCard({ recipe }: { recipe: SampleRecipeInfo }) {
  // Resolve the enable state with backward-compat fallback (mirrors
  // the top-level isEnabled helper). A `'sample (grandfather)'`
  // source surfaces as a green grandfather badge; a `'bundled'`
  // source surfaces as the sky-blue bundled badge once Phase 3 lands
  // the dedicated UI. Until then the legacy green "installed" badge
  // covers both paths so v0.2.1 ships with parity.
  const enabled = recipe.enabled ?? recipe.installed
  return (
    <div
      data-testid={`recipe-card-${recipe.id}`}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 flex items-start justify-between gap-4"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-bold text-[var(--text-primary)] truncate">
            {getRecipeName(recipe.metadata)}
          </h4>
          <span className="text-xs text-[var(--text-dim)] shrink-0">v{recipe.metadata.version}</span>
          {enabled && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 shrink-0">
              {t('recipe.sample.badge.installed')}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
          {getRecipeDescription(recipe.metadata)}
        </p>
        {recipe.metadata.author && (
          <p className="text-[10px] text-[var(--text-dim)] mt-1">Author: {recipe.metadata.author}</p>
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
        {enabled && recipe.historyEntry && (
          <p className="text-[10px] text-[var(--text-dim)] mt-1">
            {t('recipe.sample.installedDate')}: {new Date(recipe.historyEntry.appliedAt).toLocaleDateString('ja-JP')}
          </p>
        )}
      </div>
    </div>
  )
}
