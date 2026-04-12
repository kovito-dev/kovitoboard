import { useState, type ReactNode } from 'react'

interface LayoutProps {
  nav: ReactNode
  sidebar: ReactNode | null
  children: ReactNode
  /** モバイル用: サイドバーオーバーレイを開閉するハンドラ */
  isMobileSidebarOpen?: boolean
  onCloseMobileSidebar?: () => void
}

export function Layout({ nav, sidebar, children, isMobileSidebarOpen, onCloseMobileSidebar }: LayoutProps) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* ナビメニュー: sm以下は非表示（BottomNavで代替） */}
      <div className="hidden md:flex">
        {nav}
      </div>

      {/* サイドバー: md以上は通常表示、sm以下はオーバーレイ */}
      {sidebar && (
        <>
          {/* デスクトップ: 通常のサイドバー */}
          <div className="hidden md:flex">
            {sidebar}
          </div>
          {/* モバイル: オーバーレイサイドバー */}
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
