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
import { useCallback, useEffect, useRef, useState } from 'react'
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
  /**
   * Switches the parent AppsScreen to the Apps tab. Used by the
   * "Manage in Apps tab" link on enabled sample cards so the user
   * has a direct path from the Samples surface to the management
   * surface the disable trigger lives on (judgement doc Section 4
   * prime .4). Optional so a standalone render of `SamplesTab`
   * (smoke tests, storybook stubs) still mounts; the link
   * gracefully degrades to a static hint in that case.
   */
  onSwitchToAppsTab?: () => void
  /**
   * Imperatively re-runs the parent's `loadUserMenuEntries()` so
   * the Apps tab list reflects a newly-enabled bundled sample
   * immediately on POST 2xx, instead of waiting for the
   * asynchronous `recipe_apps_changed` ws broadcast. Without this
   * eager refetch a disconnected / delayed ws would let "Manage
   * in Apps tab" land on a list that does not yet contain the
   * card the user just enabled. Mirrors the eager-refetch path
   * `RenameForm.onCommitted` already uses on PATCH success.
   * Optional so standalone renders still mount.
   */
  onForceRefetchMenuEntries?: () => void
}

type LoadState = 'loading' | 'loaded' | 'error'

export function SamplesTab({
  sampleRecipeVersion,
  onSwitchToAppsTab,
  onForceRefetchMenuEntries,
}: SamplesTabProps) {
  const [recipes, setRecipes] = useState<SampleRecipeInfo[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  // Monotonically-incrementing token guarding `fetchRecipes`
  // against out-of-order overlap. The function can be invoked from
  // the initial mount, the `sampleRecipeVersion` ws-driven effect,
  // and the eager refetch inside `handleEnable`; without the token
  // a slower older response can overwrite a fresher newer one and
  // briefly resurface an already-enabled card in its pre-enable
  // state. Each call captures the next token and bails on state
  // updates if the ref has since moved on.
  const fetchSeqRef = useRef(0)
  // Per-recipe Enable button state. Keyed by recipe id so multiple
  // clicks in flight (or one stuck behind a slow disk) do not block
  // each other. The server's idempotent retry semantics
  // (`isEnabledAndManifestCoherent`) make a stuck button safe to
  // re-click after a manual reload.
  const [enablingIds, setEnablingIds] = useState<Set<string>>(new Set())
  // Synchronous mirror of `enablingIds` for the single-flight
  // backpressure check. React's state update is asynchronous --
  // disabling the peer buttons via `setEnablingIds` only takes
  // effect on the next render, so two rapid clicks on different
  // cards could both enter `handleEnable` and issue parallel
  // `POST /api/recipes/sample/:recipeId/enable` requests before
  // the `disabled` attribute lands. A ref-tracked mutex lets us
  // bail synchronously inside `handleEnable` -- before the
  // request is sent -- which closes that race regardless of
  // render timing.
  const enableMutexRef = useRef(false)
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
    const token = ++fetchSeqRef.current
    try {
      const res = await kbFetch('/api/recipes/sample')
      if (!res.ok) {
        throw new Error(`Failed to fetch sample recipes: ${res.status}`)
      }
      const data = (await res.json()) as SampleRecipeInfo[]
      // Stale response — a newer call has already started or
      // committed, drop this result on the floor.
      if (fetchSeqRef.current !== token) return
      setRecipes(data)
      setState('loaded')
    } catch (err) {
      if (fetchSeqRef.current !== token) return
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
      // Synchronous mutex check: if another enable is already in
      // flight, drop this click on the floor. The peer button is
      // also rendered disabled via `enablingIds`, but two rapid
      // clicks on different cards can both enter this function
      // before React commits the re-render -- without the ref
      // guard those clicks would each issue a parallel
      // disk-heavy POST despite the visual disabled state.
      if (enableMutexRef.current) return
      enableMutexRef.current = true
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
        // Eager menu-entries refetch so the Apps tab list also
        // reflects the newly-enabled app immediately. Without this,
        // a delayed / disconnected `recipe_apps_changed` ws would
        // let the "Manage in Apps tab" link land on a list that
        // does not yet contain the card the user just enabled.
        onForceRefetchMenuEntries?.()
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
        // Release the synchronous mutex so the next enable click
        // (peer card or retry of the same card) can proceed.
        enableMutexRef.current = false
      }
    },
    [fetchRecipes, onForceRefetchMenuEntries],
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
        {recipes.map((recipe) => {
          const selfEnabling = enablingIds.has(recipe.id)
          // Client-side backpressure: only one bundled enable is
          // allowed in flight at a time. Each enable copies recipe
          // artifacts into `app/<appId>/`, writes the
          // `recipes-installed/<appId>/manifest.json` + the
          // recipe-history record, and broadcasts ws state — all
          // disk-heavy operations. Without this cap, a user
          // clicking through every card at once could pile up
          // overlapping copies and induce local DoS-style
          // contention. Peers stay disabled while *any* enable is
          // running; the active card itself still shows its own
          // loading label.
          const peerEnableInflight =
            enablingIds.size > 0 && !selfEnabling
          return (
            <SampleCard
              key={recipe.id}
              recipe={recipe}
              enabled={isEnabled(recipe)}
              isEnabling={selfEnabling}
              peerEnableInflight={peerEnableInflight}
              error={enableErrors.get(recipe.id) ?? null}
              onEnable={() => handleEnable(recipe.id)}
              onDismissError={() => dismissEnableError(recipe.id)}
              onSwitchToAppsTab={onSwitchToAppsTab}
            />
          )
        })}
      </div>
    </div>
  )
}

interface SampleCardProps {
  recipe: SampleRecipeInfo
  enabled: boolean
  isEnabling: boolean
  /**
   * True when a *different* sample card has an enable POST in
   * flight. Driven by the parent's client-side single-flight
   * backpressure (one bundled enable in flight globally). The
   * enable button is disabled while this is true so the user
   * cannot pile up disk-heavy parallel enables.
   */
  peerEnableInflight: boolean
  error: string | null
  onEnable: () => void
  onDismissError: () => void
  /** Forwarded to the "Manage in Apps tab" link on enabled cards. */
  onSwitchToAppsTab?: () => void
}

function SampleCard({
  recipe,
  enabled,
  isEnabling,
  peerEnableInflight,
  error,
  onEnable,
  onDismissError,
  onSwitchToAppsTab,
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
          // v2.0 UX rule (judgement doc Section 4 prime .4):
          // disable trigger lives on the Apps tab Actions menu.
          // Render a real button when the parent supplies a
          // tab-switch callback so users can jump straight to the
          // management surface; fall back to a static hint when
          // no callback is wired (standalone render / smoke
          // tests).
          onSwitchToAppsTab ? (
            <button
              type="button"
              data-testid={`samples-tab-card-${recipe.id}-manage-hint`}
              onClick={onSwitchToAppsTab}
              className="text-[11px] text-[var(--accent-text)] hover:underline"
            >
              {t('samplesTab.label.openInAppsTab')}
            </button>
          ) : (
            <span
              data-testid={`samples-tab-card-${recipe.id}-manage-hint`}
              className="text-[11px] text-[var(--text-dim)]"
            >
              {t('samplesTab.label.openInAppsTab')}
            </span>
          )
        ) : (
          <button
            type="button"
            data-testid={`samples-tab-card-${recipe.id}-enable-button`}
            onClick={onEnable}
            disabled={isEnabling || peerEnableInflight}
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
