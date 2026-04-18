import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface AgentListProps {
  agents: AgentInfo[]
  onSelectAgent: (agentId: string) => void
  /** 新規エージェント追加ボタンのクリックハンドラ */
  onAddAgent?: () => void
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

export function AgentList({ agents, onSelectAgent, onAddAgent, theme = 'dark' }: AgentListProps) {
  const sortedAgents = sortByEmployeeId(agents)

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* ヘッダー */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-secondary)]">エージェント</h2>
          <p className="text-sm text-[var(--text-dim)] mt-1">
            {agents.length} エージェントが登録されています
          </p>
        </div>
        {onAddAgent && (
          <button
            onClick={onAddAgent}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 transition-opacity shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            追加
          </button>
        )}
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
        <div className="max-w-lg mx-auto mt-12">
          <div className="bg-[var(--bg-elevated)] rounded-xl border border-[var(--border)] p-6 space-y-5">
            {/* Icon + heading */}
            <div className="text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-[var(--text-faint)]">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <h3 className="text-base font-semibold text-[var(--text-secondary)]">エージェントが見つかりません</h3>
              <p className="text-sm text-[var(--text-dim)] mt-1">
                <code className="text-xs bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">.claude/agents/</code> にエージェント定義ファイルを配置してください
              </p>
            </div>

            {/* Steps */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-[var(--text-tertiary)]">作成手順</h4>
              <ol className="space-y-2 text-sm text-[var(--text-muted)]">
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">1</span>
                  <span>プロジェクトルートに <code className="text-xs bg-[var(--bg-surface)] px-1 py-0.5 rounded">.claude/agents/</code> ディレクトリを作成</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">2</span>
                  <span>Markdown ファイルを作成（例: <code className="text-xs bg-[var(--bg-surface)] px-1 py-0.5 rounded">my-agent.md</code>）</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">3</span>
                  <span>YAML フロントマターで name と description を定義</span>
                </li>
              </ol>
            </div>

            {/* Template example */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-[var(--text-tertiary)]">テンプレート例</h4>
              <pre className="text-xs text-[var(--text-muted)] bg-[var(--bg-surface)] rounded-lg p-4 overflow-x-auto border border-[var(--border)]">
{`---
name: my-agent
description: "Your agent description"
model: sonnet
---

# My Agent

Your agent's system prompt goes here.`}
              </pre>
            </div>

            <p className="text-xs text-[var(--text-faint)] text-center">
              ファイルを配置したら KovitoBoard を再起動してください
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
