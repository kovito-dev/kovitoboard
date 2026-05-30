/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * AppActionsPopover — popover menu spawned by `AppActionsMenuButton`.
 *
 * Lists the app-scoped actions (export recipe / remove app) the user
 * can run for the currently focused `app/<appId>/` screen. Replaces
 * the NavMenu actionSlot direct-placement of `RemoveAppButton`
 * (DEC-024 #5 / spec §F2, §F4).
 *
 * Behaviour:
 *   - Closes on Esc or outside click
 *   - Initial focus on the first menu item
 *   - Tab cycles through menu items, ↑↓ moves focus
 *   - Enter / Space activates the focused item
 *
 * The popover is intentionally rendered inline (not via React Portal):
 * the AmbientSidebar's z-index is high enough to clear adjacent UI,
 * and inline rendering keeps focus management trivial. Revisit if
 * z-index conflicts surface in QA.
 */
import { useEffect, useRef } from 'react'
import { t } from '../i18n'

interface AppActionsPopoverProps {
  /** Open state — controlled by the parent (the menu button toggles it). */
  isOpen: boolean
  /** Called when the popover should close (outside click / Esc / item activation). */
  onClose: () => void
  /** Callback for the "Export recipe" menu item. */
  onSelectExport: () => void
  /**
   * Callback for the "Remove app" menu item. Only rendered for
   * self-made / import / url apps — bundled and grandfather
   * sample apps are routed through {@link onSelectDisable}
   * instead so the spec's data-preservation invariant for
   * grandfather installs is honoured (`app/data/<appId>/`
   * survives a disable, but a remove deletes everything in the
   * app subtree).
   */
  onSelectRemoval: () => void
  /**
   * Callback for the "Disable" menu item rendered when {@link
   * source} is `'bundled'` or `'sample'`. The Apps tab wires
   * this to `POST /api/recipes/sample/:recipeId/disable` so the
   * non-destructive disable path is taken instead of the
   * destructive remove path.
   */
  onSelectDisable?: () => void
  /**
   * Drives whether the popover renders the destructive "Remove
   * app" item or the non-destructive "Disable" item. Bundled /
   * grandfather sample apps render "Disable"; self-made /
   * import / url render "Remove app"; legacy hand-edited rows
   * with `source === null` ALSO render "Remove app" but only
   * when {@link manifestState} is `'missing'`. The
   * `'unreadable'` recovery state suppresses both actions
   * because the lineage is in flux.
   */
  source?: 'self-made' | 'bundled' | 'sample' | 'import' | 'url' | null
  /**
   * AppManifest read state. See `AppMenuEntry.manifestState` for
   * the tri-state semantics. The popover keys destructive Remove
   * gating on this so `source === null` does not conflate
   * "legacy hand-edited (Remove safe)" with "partial-residue
   * recovery (Remove unsafe)". Optional for backward compat with
   * pre-v0.2.1 wires; missing / unknown values default to
   * `'missing'` (the conservative "Remove allowed" branch for
   * source-less rows).
   */
  manifestState?: 'present' | 'unreadable' | 'missing' | 'anomalous'
  /**
   * Horizontal expansion direction. `'left'` (default) anchors the
   * popover's left edge to the trigger and expands rightward; `'right'`
   * anchors the right edge to the trigger and expands leftward.
   * Right-anchored hosts (the viewport-pinned AmbientSidebar, whose
   * narrow column sits flush against the right edge of the window) must
   * pass `'right'` so the 180px-wide popover never overflows the
   * viewport edge and becomes unclickable. The AppsTab keeps the
   * default `'left'` so its behaviour is unchanged.
   */
  align?: 'left' | 'right'
}

export function AppActionsPopover({
  isOpen,
  onClose,
  onSelectExport,
  onSelectRemoval,
  onSelectDisable,
  source,
  manifestState,
  align = 'left',
}: AppActionsPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const exportItemRef = useRef<HTMLButtonElement>(null)

  // Close on Esc / outside click. We attach the listeners only while
  // open so unrelated key/mouse events on other screens are not
  // intercepted.
  useEffect(() => {
    if (!isOpen) return

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    function handleClick(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target || !menuRef.current) return
      if (menuRef.current.contains(target)) return
      // Also ignore clicks on the trigger button itself — the parent
      // already toggles via its own onClick. We detect this by walking
      // up from `target` looking for either the legacy AmbientSidebar
      // testid (`app-actions-menu-button`) OR the generic
      // `data-app-actions-menu-button` attribute that the Apps-tab
      // trigger carries (it owns its own `apps-tab-row-${id}-actions`
      // testid for E2E selection, so we need a second discriminator
      // that does not collide with that per-row id). If either match,
      // the parent's onClick is the one that should toggle state and
      // we stay open until React re-renders us with `isOpen=false`.
      const triggerBtn = (target as Element).closest?.(
        '[data-testid="app-actions-menu-button"], [data-app-actions-menu-button]',
      )
      if (triggerBtn) return
      onClose()
    }

    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen, onClose])

  // Auto-focus the first menu item when the popover opens. requestAnimationFrame
  // delays the focus until after the popover is laid out, which avoids the
  // "focus moves but nothing visible yet" flash on slow renders.
  useEffect(() => {
    if (!isOpen) return
    const id = requestAnimationFrame(() => {
      exportItemRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // Keyboard navigation between menu items.
  function handleMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    )
    if (items.length === 0) return
    const activeIndex = items.findIndex((el) => el === document.activeElement)
    let next = activeIndex
    if (e.key === 'ArrowDown') next = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length
    if (e.key === 'ArrowUp') next = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length
    items[next]?.focus()
    e.preventDefault()
  }

  if (!isOpen) return null

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="app-actions-popover"
      onKeyDown={handleMenuKeyDown}
      className={`
        absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1 z-30
        bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-lg
        min-w-[180px] py-1
      `}
    >
      <button
        ref={exportItemRef}
        type="button"
        role="menuitem"
        data-testid="popover-action-export-recipe"
        onClick={() => {
          onClose()
          onSelectExport()
        }}
        className="
          w-full flex items-center gap-2 px-3 py-2 text-sm text-left
          text-[var(--text-secondary)]
          hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] outline-none
        "
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
          {/* Download / export icon (arrow into tray) */}
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {t('app.actions.exportRecipe')}
      </button>

      {source === 'bundled' || source === 'sample' ? (
        // Disable item -- non-destructive path for bundled /
        // grandfather sample apps. Rendered disabled (not omitted)
        // when the parent could not supply the recipe lineage
        // needed for `POST /api/recipes/sample/:recipeId/disable`,
        // so the action is visibly unavailable instead of silently
        // closing the popover with no effect. The destructive
        // "Remove app" item is intentionally never rendered for
        // these sources -- the parent should surface the
        // recipe-lineage recovery path elsewhere if disable cannot
        // be reached.
        <button
          type="button"
          role="menuitem"
          data-testid="popover-action-disable-app"
          onClick={
            onSelectDisable
              ? () => {
                  onClose()
                  onSelectDisable()
                }
              : undefined
          }
          disabled={!onSelectDisable}
          aria-disabled={!onSelectDisable}
          title={
            onSelectDisable ? undefined : t('appsTab.actions.disableError')
          }
          className="
            w-full flex items-center gap-2 px-3 py-2 text-sm text-left
            text-[var(--text-secondary)]
            hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] outline-none
            disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent
          "
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
            {/* Power-off / disable icon */}
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          {t('app.actions.disable')}
        </button>
      ) : source === null &&
        (manifestState === 'unreadable' ||
          manifestState === 'anomalous') ? (
        // Recovery / anomaly state: destructive Remove and
        // Disable are both suppressed because nothing about
        // this row can be trusted to route the action at the
        // right scope.
        //
        //   - `'unreadable'`: AppManifest file is on disk but
        //                     parse / schema failed. A stale
        //                     manifest collision could let
        //                     Remove delete the wrong subtree.
        //   - `'anomalous'` : the canonical `app/<appId>/`
        //                     directory failed the realpath
        //                     boundary check (symlink escape,
        //                     etc.). The on-disk target may
        //                     not even live under `app/`.
        //
        // Export remains available because it reads the on-
        // disk artifact tree directly via the canonical app
        // directory the server already validated. The
        // scanner-pipeline follow-up (recipe-history.jsonl
        // evidence join) closes the rest of the recovery flow;
        // tracked in the PR's Out-of-Scope list.
        null
      ) : (
        <button
          type="button"
          role="menuitem"
          data-testid="popover-action-remove-app"
          onClick={() => {
            onClose()
            onSelectRemoval()
          }}
          className="
            w-full flex items-center gap-2 px-3 py-2 text-sm text-left
            text-red-400
            hover:bg-red-500/10 hover:text-red-300
            focus:bg-red-500/10 focus:text-red-300 outline-none
          "
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
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
          {t('app.actions.removeApp')}
        </button>
      )}
    </div>
  )
}
