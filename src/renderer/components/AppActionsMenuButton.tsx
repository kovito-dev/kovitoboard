/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * AppActionsMenuButton — the `⋯` trigger that toggles `AppActionsPopover`.
 *
 * Sits inside the AmbientSidebar's toggle row when an app screen is in
 * focus. The popover this button opens contains the app-scoped actions
 * (export recipe / remove app) that used to live as a top-level
 * NavMenu actionSlot button (DEC-024 #5 / spec §F1, §F4).
 */
import { forwardRef } from 'react'
import { t } from '../i18n'

interface AppActionsMenuButtonProps {
  appId: string
  isOpen: boolean
  onToggle: () => void
}

export const AppActionsMenuButton = forwardRef<HTMLButtonElement, AppActionsMenuButtonProps>(
  function AppActionsMenuButton({ appId, isOpen, onToggle }, ref) {
    const label = t('nav.action.appActions')
    return (
      <button
        ref={ref}
        type="button"
        data-testid="app-actions-menu-button"
        data-app-id={appId}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={label}
        aria-label={label}
        onClick={onToggle}
        className="
          flex items-center justify-center w-8 h-8 rounded
          text-[var(--text-dim)] hover:text-[var(--text-tertiary)]
          hover:bg-[var(--bg-elevated)] transition-colors
        "
      >
        {/* Horizontal ellipsis (⋯). Inline SVG so the icon weight
            stays consistent with the toggle button next to it. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="19" cy="12" r="1.4" />
        </svg>
      </button>
    )
  },
)
