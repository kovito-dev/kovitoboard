/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, type ReactNode } from 'react'

// --- Menu definition types ---

export interface MenuItemDef {
  id: string
  label: string
  icon: ReactNode
}

export interface MenuFolderDef {
  id: string
  label: string
  icon: ReactNode
  children: MenuItemDef[]
}

export type MenuEntry = MenuItemDef | MenuFolderDef

function isFolder(entry: MenuEntry): entry is MenuFolderDef {
  return 'children' in entry
}

// --- SVG icons ---
// Inline SVG icons usable without external dependencies

export const Icons = {
  /** Sessions (chat bubble) */
  sessions: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  /** Folder */
  folder: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  /** Settings (gear) */
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  /** Agents (person icon) */
  agents: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  /** Grid layout (kept as "dashboard" for backward compatibility with app menu.ts) */
  dashboard: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  /** Expand arrow */
  chevronRight: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  /** Collapse arrow */
  chevronDown: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  /** Seeds (sprout) */
  seeds: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V12" />
      <path d="M12 12C12 12 7 9 7 5c0-2 1.5-3 3-3 2 0 2 1 2 1s0-1 2-1c1.5 0 3 1 3 3 0 4-5 7-5 7z" />
    </svg>
  ),
  /** Content (pen/article) */
  content: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  /** Git (branch fork) */
  git: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <line x1="12" y1="8" x2="6" y2="16" />
      <line x1="12" y1="8" x2="18" y2="16" />
    </svg>
  ),
  /** Slides (presentation screen) */
  slides: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  /** Brands (shield) */
  brands: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  /** Dev room (code brackets) */
  devroom: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  /** Sidebar collapse (left double arrow) */
  collapseLeft: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  ),
  /** Sidebar expand (right double arrow) */
  expandRight: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </svg>
  ),
} as const

/** Look up an icon by string key, with fallback to 'folder' */
export function getIcon(key: string): ReactNode {
  return (Icons as Record<string, ReactNode>)[key] ?? Icons.folder
}

// --- Component ---

interface NavMenuProps {
  entries: MenuEntry[]
  /**
   * Currently active menu entry id, or `null` when the visible route
   * has no corresponding menu entry (e.g. the `/work-roots` deep-link
   * after the entry was folded into the Settings modal). `null` makes
   * the highlight collapse cleanly — the `entry.id === activeId`
   * comparison below evaluates to false for every entry, which is
   * exactly the desired UX for a route with no menu equivalent.
   */
  activeId: string | null
  onSelect: (id: string) => void
  /**
   * Compact (icon-only) mode. Controlled by the parent so the rail
   * wrapper can collapse its width and hide ProjectRootBanner in
   * sync. The collapse toggle below dispatches `onToggleCompact`.
   */
  compact: boolean
  onToggleCompact: () => void
  /**
   * Optional action buttons rendered above the menu entries. Used by
   * the v0.1.0 app removal flow to surface a "Remove app" button only
   * while the user is viewing an `/ext/<appId>` page (DEC-024 #3,
   * spec §4.1 option alpha). Pass `null` / `undefined` to suppress.
   *
   * Rendered without label decoration in compact mode; the slot is
   * responsible for compact-aware layout itself.
   */
  actionSlot?: ReactNode
}

export function NavMenu({ entries, activeId, onSelect, compact, onToggleCompact, actionSlot }: NavMenuProps) {
  // Manage folder open/close state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  // Check if the active item is within a folder (for folder highlighting)
  const isActiveInFolder = (folder: MenuFolderDef): boolean => {
    return folder.children.some((child) => child.id === activeId)
  }

  return (
    // Width is owned by the parent rail wrapper (see App.tsx nav
    // slot), which also drives the width transition. NavMenu itself
    // just stretches to fill the column.
    <div
      className={`
        w-full bg-[var(--bg-nav)] border-r border-[var(--border)] flex flex-col py-2 gap-1 flex-1 min-h-0
        ${compact ? 'items-center' : ''}
      `}
    >
      {/* Optional action slot (above the menu entries). Used by the
          v0.1.0 app removal flow — see `NavMenuProps.actionSlot`. */}
      {actionSlot && (
        <div
          data-testid="nav-menu-action-slot"
          className={`flex flex-col gap-0.5 px-1 pb-1 mb-1 border-b border-[var(--border)]/40 ${compact ? 'items-center' : ''}`}
        >
          {actionSlot}
        </div>
      )}

      {entries.map((entry) => {
        if (isFolder(entry)) {
          const isExpanded = expandedFolders.has(entry.id)
          const hasActiveChild = isActiveInFolder(entry)
          return (
            <div key={entry.id} className={`relative w-full flex flex-col ${compact ? 'items-center' : ''}`}>
              {/* Folder button */}
              <NavIconButton
                icon={entry.icon}
                label={entry.label}
                isActive={hasActiveChild}
                onClick={() => toggleFolder(entry.id)}
                compact={compact}
                badge={
                  <span className={`absolute bottom-0.5 right-0.5 text-[var(--text-dim)]`}>
                    {isExpanded ? Icons.chevronDown : Icons.chevronRight}
                  </span>
                }
              />
              {/* Child items within the folder */}
              {isExpanded && (
                <div className={`flex flex-col gap-0.5 mt-0.5 mb-1 ${compact ? 'items-center' : ''}`}>
                  {entry.children.map((child) => (
                    <NavIconButton
                      key={child.id}
                      icon={child.icon}
                      label={child.label}
                      isActive={child.id === activeId}
                      onClick={() => onSelect(child.id)}
                      isChild
                      compact={compact}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        }

        // Single menu item
        return (
          <NavIconButton
            key={entry.id}
            icon={entry.icon}
            label={entry.label}
            isActive={entry.id === activeId}
            onClick={() => onSelect(entry.id)}
            compact={compact}
          />
        )
      })}

      {/* Spacer at the bottom (allows settings etc. to be placed below in the future) */}
      <div className="flex-1" />

      {/* Compact toggle button */}
      <button
        onClick={onToggleCompact}
        title={compact ? 'Expand menu' : 'Collapse menu'}
        className="
          flex items-center justify-center w-full py-1.5
          text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]
          transition-colors border-t border-[var(--border)]
        "
      >
        {compact ? Icons.expandRight : Icons.collapseLeft}
      </button>
    </div>
  )
}

// --- Icon button ---

interface NavIconButtonProps {
  icon: ReactNode
  label: string
  isActive: boolean
  onClick: () => void
  badge?: ReactNode
  isChild?: boolean
  compact?: boolean
}

function NavIconButton({ icon, label, isActive, onClick, badge, isChild, compact }: NavIconButtonProps) {
  // Compact mode: icon only (legacy display)
  if (compact) {
    return (
      <button
        onClick={onClick}
        title={label}
        className={`
          relative flex items-center justify-center rounded-lg transition-colors
          ${isChild ? 'w-8 h-8' : 'w-10 h-10'}
          ${isActive
            ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
            : 'text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]'
          }
        `}
      >
        {isActive && !isChild && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--accent-border)] rounded-r" />
        )}
        <span className={isChild ? 'scale-75' : ''}>{icon}</span>
        {badge}
      </button>
    )
  }

  // Expanded mode: icon + label
  return (
    <button
      onClick={onClick}
      title={label}
      className={`
        relative flex items-center gap-2 rounded-lg transition-colors
        ${isChild ? 'h-8 pl-7 pr-2' : 'h-10 px-2.5'} w-full
        ${isActive
          ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
          : 'text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]'
        }
      `}
    >
      {isActive && !isChild && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--accent-border)] rounded-r" />
      )}
      <span className={`shrink-0 ${isChild ? 'scale-75' : ''}`}>{icon}</span>
      <span className="text-sm truncate">{label}</span>
      {badge}
    </button>
  )
}
