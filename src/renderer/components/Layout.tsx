/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { type ReactNode } from 'react'

interface LayoutProps {
  nav: ReactNode
  sidebar: ReactNode | null
  children: ReactNode
  /**
   * Right-side ambient sidebar (DEC-020 / EU8). Rendered to the right of the
   * main content area on screens >= lg. Pass `null` to suppress (e.g. on the
   * Sessions page, which manages its own conversation surface).
   */
  rightSidebar?: ReactNode | null
  /** Mobile: handler to toggle sidebar overlay */
  isMobileSidebarOpen?: boolean
  onCloseMobileSidebar?: () => void
}

export function Layout({
  nav,
  sidebar,
  children,
  rightSidebar,
  isMobileSidebarOpen,
  onCloseMobileSidebar,
}: LayoutProps) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Nav menu: hidden on sm and below (replaced by BottomNav) */}
      <div className="hidden md:flex">
        {nav}
      </div>

      {/* Left sidebar: normal display on md+, overlay on sm and below */}
      {sidebar && (
        <>
          {/* Desktop: normal sidebar */}
          <div className="hidden md:flex">
            {sidebar}
          </div>
          {/* Mobile: overlay sidebar */}
          {isMobileSidebarOpen && (
            <div className="fixed inset-0 z-40 md:hidden">
              <div className="absolute inset-0 bg-black/50" onClick={onCloseMobileSidebar} />
              <div className="absolute left-0 top-0 bottom-0 w-72 bg-[var(--bg-surface)] shadow-2xl z-50 animate-slide-in">
                {sidebar}
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>

      {/*
       * Right ambient sidebar slot (DEC-020). Hidden below lg (< 1024px) per
       * spec §5.2 — mobile support is out of scope for v0.1.0.
       */}
      {rightSidebar && (
        <div className="hidden lg:flex shrink-0">
          {rightSidebar}
        </div>
      )}
    </div>
  )
}
