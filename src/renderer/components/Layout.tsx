import { useState, type ReactNode } from 'react'

interface LayoutProps {
  nav: ReactNode
  sidebar: ReactNode | null
  children: ReactNode
  /** Mobile: handler to toggle sidebar overlay */
  isMobileSidebarOpen?: boolean
  onCloseMobileSidebar?: () => void
}

export function Layout({ nav, sidebar, children, isMobileSidebarOpen, onCloseMobileSidebar }: LayoutProps) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Nav menu: hidden on sm and below (replaced by BottomNav) */}
      <div className="hidden md:flex">
        {nav}
      </div>

      {/* Sidebar: normal display on md+, overlay on sm and below */}
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
    </div>
  )
}
