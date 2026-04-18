/**
 * Bundled recipes — shows pre-installed recipes split into Available / Installed sections.
 * For recipes with an api: section, a scope approval modal is shown before installation.
 */
import { useState, useEffect, useCallback } from 'react'
import type { RecipeApiSection, ParsedRecipe, InspectionResult } from '../../shared/recipe-types'
import { RecipeInstallModal } from './RecipeInstallModal'

/** Bundled recipe info from the server. */
interface BundledRecipeInfo {
  id: string
  metadata: {
    name: string
    description: string
    version: string
    author?: string
    tags?: string[]
  }
  sourcePath: string
  sourceFormat: 'directory' | 'markdown'
  hash: string
  installed: boolean
  historyEntry?: {
    id: string
    appliedAt: string
  }
}

type LoadState = 'loading' | 'loaded' | 'error'

export function RecipeBundled() {
  const [recipes, setRecipes] = useState<BundledRecipeInfo[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)

  // State for api: approval modal
  const [pendingInstall, setPendingInstall] = useState<{
    recipe: BundledRecipeInfo
    parsed: ParsedRecipe
    inspection: InspectionResult
    api: RecipeApiSection
  } | null>(null)

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await fetch('/api/recipes/bundled')
      if (!res.ok) {
        throw new Error(`Failed to fetch bundled recipes: ${res.status}`)
      }
      const data = await res.json() as BundledRecipeInfo[]
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

  const handleInstall = useCallback(async (recipe: BundledRecipeInfo) => {
    setInstallingId(recipe.id)
    try {
      // Step 1: Parse the recipe
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

      // Step 2: if an api: section exists, show the approval modal
      if (parsed.api && parsed.api.scopes.length > 0) {
        setPendingInstall({ recipe, parsed, inspection, api: parsed.api })
        setInstallingId(null)
        return // Wait for modal approval/rejection
      }

      // Step 3: recipes without api: are applied directly as before
      await applyRecipe(parsed, inspection)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
      setInstallingId(null)
    }
  }, [fetchRecipes])

  /** Execute installation after api: approval */
  const handleApproveInstall = useCallback(async () => {
    if (!pendingInstall) return
    const { parsed, inspection } = pendingInstall
    setInstallingId(pendingInstall.recipe.id)
    try {
      await applyRecipe(parsed, inspection)
      setPendingInstall(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setInstallingId(null)
    }
  }, [pendingInstall, fetchRecipes])

  /** api: approval rejected */
  const handleRejectInstall = useCallback(() => {
    setPendingInstall(null)
    setInstallingId(null)
  }, [])

  /** Common logic for applying a recipe */
  async function applyRecipe(parsed: ParsedRecipe, inspection: InspectionResult) {
    const applyRes = await fetch('/api/recipes/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipe: parsed, inspection }),
    })
    if (!applyRes.ok) {
      const data = await applyRes.json()
      throw new Error(data.error || 'Apply failed')
    }
    await fetchRecipes()
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-[var(--text-dim)] text-sm">同梱レシピを読み込み中...</div>
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
          再読み込み
        </button>
      </div>
    )
  }

  if (recipes.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--text-dim)]">
          同梱レシピはありません
        </p>
        <p className="text-xs text-[var(--text-dim)] mt-1">
          <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">recipes/</code> ディレクトリにレシピを追加すると、ここに表示されます。
        </p>
      </div>
    )
  }

  const available = recipes.filter((r) => !r.installed)
  const installed = recipes.filter((r) => r.installed)

  return (
    <div className="space-y-6">
      {/* api: approval modal */}
      {pendingInstall && (
        <RecipeInstallModal
          recipeName={pendingInstall.parsed.metadata.name}
          api={pendingInstall.api}
          isInstalling={installingId === pendingInstall.recipe.id}
          onConfirm={handleApproveInstall}
          onReject={handleRejectInstall}
        />
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
            インストール前 ({available.length})
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
            インストール済み ({installed.length})
          </h3>
          <div className="space-y-2">
            {installed.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                isInstalling={false}
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
}: {
  recipe: BundledRecipeInfo
  isInstalling: boolean
  onInstall?: () => void
}) {
  return (
    <div data-testid={`recipe-card-${recipe.id}`} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-bold text-[var(--text-primary)] truncate">
            {recipe.metadata.name}
          </h4>
          <span className="text-xs text-[var(--text-dim)] shrink-0">
            v{recipe.metadata.version}
          </span>
          {recipe.installed && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 shrink-0">
              インストール済み
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
          {recipe.metadata.description}
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
            インストール日: {new Date(recipe.historyEntry.appliedAt).toLocaleDateString('ja-JP')}
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
            {isInstalling ? 'インストール中...' : 'インストール'}
          </button>
        )}
      </div>
    </div>
  )
}
