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
 * v0.2.1 scope: read-only listing + source badge + Actions menu
 * (Remove app / Export recipe via the existing `AppActionsPopover`).
 *
 * Drag-and-drop reorder (`PUT /api/apps/menu-order`) and inline
 * rename (`PATCH /api/apps/:appId/menu-label`) are wired in a
 * follow-up commit on the same PR so the Apps tab can ship a
 * visible skeleton first and the D&D library integration can be
 * reviewed against an already-merged baseline.
 *
 * "+ Add app" jumps to the Sample apps tab (BS-L8 / network silence
 * — does NOT call `/api/recipes/install`, which is 410 Gone in
 * v0.2.x). "+ Create self-made app" opens the existing
 * `AppCreateModal` flow.
 */
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import type { AppMenuEntry } from '../types/app-types'
import { AppActionsPopover } from './AppActionsPopover'

interface AppsTabProps {
  userMenuEntries: AppMenuEntry[]
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
  onJumpToSamples,
  onCreateSelfMade,
  onRequestAppRemoval,
  onRequestRecipeExport,
}: AppsTabProps) {
  // Default sort: ascending `menuOrder` (null entries pushed to the
  // bottom in lexicographic `appId` order — the AppManifest spec
  // (v1.6 §6.2) treats a missing `menuOrder` as "newly created, place
  // at the end"). This matches the wireframe's "drag to reorder"
  // affordance, which writes `menuOrder` on commit.
  const sortedEntries = useMemo(() => {
    return [...userMenuEntries].sort((a, b) => {
      const orderA = a.menuOrder ?? Number.POSITIVE_INFINITY
      const orderB = b.menuOrder ?? Number.POSITIVE_INFINITY
      if (orderA !== orderB) return orderA - orderB
      return a.id.localeCompare(b.id)
    })
  }, [userMenuEntries])

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

      {/* App list */}
      {sortedEntries.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm text-[var(--text-dim)]">
            {t('appsTab.empty')}
          </p>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            {t('appsTab.emptyHint')}
          </p>
        </div>
      ) : (
        <ul
          className="space-y-1.5"
          data-testid="apps-tab-list"
        >
          {sortedEntries.map((entry) => (
            <AppRow
              key={entry.id}
              entry={entry}
              onNavigate={() => {
                // Navigate to /ext/<appId>. Using a stable callback
                // form so the AppRow stays a pure presentational
                // component (no router import inside the row).
              }}
              onRequestAppRemoval={onRequestAppRemoval}
              onRequestRecipeExport={onRequestRecipeExport}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface AppRowProps {
  entry: AppMenuEntry
  onNavigate: () => void
  onRequestAppRemoval: AppsTabProps['onRequestAppRemoval']
  onRequestRecipeExport: AppsTabProps['onRequestRecipeExport']
}

function AppRow({
  entry,
  onRequestAppRemoval,
  onRequestRecipeExport,
}: AppRowProps) {
  const navigate = useNavigate()
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const actionsAnchorRef = useRef<HTMLDivElement>(null)

  // Display label fallback chain (judgement doc §11.2 / app-directory-
  // extension v1.6 §6.8.2):
  //   userMenuLabel ?? displayName ?? label ?? appId
  // The `userMenuLabel` is the only field a user can write; the
  // others are derived from the manifest / menu.ts and survive a
  // user reset (`userMenuLabel = null`).
  const displayLabel =
    entry.userMenuLabel ?? entry.displayName ?? entry.label ?? entry.id

  return (
    <li
      data-testid={`apps-tab-row-${entry.id}`}
      data-app-id={entry.id}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-3 py-2 flex items-center gap-3"
    >
      {/* Drag handle — static placeholder in this commit. The D&D
          library integration (dnd-kit) lands in a follow-up commit on
          the same PR so the visible UI ships first. The handle is
          rendered as a non-interactive svg for now; the
          `aria-disabled` attribute makes the intent explicit to
          screen readers until the sortable wiring lands. */}
      <span
        aria-disabled="true"
        aria-label={t('appsScreen.label.dragHandle')}
        className="shrink-0 text-[var(--text-dim)] cursor-default select-none"
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
      </span>

      {/* Label — clicking the row navigates to the app's page so the
          user sees the same affordance as the side nav. */}
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

      {/* Rename button — opens an inline edit affordance in the
          follow-up commit. Today it is a placeholder so the row
          layout is final. */}
      <button
        type="button"
        data-testid={`apps-tab-row-${entry.id}-rename`}
        aria-label={t('appsScreen.button.rename')}
        title={t('appsScreen.button.rename')}
        disabled
        className="shrink-0 text-[var(--text-dim)] opacity-50 cursor-not-allowed"
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

      {/* Actions menu — reuses the existing AppActionsPopover so the
          NavMenu actionSlot RemoveAppButton stays in sync (judgement
          doc §4'.6: backward-compat residency, both paths reach
          the same flow). */}
      <div ref={actionsAnchorRef} className="relative shrink-0">
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
    </li>
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
 * install). `samplesTab.label.enabled` is the closest existing key
 * (the sample badge surface is the same UX semantic as the green
 * "Enabled" pill on the Samples tab); a dedicated `app.source.sample`
 * key is added by the i18n follow-up step in this PR.
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
