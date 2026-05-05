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
  /** Callback for the "Remove app" menu item. */
  onSelectRemoval: () => void
}

export function AppActionsPopover({
  isOpen,
  onClose,
  onSelectExport,
  onSelectRemoval,
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
    </div>
  )
}
