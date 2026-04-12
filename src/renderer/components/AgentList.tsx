import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface AgentListProps {
  agents: AgentInfo[]
  onSelectAgent: (agentId: string) => void
  /** UIテーマ */
  theme?: 'dark' | 'light'
}

/** モデル名を短縮表示 */
function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

/** employee_id の数値昇順でソート（未設定は末尾） */
function sortByEmployeeId(agents: AgentInfo[]): AgentInfo[] {
  return [...agents].sort((a, b) => {
    const aNum = a.employeeId ? parseInt(a.employeeId, 10) : Infinity
    const bNum = b.employeeId ? parseInt(b.employeeId, 10) : Infinity
    return aNum - bNum
  })
}

export function AgentList({ agents, onSelectAgent, theme = 'dark' }: AgentListProps) {
  const sortedAgents = sortByEmployeeId(agents)

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* ヘッダー */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-[var(--text-secondary)]">エージェント</h2>
        <p className="text-sm text-[var(--text-dim)] mt-1">
          {agents.length} エージェントが登録されています
        </p>
      </div>

      {/* エージェントカードグリッド */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedAgents.map((agent) => (
          <button
            key={agent.id}
            onClick={() => onSelectAgent(agent.id)}
            className="group text-left rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-[var(--accent-shadow)]"
          >
            {/* カード上部: グラデーション背景 */}
            <div
              className="px-5 pt-5 pb-4 relative"
              style={{
                background: `linear-gradient(135deg, ${agent.color}22, ${agent.color}08)`
              }}
            >
              {/* アクティブバッジ */}
              {agent.activeSessionCount > 0 && (
                <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-green-500/20 text-green-400 text-[10px] font-medium px-2 py-0.5 rounded-full">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  Active
                </div>
              )}

              {/* アバター + 名前 */}
              <div className="flex items-center gap-3 mb-3">
                <AgentAvatar name={agent.displayName} color={agent.color} size={64} avatar={agent.avatar} agentId={agent.id} theme={theme} />
                <div className="min-w-0">
                  <div className="text-base font-semibold text-[var(--text-primary)] group-hover:text-white transition-colors">
                    {agent.displayName}
                  </div>
                  {agent.origin && (
                    <div className="text-xs text-[var(--text-dim)] truncate">{agent.origin}</div>
                  )}
                </div>
              </div>

              {/* ロール */}
              {agent.role && (
                <div
                  className="inline-block text-xs font-medium px-2.5 py-1 rounded-full mb-2"
                  style={{
                    backgroundColor: `${agent.color}25`,
                    color: agent.color,
                    borderWidth: 1,
                    borderColor: `${agent.color}30`
                  }}
                >
                  {agent.role}
                </div>
              )}
            </div>

            {/* カード下部: 詳細情報 */}
            <div className="px-5 py-4 bg-[var(--bg-elevated)] border-t border-[var(--border)] group-hover:bg-[var(--bg-hover)] transition-colors">
              {/* サマリー（viewer.config.json から） */}
              {agent.summary && (
                <p className="text-xs text-[var(--text-tertiary)] mb-2 font-medium leading-relaxed">
                  {agent.summary}
                </p>
              )}
              {/* 説明文（2行まで） */}
              <p className="text-xs text-[var(--text-muted)] mb-3 line-clamp-2 leading-relaxed">
                {agent.description}
              </p>

              {/* 統計バー */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* モデル */}
                  <div className="flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-faint)]">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                    <span className="text-[11px] text-[var(--text-dim)]">{shortModel(agent.model)}</span>
                  </div>

                  {/* セッション数 */}
                  <div className="flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-faint)]">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="text-[11px] text-[var(--text-dim)]">{agent.totalSessionCount} sessions</span>
                  </div>
                </div>

                {/* 矢印 */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-faint)] group-hover:text-[var(--text-muted)] transition-colors">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </div>
          </button>
        ))}
      </div>

      {agents.length === 0 && (
        <div className="text-center text-[var(--text-dim)] mt-16">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-4 text-[var(--text-faint)]">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <p className="text-sm">エージェントが見つかりません</p>
          <p className="text-xs text-[var(--text-faint)] mt-1">.claude/agents/ にエージェント定義ファイルを配置してください</p>
        </div>
      )}
    </div>
  )
}
