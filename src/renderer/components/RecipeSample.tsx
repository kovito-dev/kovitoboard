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
import type { AgentInfo } from '../types'
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

interface RecipeSampleProps {
  /** Kept for API compatibility with the surrounding RecipesPage. */
  agents?: AgentInfo[]
  /** Kept for API compatibility with the surrounding RecipesPage. */
  theme?: 'dark' | 'light'
}

export function RecipeSample(_props: RecipeSampleProps) {
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
    fetchRecipes()
  }, [fetchRecipes])

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
    )
  }

  if (recipes.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--text-dim)]">{t('recipe.sample.empty')}</p>
        <p className="text-xs text-[var(--text-dim)] mt-1">{t('recipe.sample.emptyHint')}</p>
      </div>
    )
  }

  const available = recipes.filter((r) => !r.installed)
  const installed = recipes.filter((r) => r.installed)

  return (
    <div className="space-y-6">
      {/* v0.2.x disable notice — recipe install is temporarily off
          until the KovitoHub signed publisher model ships in v0.3.0. */}
      <div
        data-testid="recipe-install-disabled-notice"
        className="px-3 py-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-secondary)]"
      >
        {t('recipe.install.comingSoon')}
      </div>

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
        {recipe.installed && recipe.historyEntry && (
          <p className="text-[10px] text-[var(--text-dim)] mt-1">
            {t('recipe.sample.installedDate')}: {new Date(recipe.historyEntry.appliedAt).toLocaleDateString('ja-JP')}
          </p>
        )}
      </div>
    </div>
  )
}
