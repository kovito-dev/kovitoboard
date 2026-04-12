import { useState, useMemo } from 'react'
import type { SessionSummary, AgentConfig } from '../types'
import { STATUS_INDICATORS, relativeTime } from '../utils/format'
import { AgentAvatar } from './AgentAvatar'

type FilterMode = 'latest' | 'all'

interface SessionListProps {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** セッションID → エージェント定義ファイル名 のマップ */
  sessionAgentMap: Record<string, string>
  /** エージェント定義ファイル名 → AgentConfig のマップ */
  agentConfigs: Record<string, AgentConfig>
  /** デフォルトアシスタントのconfig */
  defaultAgentConfig: AgentConfig
  /** UIテーマ */
  theme?: 'dark' | 'light'
}

export function SessionList({ sessions, selectedId, onSelect, sessionAgentMap, agentConfigs, defaultAgentConfig, theme = 'dark' }: SessionListProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>('latest')

  // エージェントごとの最新セッションのみに絞り込み
  const filteredSessions = useMemo(() => {
    if (filterMode === 'all') return sessions

    // sessions は lastEventAt 降順（新しい順）で来る前提
    // 各エージェントの最初に出現するセッション = 最新セッション
    const seen = new Set<string>()
    return sessions.filter((s) => {
      const agentId = sessionAgentMap[s.id] || '_default'
      if (seen.has(agentId)) return false
      seen.add(agentId)
      return true
    })
  }, [sessions, sessionAgentMap, filterMode])

  return (
    <div className="w-full md:w-56 lg:w-64 bg-[var(--bg-surface)] border-r border-[var(--border)] flex flex-col overflow-hidden">
      {/* ヘッダー + フィルターボタン */}
      <div className="px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Sessions</h2>
          <span className="text-[10px] text-[var(--text-faint)]">{filteredSessions.length}</span>
        </div>
        <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
          <FilterButton
            label="最新"
            active={filterMode === 'latest'}
            onClick={() => setFilterMode('latest')}
          />
          <FilterButton
            label="すべて"
            active={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
          />
        </div>
      </div>

      {/* セッション一覧 */}
      <div className="flex-1 overflow-y-auto">
        {filteredSessions.map((s) => {
          const indicator = STATUS_INDICATORS[s.status] || STATUS_INDICATORS.idle
          const isSelected = s.id === selectedId
          const agentType = sessionAgentMap[s.id]
          const agentCfg = agentType && agentConfigs[agentType]
            ? agentConfigs[agentType]
            : defaultAgentConfig

          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)] transition-colors ${
                isSelected ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <div className="flex items-center gap-2">
                {/* アバター + ステータスドット */}
                <div className="relative shrink-0">
                  <AgentAvatar name={agentCfg.name} color={agentCfg.color} size={28} avatar={agentCfg.avatar} theme={theme} />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-surface)] ${indicator.dot}`} />
                </div>
                {/* セッション情報 */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-medium truncate" style={{ color: agentCfg.color }}>
                      {agentCfg.name}
                    </span>
                    <span className="text-[10px] text-[var(--text-faint)] shrink-0">{relativeTime(s.lastEventAt)}</span>
                  </div>
                  <span className="text-[11px] text-[var(--text-dim)] truncate block">{s.lastMessage || s.projectName}</span>
                </div>
              </div>
            </button>
          )
        })}
        {filteredSessions.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-[var(--text-faint)]">
            セッションが見つかりません
          </div>
        )}
      </div>
    </div>
  )
}

// --- フィルターボタン ---

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`
        flex-1 px-2 py-1 text-[11px] font-medium transition-colors
        ${active
          ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
          : 'bg-[var(--bg-nav)] text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]'
        }
      `}
    >
      {label}
    </button>
  )
}
