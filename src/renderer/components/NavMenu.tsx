import { useState, type ReactNode } from 'react'

// --- メニュー定義の型 ---

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

// --- SVG アイコン ---
// 依存ライブラリなしで使えるインラインSVGアイコン

export const Icons = {
  /** セッション一覧 (チャットバブル) */
  sessions: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  /** フォルダ */
  folder: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  /** 設定 (歯車) */
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  /** エージェント (人型) */
  agents: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  /** ダッシュボード (グリッド) */
  dashboard: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  /** 展開矢印 */
  chevronRight: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  /** 折りたたみ矢印 */
  chevronDown: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  /** Seeds (芽吹き) */
  seeds: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V12" />
      <path d="M12 12C12 12 7 9 7 5c0-2 1.5-3 3-3 2 0 2 1 2 1s0-1 2-1c1.5 0 3 1 3 3 0 4-5 7-5 7z" />
    </svg>
  ),
  /** コンテンツ (ペン・記事) */
  content: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  /** Git (ブランチ分岐) */
  git: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <line x1="12" y1="8" x2="6" y2="16" />
      <line x1="12" y1="8" x2="18" y2="16" />
    </svg>
  ),
  /** スライド (プレゼンテーション画面) */
  slides: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  /** ブランド (シールド) */
  brands: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  /** 開発室 (コードブラケット) */
  devroom: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  /** サイドバー折りたたみ（左向き二重矢印） */
  collapseLeft: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  ),
  /** サイドバー展開（右向き二重矢印） */
  expandRight: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </svg>
  ),
} as const

// --- コンポーネント ---

interface NavMenuProps {
  entries: MenuEntry[]
  activeId: string
  onSelect: (id: string) => void
}

export function NavMenu({ entries, activeId, onSelect }: NavMenuProps) {
  // コンパクトモード（アイコンのみ）の状態管理。デフォルトは展開
  const [compact, setCompact] = useState(false)
  // フォルダの開閉状態を管理
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

  // アクティブなアイテムがフォルダ内にあるかチェック（フォルダのハイライト用）
  const isActiveInFolder = (folder: MenuFolderDef): boolean => {
    return folder.children.some((child) => child.id === activeId)
  }

  return (
    <div
      className={`
        ${compact ? 'w-12' : 'w-40'}
        bg-[var(--bg-nav)] border-r border-[var(--border)] flex flex-col py-2 gap-1 shrink-0
        transition-[width] duration-200
        ${compact ? 'items-center' : ''}
      `}
    >
      {entries.map((entry) => {
        if (isFolder(entry)) {
          const isExpanded = expandedFolders.has(entry.id)
          const hasActiveChild = isActiveInFolder(entry)
          return (
            <div key={entry.id} className={`relative w-full flex flex-col ${compact ? 'items-center' : ''}`}>
              {/* フォルダボタン */}
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
              {/* フォルダ内の子アイテム */}
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

        // 単体メニューアイテム
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

      {/* 下部にスペーサーを入れて、将来的に設定等を下に配置可能にする */}
      <div className="flex-1" />

      {/* コンパクト切り替えボタン */}
      <button
        onClick={() => setCompact((prev) => !prev)}
        title={compact ? 'メニューを展開' : 'メニューを折りたたむ'}
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

// --- アイコンボタン ---

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
  // コンパクトモード: アイコンのみ（従来の表示）
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

  // 展開モード: アイコン + ラベル
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
