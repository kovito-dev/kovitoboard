/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Apps tab — unified list of installed apps on the v0.2.1 Apps
 * screen (judgement doc §4'.3).
 *
 * Five sources rendered in a single list (default sort by persisted
 * `menuOrder`, ties broken by `appId`):
 *   - `'self-made'`  (user-creation, scanner-derived)
 *   - `'bundled'`    (v0.2.1 bundled enable)
 *   - `'sample'`     (grandfather pre-v0.2.1 install)
 *   - `'import'`     (recipe install from disk archive)
 *   - `'url'`        (recipe install from URL)
 *
 * Drag-and-drop reorder (dnd-kit) writes through
 * `PUT /api/apps/menu-order` as a closed-world batch — every
 * eligible app's `menuOrder` is rewritten in a single atomic
 * transaction (http-api-contract v1.7.1 §6.3.9.A:
 * `MenuOrderCoverageMismatch` / `MenuOrderNonContiguous` /
 * `MenuOrderSnapshotDrift`). Inline rename writes through
 * `PATCH /api/apps/:appId/menu-label`; empty body resets to the
 * `displayName` default, empty string is rejected with
 * `MenuLabelEmpty`.
 *
 * "+ Add app" jumps to the Sample apps tab (BS-L8 / network silence
 * — does NOT call `/api/recipes/install`, which is 410 Gone in
 * v0.2.x). "+ Create self-made app" opens the existing
 * `AppCreateModal` flow.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { t } from '../i18n'
import { kbFetch } from '../lib/kbFetch'
import { createLogger } from '../lib/logger'
import {
  isMenuMetadataEligible,
  type AppMenuEntry,
} from '../types/app-types'
import { AppActionsPopover } from './AppActionsPopover'

const log = createLogger('AppsTab')

/**
 * Maximum length for `userMenuLabel`. Mirrors the server-side cap
 * declared by `http-api-contract.md` v1.7.1 §6.3.9.A so the
 * `maxLength` attribute on the input prevents over-length submission
 * before the request even leaves the browser; the server rejects
 * over-length values with HTTP 400 `MenuLabelTooLong` as a defence
 * in depth.
 */
const MENU_LABEL_MAX_LENGTH = 80

interface AppsTabProps {
  userMenuEntries: AppMenuEntry[]
  /**
   * Server-supplied menu-order snapshot string (sourced from the
   * `X-Apps-Menu-Snapshot` response header of
   * `GET /api/app/menu-entries`). Seeds `snapshotVersionRef` on
   * mount and on every parent-driven refetch so the **first**
   * `PUT /api/apps/menu-order` already carries `snapshotVersion`
   * and engages the HTTP 409 `MenuOrderSnapshotDrift` gate
   * (`http-api-contract.md` v1.7.1 §6.3.9.A BS-L6). `null` when
   * the header was absent (legacy fallback path) — the renderer
   * gracefully degrades to the prior last-write-wins behaviour
   * without dropping the optimistic UI.
   */
  menuOrderSnapshot: string | null
  /** "+ Add app" handler — switches to the Sample apps tab. */
  onJumpToSamples: () => void
  /** "+ Create self-made app" handler — opens the AppCreateModal. */
  onCreateSelfMade: () => void
  /** Forwarded to the Actions menu's "Remove app" item. */
  onRequestAppRemoval: (request: {
    appId: string
    displayName: string
  }) => void
  /** Forwarded to the Actions menu's "Export recipe" item. */
  onRequestRecipeExport: (request: {
    appId: string
    displayName: string
  }) => void
}

export function AppsTab({
  userMenuEntries,
  menuOrderSnapshot,
  onJumpToSamples,
  onCreateSelfMade,
  onRequestAppRemoval,
  onRequestRecipeExport,
}: AppsTabProps) {
  // Split menu-metadata eligible rows (AppManifest readable) from
  // ineligible ones (partial residue / unreadable manifest). Only
  // eligible rows participate in D&D reorder, the closed-world
  // `PUT /api/apps/menu-order` batch, and inline rename — per
  // `app-directory-extension.md` v1.6 §6.8.1 / §6.8.3. Ineligible
  // rows still render in the list so the user can disable / remove
  // them through the source-based routing path (§4.3 L3); their
  // drag handle and Rename control are hidden because PATCH
  // /menu-label would 500 `AppManifestUnreadable` and including
  // them in the batch would 400 `MenuOrderCoverageMismatch`.
  const { eligibleEntries, ineligibleEntries } = useMemo(() => {
    const eligible: AppMenuEntry[] = []
    const ineligible: AppMenuEntry[] = []
    for (const entry of userMenuEntries) {
      if (isMenuMetadataEligible(entry)) {
        eligible.push(entry)
      } else {
        ineligible.push(entry)
      }
    }
    return { eligibleEntries: eligible, ineligibleEntries: ineligible }
  }, [userMenuEntries])

  // Default sort for eligible rows: ascending `menuOrder`. Per
  // `app-directory-extension.md` v1.6 §6.8.1, the scanner assigns a
  // provisional order (menu.ts appearance order, then appId
  // lexicographic for the rest) for any eligible app whose
  // `AppManifest.menuOrder` is unset, and the API loader reflects
  // that in the wire response. So the wire order is authoritative
  // for `menuOrder === null` rows — we treat null as
  // `+Infinity` to push them after the persisted block, then rely
  // on JavaScript's stable Array.prototype.sort to preserve the
  // server-provided order among nulls (no `appId` tie-break — that
  // would discard the scanner's fallback order, which is the SSOT).
  const sortedFromProps = useMemo(() => {
    return [...eligibleEntries].sort((a, b) => {
      const orderA = a.menuOrder ?? Number.POSITIVE_INFINITY
      const orderB = b.menuOrder ?? Number.POSITIVE_INFINITY
      return orderA - orderB
    })
  }, [eligibleEntries])

  // Local mirror so the visual order can update optimistically on
  // drag-end before the server PUT round-trip lands. Re-synced
  // whenever the parent re-fetches (the `appMenuVersion` ws-event
  // bump triggers a fresh `loadUserMenuEntries()` upstream, which
  // re-runs this memo and overwrites any optimistic snapshot — that
  // is the desired "reconcile from server" behaviour).
  const [orderedIds, setOrderedIds] = useState<string[]>(() =>
    sortedFromProps.map((entry) => entry.id),
  )
  useEffect(() => {
    setOrderedIds(sortedFromProps.map((entry) => entry.id))
  }, [sortedFromProps])

  // Resolve each id to the actual entry so the render loop can
  // iterate stable refs from the prop. If an id is in `orderedIds`
  // but not in the prop (concurrent removal mid-drag), skip it; the
  // refetch will rebuild the list.
  const entryById = useMemo(() => {
    const map = new Map<string, AppMenuEntry>()
    for (const entry of userMenuEntries) {
      map.set(entry.id, entry)
    }
    return map
  }, [userMenuEntries])
  const orderedEntries = useMemo(
    () =>
      orderedIds
        .map((id) => entryById.get(id))
        .filter((entry): entry is AppMenuEntry => entry !== undefined),
    [orderedIds, entryById],
  )
  // Total rendered count drives the empty-state branch — both
  // eligible (sortable) and ineligible (read-only) rows count.
  const totalVisibleCount =
    orderedEntries.length + ineligibleEntries.length

  // Inflight PUT /menu-order state. Disables the sortable surface
  // and shows a small "saving…" hint at the top of the list. The
  // last server snapshotVersion comes back on every successful PUT
  // and is forwarded with the next one so concurrent edits surface
  // as 409 `MenuOrderSnapshotDrift` instead of silently overwriting
  // a peer's reorder.
  const [reorderState, setReorderState] = useState<{
    inflight: boolean
    error: string | null
  }>({ inflight: false, error: null })
  const snapshotVersionRef = useRef<string | undefined>(
    menuOrderSnapshot ?? undefined,
  )

  // Seed the ref from the parent-supplied snapshot on every refetch
  // so the next PUT carries the freshest server snapshot — without
  // this the `MenuOrderSnapshotDrift` (HTTP 409) gate would be
  // bypassed on the first reorder of a fresh page load, and a peer
  // client's intervening reorder would silently overwrite the local
  // one (`http-api-contract.md` v1.7.1 §6.3.9.A BS-L6). Only
  // overwrite when the wire offered a value — `null` means the
  // server omitted the header (e.g. legacy fallback path) and we
  // keep whatever the previous successful PUT or fetch stored.
  useEffect(() => {
    if (menuOrderSnapshot !== null) {
      snapshotVersionRef.current = menuOrderSnapshot
    }
  }, [menuOrderSnapshot])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a small drag distance before the sortable activates
      // so accidental clicks on the row body still navigate via the
      // `<button>` inside the row.
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = orderedIds.indexOf(String(active.id))
      const newIndex = orderedIds.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return

      const nextOrderedIds = arrayMove(orderedIds, oldIndex, newIndex)
      const previousOrderedIds = orderedIds

      // Optimistic update: render the new order immediately so the
      // drop animation lands in place. Rollback below if the PUT
      // fails.
      setOrderedIds(nextOrderedIds)
      setReorderState({ inflight: true, error: null })

      try {
        const body = {
          order: nextOrderedIds.map((appId, idx) => ({
            appId,
            menuOrder: idx,
          })),
          ...(snapshotVersionRef.current !== undefined
            ? { snapshotVersion: snapshotVersionRef.current }
            : {}),
        }
        const res = await kbFetch('/api/apps/menu-order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(data.error ?? `Reorder failed: ${res.status}`)
        }
        const ok = (await res.json()) as {
          updated: number
          snapshotVersion: string
        }
        snapshotVersionRef.current = ok.snapshotVersion
        setReorderState({ inflight: false, error: null })
        // The server broadcasts `app_menu_changed` after this
        // returns, which bumps `appMenuVersion` upstream and triggers
        // a `loadUserMenuEntries()` refetch in App.tsx. The refetch
        // is the source of truth for the reconciled order; until it
        // arrives our optimistic snapshot stays visible.
      } catch (err) {
        log.warn(
          { err },
          'PUT /api/apps/menu-order failed; rolling back optimistic order',
        )
        setOrderedIds(previousOrderedIds)
        setReorderState({
          inflight: false,
          error:
            err instanceof Error ? err.message : 'Reorder failed',
        })
      }
    },
    [orderedIds],
  )

  return (
    <div className="space-y-4">
      {/* Header row: + Add app / + Create self-made app. Left-aligned
          per wireframe §4'.2. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="apps-tab-add-app-button"
          onClick={onJumpToSamples}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 transition-opacity"
        >
          {t('appsScreen.button.addApp')}
        </button>
        {/* The `recipe-create-app-button` testid is preserved from the
            legacy RecipesPage so existing L1 E2E specs (which were
            tracking the AppCreateModal entry point) keep working
            without a touch. The Apps tab now owns the entry; the
            legacy RecipesPage button was retired by the route swap
            in `App.tsx`. */}
        <button
          type="button"
          data-testid="recipe-create-app-button"
          onClick={onCreateSelfMade}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          {t('appsScreen.button.createSelfMade')}
        </button>
      </div>

      <div className="border-t border-[var(--border)]" />

      {/* Inflight indicator + reorder error banner */}
      {reorderState.inflight && (
        <div
          data-testid="apps-tab-reorder-saving"
          className="text-xs text-[var(--text-dim)]"
        >
          {t('appsTab.reorder.saving')}
        </div>
      )}
      {reorderState.error && (
        <div
          data-testid="apps-tab-reorder-error"
          role="alert"
          className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 flex items-start justify-between gap-3"
        >
          <span className="flex-1">{reorderState.error}</span>
          <button
            type="button"
            onClick={() =>
              setReorderState({ inflight: false, error: null })
            }
            className="shrink-0 text-red-300 hover:text-red-200"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* App list */}
      {totalVisibleCount === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm text-[var(--text-dim)]">
            {t('appsTab.empty')}
          </p>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            {t('appsTab.emptyHint')}
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          {/* `SortableContext.items` is restricted to eligible rows
              (see §6.8.3 closed-world batch) — ineligible rows still
              render below but are not draggable. */}
          <SortableContext
            items={orderedIds}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className="space-y-1.5"
              data-testid="apps-tab-list"
            >
              {orderedEntries.map((entry) => (
                <SortableAppRow
                  key={entry.id}
                  entry={entry}
                  reorderInflight={reorderState.inflight}
                  onRequestAppRemoval={onRequestAppRemoval}
                  onRequestRecipeExport={onRequestRecipeExport}
                />
              ))}
              {ineligibleEntries.map((entry) => (
                <AppRow
                  key={entry.id}
                  entry={entry}
                  eligible={false}
                  onRequestAppRemoval={onRequestAppRemoval}
                  onRequestRecipeExport={onRequestRecipeExport}
                  reorderInflight={reorderState.inflight}
                  sortable={null}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

interface SortableAppRowProps {
  entry: AppMenuEntry
  reorderInflight: boolean
  onRequestAppRemoval: AppsTabProps['onRequestAppRemoval']
  onRequestRecipeExport: AppsTabProps['onRequestRecipeExport']
}

/**
 * Per-row sortable wrapper. Exposes a dedicated drag handle so the
 * row body (label / Rename / Actions trigger) stays interactive while
 * only the handle initiates a drag.
 */
function SortableAppRow({
  entry,
  reorderInflight,
  onRequestAppRemoval,
  onRequestRecipeExport,
}: SortableAppRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id, disabled: reorderInflight })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : undefined,
  }
  return (
    <AppRow
      entry={entry}
      eligible
      onRequestAppRemoval={onRequestAppRemoval}
      onRequestRecipeExport={onRequestRecipeExport}
      reorderInflight={reorderInflight}
      sortable={{
        ref: setNodeRef,
        style,
        handleRef: setActivatorNodeRef,
        handleAttributes: attributes,
        handleListeners: listeners,
        isDragging,
      }}
    />
  )
}

interface SortableInfo {
  ref: (node: HTMLElement | null) => void
  style: CSSProperties
  handleRef: (node: HTMLElement | null) => void
  handleAttributes: ReturnType<typeof useSortable>['attributes']
  handleListeners: ReturnType<typeof useSortable>['listeners']
  isDragging: boolean
}

interface AppRowProps {
  entry: AppMenuEntry
  /**
   * True when the row is menu-metadata eligible (AppManifest
   * readable, §6.8.1). Drives whether the drag handle and Rename
   * control render. Ineligible rows can still be opened and reach
   * the Actions menu (Remove app) so the user can recover from a
   * partial-residue state through the source-based routing path.
   */
  eligible: boolean
  onRequestAppRemoval: AppsTabProps['onRequestAppRemoval']
  onRequestRecipeExport: AppsTabProps['onRequestRecipeExport']
  reorderInflight: boolean
  /**
   * `null` for ineligible rows that render outside the
   * `SortableContext` (no drag handle bindings, no reorder
   * participation).
   */
  sortable: SortableInfo | null
}

function AppRow({
  entry,
  eligible,
  onRequestAppRemoval,
  onRequestRecipeExport,
  reorderInflight,
  sortable,
}: AppRowProps) {
  const navigate = useNavigate()
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)

  // Display label fallback chain. The wire-side
  // `app-directory-extension.md` v1.6 §6.8.2 pins the base label
  // SSOT to a **file** (`recipe.yaml.menu.label` for recipe-install
  // apps, `app/menu.ts` for self-made apps) rather than to the
  // AppManifest's install-time `displayName` snapshot. The renderer
  // approximates that precedence by preferring `entry.label`
  // (menu.ts-derived, refreshed on every scan) over
  // `entry.displayName` (AppManifest install snapshot, stale after
  // recipe upgrades). A server-side resolver that reads
  // `recipe.yaml` directly is deferred — see the PR description's
  // "Out of Scope" entry on `resolvedBaseLabel`. `userMenuLabel`
  // stays at the top of the chain (user override; survives a reset
  // via `userMenuLabel = null`); `appId` is the final fallback.
  const displayLabel =
    entry.userMenuLabel ?? entry.label ?? entry.displayName ?? entry.id

  return (
    <li
      ref={sortable?.ref}
      style={sortable?.style}
      data-testid={`apps-tab-row-${entry.id}`}
      data-app-id={entry.id}
      data-eligible={eligible ? 'true' : 'false'}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-3 py-2 flex items-center gap-3"
    >
      {/* Drag handle — eligible rows only (ineligible rows are
          excluded from the closed-world reorder batch §6.8.3).
          Pointer activation requires 4px movement so accidental
          clicks on the handle do not steal taps from the row body. */}
      {sortable && (
        <button
          ref={sortable.handleRef}
          type="button"
          data-testid={`apps-tab-row-${entry.id}-drag-handle`}
          aria-label={t('appsScreen.label.dragHandle')}
          title={t('appsScreen.label.dragHandle')}
          disabled={reorderInflight}
          {...sortable.handleAttributes}
          {...sortable.handleListeners}
          className="shrink-0 text-[var(--text-dim)] hover:text-[var(--text-secondary)] cursor-grab active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 p-0.5"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="9" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" />
            <circle cx="15" cy="6" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="15" cy="18" r="1.5" />
          </svg>
        </button>
      )}

      {isRenaming ? (
        <RenameForm
          entry={entry}
          currentLabel={displayLabel}
          onCancel={() => setIsRenaming(false)}
          onCommitted={() => setIsRenaming(false)}
        />
      ) : (
        <>
          {/* Label — clicking the row navigates to the app's page so
              the user sees the same affordance as the side nav. */}
          <button
            type="button"
            data-testid={`apps-tab-row-${entry.id}-open`}
            onClick={() => navigate(`/ext/${entry.id}`)}
            className="flex-1 min-w-0 text-left text-sm font-medium text-[var(--text-primary)] truncate hover:text-[var(--accent-text)] transition-colors"
          >
            {displayLabel}
          </button>

          {/* Source badge — `null` source hides the badge. */}
          {entry.source && <SourceBadge source={entry.source} />}

          {/* Rename button — eligible rows only. PATCH
              `/api/apps/:appId/menu-label` is reserved for apps with
              a readable AppManifest (§6.8.2), so ineligible rows are
              routed through the source-based disable / remove path
              via the Actions menu instead. */}
          {eligible && (
            <button
              type="button"
              data-testid={`apps-tab-row-${entry.id}-rename`}
              aria-label={t('appsScreen.button.rename')}
              title={t('appsScreen.button.rename')}
              onClick={() => setIsRenaming(true)}
              className="shrink-0 text-[var(--text-dim)] hover:text-[var(--accent-text)] transition-colors p-0.5"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
          )}

          {/* Actions menu — reuses the existing AppActionsPopover so
              the NavMenu actionSlot RemoveAppButton stays in sync
              (judgement doc §4'.6: backward-compat residency, both
              paths reach the same flow). */}
          <div className="relative shrink-0">
            <button
              type="button"
              data-testid={`apps-tab-row-${entry.id}-actions`}
              aria-label={t('app.actions.menu')}
              aria-haspopup="menu"
              aria-expanded={isPopoverOpen}
              onClick={() => setIsPopoverOpen((prev) => !prev)}
              className="text-[var(--text-secondary)] hover:text-[var(--accent-text)] transition-colors p-1 rounded"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
            <AppActionsPopover
              isOpen={isPopoverOpen}
              onClose={() => setIsPopoverOpen(false)}
              onSelectExport={() =>
                onRequestRecipeExport({
                  appId: entry.id,
                  displayName: displayLabel,
                })
              }
              onSelectRemoval={() =>
                onRequestAppRemoval({
                  appId: entry.id,
                  displayName: displayLabel,
                })
              }
            />
          </div>
        </>
      )}
    </li>
  )
}

interface RenameFormProps {
  entry: AppMenuEntry
  currentLabel: string
  onCancel: () => void
  onCommitted: () => void
}

/**
 * Inline rename form — replaces the row body with an input + Save /
 * Cancel / Reset trio. The reset button posts `userMenuLabel: null`
 * (judgement doc §4.7 BS-L7), which restores the manifest's
 * `displayName` / `menu.ts` label fallback chain. Empty string is
 * rejected before the request leaves the browser (HTML required
 * + JS guard) so the server's `MenuLabelEmpty` is reserved for the
 * out-of-band PATCH path.
 */
function RenameForm({
  entry,
  currentLabel,
  onCancel,
  onCommitted,
}: RenameFormProps) {
  // Seed the input with the current effective label (could be the
  // userMenuLabel, the displayName, or the menu.ts label) so the
  // user sees what they will overwrite. Trimming on submit prevents
  // whitespace-only labels from sneaking past the empty check.
  const [draft, setDraft] = useState(currentLabel)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = useCallback(
    async (nextLabel: string | null) => {
      setSubmitting(true)
      setError(null)
      try {
        const res = await kbFetch(
          `/api/apps/${encodeURIComponent(entry.id)}/menu-label`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMenuLabel: nextLabel }),
          },
        )
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(
            data.error ?? `Rename failed: ${res.status}`,
          )
        }
        // ws `app_menu_changed` (`menu-label-update`) will refetch
        // upstream; we close the form immediately so the row body
        // re-renders against the optimistic local state.
        onCommitted()
      } catch (err) {
        log.warn(
          { err, appId: entry.id },
          'PATCH /api/apps/:appId/menu-label failed',
        )
        setError(
          err instanceof Error ? err.message : 'Rename failed',
        )
      } finally {
        setSubmitting(false)
      }
    },
    [entry.id, onCommitted],
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const trimmed = draft.trim()
      if (trimmed.length === 0) {
        setError(t('appsScreen.error.menuLabelEmpty'))
        return
      }
      if (trimmed.length > MENU_LABEL_MAX_LENGTH) {
        setError(t('appsScreen.error.menuLabelTooLong'))
        return
      }
      commit(trimmed)
    },
    [draft, commit],
  )

  const handleReset = useCallback(() => {
    // `userMenuLabel: null` restores the default chain. We do not
    // confirm because the manifest's `displayName` (or menu.ts
    // label) is always available as the next fallback — the user
    // can simply rename again if they regret the reset.
    commit(null)
  }, [commit])

  return (
    <form
      data-testid={`apps-tab-row-${entry.id}-rename-form`}
      onSubmit={handleSubmit}
      className="flex-1 flex items-center gap-2 min-w-0"
    >
      <input
        ref={inputRef}
        data-testid={`apps-tab-row-${entry.id}-rename-input`}
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        maxLength={MENU_LABEL_MAX_LENGTH}
        placeholder={t('appsScreen.label.renamePlaceholder')}
        disabled={submitting}
        aria-label={t('appsScreen.button.rename')}
        aria-invalid={error !== null}
        className="flex-1 min-w-0 px-2 py-1 text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-text)]"
      />
      <button
        type="submit"
        data-testid={`apps-tab-row-${entry.id}-rename-save`}
        disabled={submitting}
        className="shrink-0 px-2 py-1 text-xs font-medium rounded bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        {t('appsScreen.button.renameSave')}
      </button>
      <button
        type="button"
        data-testid={`apps-tab-row-${entry.id}-rename-reset`}
        onClick={handleReset}
        disabled={submitting || entry.userMenuLabel === null}
        title={t('appsScreen.button.renameResetTooltip')}
        className="shrink-0 px-2 py-1 text-xs font-medium rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {t('appsScreen.button.renameReset')}
      </button>
      <button
        type="button"
        data-testid={`apps-tab-row-${entry.id}-rename-cancel`}
        onClick={onCancel}
        disabled={submitting}
        className="shrink-0 px-2 py-1 text-xs font-medium rounded text-[var(--text-dim)] hover:text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {t('appsScreen.button.renameCancel')}
      </button>
      {error && (
        <span
          data-testid={`apps-tab-row-${entry.id}-rename-error`}
          role="alert"
          className="shrink-0 text-xs text-red-400"
        >
          {error}
        </span>
      )}
    </form>
  )
}

/** Source badge — five values, color-coded for quick scanning. */
function SourceBadge({
  source,
}: {
  source: NonNullable<AppMenuEntry['source']>
}) {
  const { label, classes } = SOURCE_BADGE_META[source]
  return (
    <span
      data-testid={`apps-tab-source-badge-${source}`}
      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${classes}`}
    >
      {label}
    </span>
  )
}

/**
 * Static metadata for the source badge. `label` is resolved through
 * `t()` so the OSS locale switch keeps the badge in sync; `classes`
 * is the Tailwind color pair (badge background + text).
 *
 * The `sample` entry is the grandfather alias (pre-v0.2.1 sample
 * install).
 */
const SOURCE_BADGE_META: Record<
  NonNullable<AppMenuEntry['source']>,
  { label: string; classes: string }
> = {
  'self-made': {
    get label() {
      return t('app.source.selfMade')
    },
    classes: 'bg-purple-500/20 text-purple-300',
  },
  bundled: {
    get label() {
      return t('app.source.bundled')
    },
    classes: 'bg-sky-500/20 text-sky-300',
  },
  sample: {
    get label() {
      return t('app.source.sample')
    },
    classes: 'bg-green-500/20 text-green-400',
  },
  import: {
    get label() {
      return t('app.source.import')
    },
    classes: 'bg-amber-500/20 text-amber-300',
  },
  url: {
    get label() {
      return t('app.source.url')
    },
    classes: 'bg-rose-500/20 text-rose-300',
  },
}
