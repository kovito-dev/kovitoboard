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
   * grandfather sample apps render "Disable"; everything else
   * (self-made / import / url / `null` legacy) renders the
   * existing "Remove app".
   */
  source?: 'self-made' | 'bundled' | 'sample' | 'import' | 'url' | null
}

export function AppActionsPopover({
  isOpen,
  onClose,
  onSelectExport,
  onSelectRemoval,
  onSelectDisable,
  source,
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
      // up from `target` looking for the data attribute the button
      // carries; if found, the parent handles state and we stay open
      // until React re-renders us with `isOpen=false`.
      const triggerBtn = (target as Element).closest?.('[data-testid="app-actions-menu-button"]')
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
      className="
        absolute top-full left-0 mt-1 z-30
        bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-lg
        min-w-[180px] py-1
      "
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
      ) : source === null ? (
        // Recovery state: the AppManifest cannot be read and the
        // scanner could not recover the recipe lineage either, so
        // neither Disable nor Remove can be routed safely. The
        // destructive Remove path is intentionally omitted here
        // because a manifest-absent row whose appId collides with
        // a stale recipes-installed manifest must NOT be sent
        // through delete (data-preservation invariant). Export
        // remains available because it reads the on-disk artifact
        // tree directly. The bundled-partial-residue recovery
        // path is tracked as a deferred scanner-pipeline
        // follow-up (recipe-history.jsonl evidence join) in the
        // PR's Out-of-Scope list.
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
