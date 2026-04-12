import { useState, useEffect } from 'react'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

// --- 型定義 ---

interface BasicSettings {
  projectName: string
  description: string
  concept: string
  userName: string
  language: string
  agents: { id: string; name: string; role: string; employeeId?: string }[]
}

interface SkillInfo {
  name: string
  description: string
  category: 'operation' | 'procedure' | 'knowledge'
  invocation: string
}

interface HookInfo {
  event: string
  type: string
  command: string
}

interface IntegrationInfo {
  name: string
  type: string
  status: string
}

interface RuleInfo {
  name: string
  content: string
}

type TabId = 'basic' | 'skills' | 'automations' | 'integrations' | 'rules'

const TABS: { id: TabId; label: string }[] = [
  { id: 'basic', label: '基本設定' },
  { id: 'skills', label: 'スキル' },
  { id: 'automations', label: '自動処理' },
  { id: 'integrations', label: '外部連携' },
  { id: 'rules', label: 'ルール' },
]

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('basic')

  // ESC キーで閉じる
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* オーバーレイ */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* モーダル本体 */}
      <div className="relative w-full max-w-4xl mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden h-full md:h-[85vh]">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-secondary)] flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            設定
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* タブバー */}
        <div className="flex gap-0 px-3 md:px-6 border-b border-[var(--border)] overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-4 py-3 text-sm font-medium border-b-2 transition-colors
                ${activeTab === tab.id
                  ? 'border-[var(--accent-border)] text-[var(--accent-text)]'
                  : 'border-transparent text-[var(--text-dim)] hover:text-[var(--text-tertiary)]'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* タブコンテンツ */}
        <div className="flex-1 overflow-y-auto p-3 md:p-6">
          {activeTab === 'basic' && <SettingsBasic />}
          {activeTab === 'skills' && <SettingsSkills />}
          {activeTab === 'automations' && <SettingsAutomations />}
          {activeTab === 'integrations' && <SettingsIntegrations />}
          {activeTab === 'rules' && <SettingsRules />}
        </div>
      </div>
    </div>
  )
}

// --- ヘルプアイコン ---

function HelpTip({ text }: { text: string }) {
  const [show, setShow] = useState(false)

  return (
    <span className="relative inline-block ml-2">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(!show)}
        className="text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {show && (
        <span className="absolute z-10 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-[var(--text-tertiary)] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg shadow-lg whitespace-nowrap">
          {text}
        </span>
      )}
    </span>
  )
}

// --- 基本設定タブ ---

function SettingsBasic() {
  const [data, setData] = useState<BasicSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings/basic')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />
  if (!data) return <ErrorMessage message="基本設定の読み取りに失敗しました" />

  return (
    <div className="space-y-6">
      {/* 基本情報 */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">基本情報</h3>
        <div className="space-y-3">
          <SettingRow
            label="プロジェクト名"
            value={data.projectName || '未設定'}
            helpText="秘書に「プロジェクト名を変更して」と依頼"
          />
          <SettingRow
            label="説明"
            value={data.description || '未設定'}
            helpText="秘書に「説明を変更して」と依頼"
          />
          <SettingRow
            label="システムコンセプト"
            value={data.concept || '未設定'}
            helpText="秘書に「コンセプトを設定して」と依頼"
            highlight={!data.concept}
          />
          <SettingRow
            label="呼び名"
            value={data.userName || '未設定'}
            helpText="秘書に「呼び名を変更して」と依頼"
          />
          <SettingRow
            label="使用言語"
            value={data.language}
            helpText="秘書に「使用言語を変更して」と依頼"
          />
        </div>
      </div>

      {/* エージェント一覧 */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">エージェント一覧</h3>
        {data.agents.length > 0 ? (
          <div className="space-y-2">
            {data.agents.map((agent) => (
              <div key={agent.id} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                <div>
                  <span className="text-sm text-[var(--text-secondary)] font-medium">{agent.name}</span>
                  {agent.employeeId && (
                    <span className="ml-2 text-[10px] text-[var(--text-faint)] font-mono">#{agent.employeeId}</span>
                  )}
                </div>
                <span className="text-xs text-[var(--text-dim)]">{agent.role}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-dim)]">エージェントが見つかりません</p>
        )}
      </div>

      {/* フッター */}
      <div className="text-center text-xs text-[var(--text-faint)] py-2">
        設定の変更はAgents画面から秘書に依頼してください
      </div>
    </div>
  )
}

function SettingRow({ label, value, helpText, highlight }: {
  label: string
  value: string
  helpText: string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
      <span className="text-xs text-[var(--text-dim)]">{label}</span>
      <div className="flex items-center">
        <span className={`text-sm ${highlight ? 'text-yellow-400/70' : 'text-[var(--text-tertiary)]'}`}>
          {value}
        </span>
        <HelpTip text={helpText} />
      </div>
    </div>
  )
}

// --- スキルタブ ---

function SettingsSkills() {
  const [data, setData] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings/skills')
      .then((r) => r.json())
      .then((res) => setData(res.skills || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  const categoryLabel: Record<string, string> = {
    operation: '操作系',
    procedure: '手順系',
    knowledge: '知識系',
  }
  const categoryColor: Record<string, string> = {
    operation: 'bg-red-500/20 text-red-400',
    procedure: 'bg-blue-500/20 text-blue-400',
    knowledge: 'bg-green-500/20 text-green-400',
  }

  return (
    <div className="space-y-3">
      {data.length > 0 ? (
        data.map((skill) => (
          <div key={skill.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{skill.name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${categoryColor[skill.category] || ''}`}>
                {categoryLabel[skill.category] || skill.category}
              </span>
              <span className="text-xs text-[var(--text-faint)] font-mono ml-auto">{skill.invocation}</span>
            </div>
            <p className="text-xs text-[var(--text-muted)]">{skill.description}</p>
          </div>
        ))
      ) : (
        <EmptyState
          message="スキルはまだ登録されていません"
          hint="秘書に「ブリーフィングスキルを追加して」と話しかけてください"
        />
      )}
    </div>
  )
}

// --- 自動処理タブ ---

function SettingsAutomations() {
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings/automations')
      .then((r) => r.json())
      .then((res) => setHooks(res.hooks || []))
      .catch(() => setHooks([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div className="space-y-6">
      {/* Hooks */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-3">Hooks</h3>
        {hooks.length > 0 ? (
          <div className="space-y-2">
            {hooks.map((hook, i) => (
              <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-badge-bg)] text-[var(--accent-text-vivid)]">
                    {hook.event}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-dim)] font-mono truncate">{hook.command}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-dim)]">Hooks は設定されていません</p>
        )}
      </div>

      {/* Cron */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-3">スケジュール</h3>
        <EmptyState
          message="自動処理スケジュールはまだありません"
        />
      </div>
    </div>
  )
}

// --- 外部連携タブ ---

function SettingsIntegrations() {
  const [data, setData] = useState<IntegrationInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings/integrations')
      .then((r) => r.json())
      .then((res) => setData(res.integrations || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div>
      {data.length > 0 ? (
        <div className="space-y-2">
          {data.map((item) => (
            <div key={item.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--text-secondary)]">{item.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                    {item.type.toUpperCase()}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                    {item.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          message="外部連携はまだ設定されていません"
          hint="秘書に「Chatworkと連携したい」と話しかけてください"
        />
      )}
    </div>
  )
}

// --- ルールタブ ---

function SettingsRules() {
  const [data, setData] = useState<RuleInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings/rules')
      .then((r) => r.json())
      .then((res) => setData(res.rules || res || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />

  return (
    <div>
      {data.length > 0 ? (
        <div className="space-y-2">
          {data.map((rule) => (
            <div key={rule.name} className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border)]">
              <h4 className="text-sm font-medium text-[var(--text-secondary)] mb-2">{rule.name}</h4>
              <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap line-clamp-4">{rule.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          message="ルールはまだ設定されていません"
          hint="秘書に「コミットメッセージは日本語で書くルールを追加して」と話しかけてください"
        />
      )}
    </div>
  )
}

// --- 共通コンポーネント ---

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-6 h-6 border-2 border-gray-600 border-t-[var(--accent-border)] rounded-full animate-spin" />
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-red-400 text-sm">
      {message}
    </div>
  )
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="bg-[var(--bg-elevated)] rounded-xl p-6 border border-[var(--border)] text-center">
      <p className="text-sm text-[var(--text-dim)]">{message}</p>
      {hint && (
        <p className="text-xs text-[var(--text-faint)] mt-2">{hint}</p>
      )}
    </div>
  )
}
