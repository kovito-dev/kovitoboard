import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useIPC } from './hooks/useIPC'
import { useNavigationHistory, type NavState } from './hooks/useNavigationHistory'
import { useTheme } from './hooks/useTheme'
import { TitleBar, type AgentStatus } from './components/TitleBar'
import { Layout } from './components/Layout'
import { NavMenu, Icons, type MenuEntry } from './components/NavMenu'
import { SessionList } from './components/SessionList'
import { ChatTimeline } from './components/ChatTimeline'
import { AgentList } from './components/AgentList'
import { AgentDetail } from './components/AgentDetail'
import { SettingsModal } from './components/SettingsModal'
import { TrustPromptModal } from './components/TrustPromptModal'
import { WelcomeBanner } from './components/WelcomeBanner'
import { FilePreview } from './components/FilePreview'
import type { Session } from './types'

// --- メニュー定義 ---
// 新しいメニューを追加するにはここにエントリーを足すだけ
const menuEntries: MenuEntry[] = [
  {
    id: 'agents',
    label: 'エージェント',
    icon: Icons.agents,
  },
  {
    id: 'sessions',
    label: 'セッション',
    icon: Icons.sessions,
  },
]

const API_BASE = '/api'

export function App() {
  const { sessions, currentSession, selectedId, config, agents, sessionAgentMap, tmuxStatus, isLoading, selectSession, reloadCurrentSession, sendMessage, startNewSession, tmuxSend, tmuxClearAndSend, setSessionAgent, isSessionSendable, rollbackOptimisticMessage, currentTrustPrompt, respondTrustPromptChoice, respondTrustPromptRawKeys, dismissTrustPrompt } = useIPC()
  const { theme, toggleTheme } = useTheme()
  const [activeMenuId, setActiveMenuId] = useState('agents')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // インラインセッション管理: エージェント画面内でセッションを表示
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)
  const [inlineSession, setInlineSession] = useState<Session | null>(null)
  // 新規セッション開始待ち: どのエージェントのセッションを待機しているか
  const pendingAgentIdRef = useRef<string | null>(null)
  // 待機開始時に存在していたセッションIDセット（新規セッションのみをマッチさせるため）
  const pendingKnownSessionIdsRef = useRef<Set<string>>(new Set())
  // 新規セッション待機中フラグ（UIにパルスアニメーションを表示するため）
  const [isPendingNewSession, setIsPendingNewSession] = useState(false)
  // ファイルプレビュー管理
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  // 現在のメニューIDをrefで保持（useEffect内で最新値を参照するため）
  const activeMenuIdRef = useRef(activeMenuId)
  activeMenuIdRef.current = activeMenuId
  const selectedAgentIdRef = useRef(selectedAgentId)
  selectedAgentIdRef.current = selectedAgentId

  // --- ブラウザ戻る/進む対応 ---
  const { pushNavState } = useNavigationHistory({
    state: {
      activeMenuId,
      selectedSessionId: selectedId,
      selectedAgentId,
      inlineSessionId,
    },
    onRestore: useCallback((nav: NavState) => {
      setActiveMenuId(nav.activeMenuId)
      setSelectedAgentId(nav.selectedAgentId)
      setInlineSessionId(nav.inlineSessionId)
      setIsPendingNewSession(false) // 戻る/進む操作時は待機状態をリセット
      if (nav.selectedSessionId) {
        selectSession(nav.selectedSessionId)
      }
    }, [selectSession]),
  })

  // 選択中セッションに紐づくエージェントのconfigを取得
  const agentConfig = useMemo(() => {
    if (!config) return { name: 'デフォルト', color: '#A67B5B' }
    if (selectedId) {
      const agentType = sessionAgentMap[selectedId]
      if (agentType && agentType !== 'default' && config.agents[agentType]) {
        return config.agents[agentType]
      }
    }
    return config.agents.default || { name: 'デフォルト', color: '#A67B5B' }
  }, [config, selectedId, sessionAgentMap])
  const userConfig = config?.user || { name: 'User', color: '#7C3AED' }

  // インラインセッション用のエージェント config
  const inlineAgentConfig = useMemo(() => {
    if (!config || !inlineSessionId) return { name: 'デフォルト', color: '#A67B5B' }
    const agentType = sessionAgentMap[inlineSessionId] || selectedAgentId
    if (agentType && agentType !== 'default' && config.agents[agentType]) {
      return config.agents[agentType]
    }
    return config.agents.default || { name: 'デフォルト', color: '#A67B5B' }
  }, [config, inlineSessionId, sessionAgentMap, selectedAgentId])

  const projectName = config?.project?.name || 'KovitoBoard'
  const projectDescription = config?.project?.description

  // ブラウザタブのタイトルをプロジェクト名に設定
  useEffect(() => {
    document.title = projectName
  }, [projectName])

  // --- ヘッダー用: 各エージェントのアクティブ状態を算出（employee_id 昇順） ---
  const agentStatuses: AgentStatus[] = useMemo(() => {
    if (!config) return []
    // "default" はデフォルトアシスタント（ヘッダーには表示しない）
    const agentIds = Object.keys(config.agents).filter((id) => id !== 'default')
    const statuses = agentIds.map((agentId) => {
      // このエージェントの最新セッションが idle でなければアクティブ
      const agentSessions = sessions.filter((s) => sessionAgentMap[s.id] === agentId)
      const hasActiveSession = agentSessions.some((s) => s.status !== 'idle')
      return { agentId, hasActiveSession }
    })
    // agents データの employeeId で昇順ソート（未設定は末尾）
    statuses.sort((a, b) => {
      const agentA = agents.find((ag) => ag.id === a.agentId)
      const agentB = agents.find((ag) => ag.id === b.agentId)
      const numA = agentA?.employeeId ? parseInt(agentA.employeeId, 10) : Infinity
      const numB = agentB?.employeeId ? parseInt(agentB.employeeId, 10) : Infinity
      return numA - numB
    })
    return statuses
  }, [config, sessions, sessionAgentMap, agents])

  // --- ヘッダーのエージェントアイコンクリック ---
  const handleHeaderAgentClick = useCallback((agentId: string) => {
    // このエージェントのアクティブ（idle でない）セッションを探す
    const activeSessions = sessions
      .filter((s) => sessionAgentMap[s.id] === agentId && s.status !== 'idle')
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime())

    if (activeSessions.length > 0) {
      // アクティブなセッションがある → エージェント詳細画面内でインライン表示
      const targetSession = activeSessions[0]
      selectSession(targetSession.id)
      setActiveMenuId('agents')
      setSelectedAgentId(agentId)
      setInlineSessionId(targetSession.id)
      pushNavState({ activeMenuId: 'agents', selectedSessionId: targetSession.id, selectedAgentId: agentId, inlineSessionId: targetSession.id })
    } else {
      // アクティブなセッションがない → エージェント詳細画面を開く（そこから新規セッション開始できる）
      setActiveMenuId('agents')
      setSelectedAgentId(agentId)
      setInlineSessionId(null)
      pushNavState({ activeMenuId: 'agents', selectedSessionId: selectedId, selectedAgentId: agentId, inlineSessionId: null })
    }
  }, [sessions, sessionAgentMap, selectSession, selectedId, pushNavState])

  // エージェントに紐づくセッションをフィルタリング
  const agentSessions = useMemo(() => {
    if (!selectedAgentId) return []
    return sessions.filter((s) => sessionAgentMap[s.id] === selectedAgentId)
  }, [sessions, sessionAgentMap, selectedAgentId])

  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return null
    return agents.find((a) => a.id === selectedAgentId) || null
  }, [agents, selectedAgentId])

  // --- インラインセッション: フルデータ取得 ---
  useEffect(() => {
    if (!inlineSessionId) {
      setInlineSession(null)
      return
    }
    fetch(`${API_BASE}/sessions/${inlineSessionId}`)
      .then((res) => res.json())
      .then((data: Session) => setInlineSession(data))
      .catch(() => setInlineSession(null))
  }, [inlineSessionId])

  // --- インラインセッション: WebSocket のイベントで自動更新 ---
  useEffect(() => {
    if (!inlineSessionId || !inlineSession) return

    // sessions 一覧からステータスの変更を検知して反映
    const summary = sessions.find((s) => s.id === inlineSessionId)
    if (summary && summary.status !== inlineSession.status) {
      setInlineSession((prev) => prev ? { ...prev, status: summary.status as Session['status'] } : prev)
    }
  }, [sessions, inlineSessionId, inlineSession])

  // WebSocket の new_event をインラインセッションにも反映するため、
  // currentSession の更新をミラーする（selectedId === inlineSessionId の場合）
  useEffect(() => {
    if (inlineSessionId && currentSession && currentSession.id === inlineSessionId) {
      setInlineSession(currentSession)
    }
  }, [currentSession, inlineSessionId])

  // --- 新規セッション検出: sessions 一覧の変化を監視 ---
  useEffect(() => {
    const pendingAgentId = pendingAgentIdRef.current
    if (!pendingAgentId) return

    // 待機開始後に新しく現れたセッションを探す
    const unknownSessions = sessions.filter((s) => !pendingKnownSessionIdsRef.current.has(s.id))
    const newSession =
      unknownSessions.find((s) => sessionAgentMap[s.id] === pendingAgentId) ||
      unknownSessions.find((s) => !sessionAgentMap[s.id])

    if (newSession) {
      // agentId 未設定の場合（/clear で作成されたセッション）→ 手動設定
      if (!sessionAgentMap[newSession.id]) {
        setSessionAgent(newSession.id, pendingAgentId)
      }
      // 待機状態をクリア
      pendingAgentIdRef.current = null
      pendingKnownSessionIdsRef.current = new Set()
      setIsPendingNewSession(false)

      // Agents 画面にいる場合: 画面遷移せずインラインセッションとして表示
      if (activeMenuIdRef.current === 'agents' && selectedAgentIdRef.current) {
        setInlineSessionId(newSession.id)
        selectSession(newSession.id)
        pushNavState({ activeMenuId: 'agents', selectedSessionId: newSession.id, selectedAgentId: selectedAgentIdRef.current, inlineSessionId: newSession.id })
      } else {
        // その他の画面: Sessions 画面に遷移して表示
        setInlineSessionId(null)
        setSelectedAgentId(null)
        setActiveMenuId('sessions')
        selectSession(newSession.id)
        pushNavState({ activeMenuId: 'sessions', selectedSessionId: newSession.id, selectedAgentId: null, inlineSessionId: null })
      }
    }
  }, [sessions, sessionAgentMap, selectSession, pushNavState, setSessionAgent])

  // 新規セッション待機を開始するヘルパー
  const startPendingNewSession = useCallback((agentId: string) => {
    // 現在存在するセッションIDを記録（新規セッションのみをマッチさせるため）
    pendingKnownSessionIdsRef.current = new Set(sessions.map((s) => s.id))
    pendingAgentIdRef.current = agentId
    setIsPendingNewSession(true)
  }, [sessions])

  const handleAgentSelect = (agentId: string) => {
    setActiveMenuId('agents')
    setSelectedAgentId(agentId)
    setInlineSessionId(null)
    pushNavState({ activeMenuId: 'agents', selectedSessionId: selectedId, selectedAgentId: agentId, inlineSessionId: null })
  }

  // エージェント画面のセッション履歴からセッションを選択 → インライン表示
  const handleAgentSessionSelect = (sessionId: string) => {
    setInlineSessionId(sessionId)
    selectSession(sessionId)
    pushNavState({ activeMenuId: 'agents', selectedSessionId: sessionId, selectedAgentId, inlineSessionId: sessionId })
  }

  const handleAgentBack = () => {
    setSelectedAgentId(null)
    setInlineSessionId(null)
    pushNavState({ activeMenuId: 'agents', selectedSessionId: selectedId, selectedAgentId: null, inlineSessionId: null })
  }

  // インラインセッション表示を閉じてエージェント情報に戻る
  const handleCloseInlineSession = () => {
    setInlineSessionId(null)
    pushNavState({ activeMenuId: 'agents', selectedSessionId: selectedId, selectedAgentId, inlineSessionId: null })
  }

  // セッション一覧からセッション選択（pushState 付き）
  const handleSelectSession = useCallback((sessionId: string) => {
    selectSession(sessionId)
    setPreviewFilePath(null)
    pushNavState({ activeMenuId: 'sessions', selectedSessionId: sessionId, selectedAgentId: null, inlineSessionId: null })
  }, [selectSession, pushNavState])

  // セッションに紐づくtmuxウィンドウ名を解決
  const resolveTmuxWindow = useCallback((sessionId: string): string | null => {
    if (!tmuxStatus?.hasSession) return null
    const agentId = sessionAgentMap[sessionId]
    if (!agentId) return null
    const windowName = tmuxStatus.agentWindowMap?.[agentId]
    if (!windowName) return null
    const window = tmuxStatus.windows.find((w) => w.name === windowName)
    return window ? window.name : null
  }, [tmuxStatus, sessionAgentMap])

  // セッションにメッセージ送信（tmux経由）
  const handleSendMessage = async (sessionId: string, message: string) => {
    const windowName = resolveTmuxWindow(sessionId)
    if (windowName) {
      // idle セッションへのtmux送信は新セッションが作られるため、検出待機を開始
      const session = sessions.find((s) => s.id === sessionId)
      const agentId = sessionAgentMap[sessionId]
      if (session?.status === 'idle' && agentId) {
        startPendingNewSession(agentId)
      }
      // sessionId を渡してオプティミスティックUI表示
      await tmuxSend(windowName, message, sessionId)
    } else {
      // tmux未接続の場合はCLI直接起動にフォールバック（内部でオプティミスティックUI処理済み）
      await sendMessage(sessionId, message)
    }
  }

  // 送信失敗時のロールバック
  const handleSendError = useCallback((sessionId: string) => {
    return (_error: Error) => {
      rollbackOptimisticMessage(sessionId)
    }
  }, [rollbackOptimisticMessage])

  // エージェントで新規セッション開始
  const handleStartNewSession = async (agentId: string, message: string) => {
    // 既存のアクティブセッションを即座に idle に変更
    try {
      await fetch(`/api/agents/${agentId}/deactivate-sessions`, { method: 'POST' })
    } catch {
      // deactivate 失敗してもセッション開始は続行
    }

    // tmuxウィンドウが存在すればそこに送信
    if (tmuxStatus?.hasSession) {
      const windowName = tmuxStatus.agentWindowMap?.[agentId]
      if (windowName) {
        const window = tmuxStatus.windows.find((w) => w.name === windowName)
        if (window) {
          // tmux 経由: /clear で既存セッションを終了してから新規メッセージ送信
          startPendingNewSession(agentId)
          await tmuxClearAndSend(windowName, message)
          return
        }
      }
    }
    // フォールバック: CLI直接起動
    startPendingNewSession(agentId)
    await startNewSession(message, agentId)
  }

  // メニューに応じたサイドバーの中身を決定
  const renderSidebar = () => {
    switch (activeMenuId) {
      case 'sessions':
        return (
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            onSelect={handleSelectSession}
            sessionAgentMap={sessionAgentMap}
            agentConfigs={config?.agents || {}}
            defaultAgentConfig={config?.agents.default || { name: 'デフォルト', color: '#A67B5B' }}
            theme={theme}
          />
        )
      case 'agents':
        // サイドバー不要、メインエリアに表示
        return null
      default:
        return (
          <div className="w-64 bg-[var(--bg-surface)] border-r border-[var(--border)] flex items-center justify-center">
            <span className="text-xs text-[var(--text-dim)]">準備中</span>
          </div>
        )
    }
  }

  // メニューに応じたメインコンテンツを決定
  const renderMainContent = () => {
    switch (activeMenuId) {
      case 'sessions': {
        const currentAgentId = selectedId ? sessionAgentMap[selectedId] : undefined
        if (currentSession) {
          return (
            <div className="flex-1 flex flex-row overflow-hidden">
              <ChatTimeline
                session={currentSession}
                agentConfig={agentConfig}
                userConfig={userConfig}
                onSendMessage={selectedId && (isSessionSendable(selectedId) || (currentSession && currentSession.status !== 'idle')) ? handleSendMessage : undefined}
                onReload={reloadCurrentSession}
                onStartNewTopic={currentAgentId ? handleStartNewSession : undefined}
                agentId={currentAgentId}
                isPendingNewSession={isPendingNewSession}
                onContinueSession={currentAgentId ? handleStartNewSession : undefined}
                onFilePathClick={(path) => setPreviewFilePath(path)}
                onSendError={selectedId ? handleSendError(selectedId) : undefined}
                theme={theme}
              />
              {previewFilePath && (
                <FilePreview
                  filePath={previewFilePath}
                  onClose={() => setPreviewFilePath(null)}
                />
              )}
            </div>
          )
        }
        return (
          <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-sm">
            セッションを選択してください
          </div>
        )
      }
      case 'agents':
        if (selectedAgent) {
          return (
            <AgentDetail
              agent={selectedAgent}
              sessions={agentSessions}
              inlineSession={inlineSession}
              agentConfig={inlineAgentConfig}
              userConfig={userConfig}
              onBack={handleAgentBack}
              onSelectSession={handleAgentSessionSelect}
              onStartNewSession={handleStartNewSession}
              onSendMessage={handleSendMessage}
              onCloseInlineSession={handleCloseInlineSession}
              isSessionSendable={isSessionSendable}
              isPendingNewSession={isPendingNewSession}
              theme={theme}
            />
          )
        }
        if (sessions.length === 0) {
          // 初回起動時: ウェルカムバナー表示
          const projectName = config?.project?.name || 'KovitoBoard'
          const conceptVal = config?.project?.concept || null
          const agentList = config?.agents
            ? Object.entries(config.agents)
                .filter(([id]) => id !== 'default')
                .map(([, cfg]) => ({
                  name: cfg.name,
                  role: '',
                  summary: cfg.summary || '',
                }))
            : []
          const secretaryEntry = config?.agents
            ? Object.entries(config.agents).find(([id]) => id !== 'default')
            : null
          const secName = secretaryEntry ? secretaryEntry[1].name : '秘書'
          const secId = secretaryEntry ? secretaryEntry[0] : ''

          return (
            <WelcomeBanner
              projectName={projectName}
              concept={conceptVal || null}
              agents={agentList}
              secretaryName={secName}
              onNavigateToAgents={() => handleAgentSelect(secId)}
            />
          )
        }
        return <AgentList agents={agents} onSelectAgent={handleAgentSelect} theme={theme} />
      default:
        return (
          <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-sm">
            このメニューは準備中です
          </div>
        )
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)]">
      <TitleBar
        projectName={projectName}
        projectDescription={projectDescription}
        agentConfigs={config?.agents || {}}
        agentStatuses={agentStatuses}
        onAgentClick={handleHeaderAgentClick}
        onOpenSettings={() => setIsSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[var(--text-dim)] text-sm">セッションを読み込み中...</div>
        </div>
      ) : (
        <>
        <Layout
          nav={
            <NavMenu
              entries={menuEntries}
              activeId={activeMenuId}
              onSelect={(id) => {
                setActiveMenuId(id)
                // メニュー切り替え時に選択状態をリセット
                if (id !== 'agents') {
                  setSelectedAgentId(null)
                  setInlineSessionId(null)
                }
                pushNavState({ activeMenuId: id, selectedSessionId: selectedId, selectedAgentId: id === 'agents' ? selectedAgentId : null, inlineSessionId: null })
              }}
            />
          }
          sidebar={renderSidebar()}
          isMobileSidebarOpen={isMobileSidebarOpen}
          onCloseMobileSidebar={() => setIsMobileSidebarOpen(false)}
        >
          {renderMainContent()}
        </Layout>

        {/* モバイル用ボトムナビ */}
        <div className="md:hidden shrink-0 bg-[var(--bg-nav)] border-t border-[var(--border)] flex items-center justify-around py-1.5 px-2">
          {menuEntries.map((entry) => {
            const isActive = activeMenuId === entry.id
            return (
              <button
                key={entry.id}
                onClick={() => {
                  setActiveMenuId(entry.id)
                  if (entry.id !== 'agents') {
                    setSelectedAgentId(null)
                    setInlineSessionId(null)
                  }
                  // Sessions メニューの場合はサイドバーをトグル
                  if (entry.id === 'sessions' && activeMenuId === 'sessions') {
                    setIsMobileSidebarOpen((v) => !v)
                  } else {
                    setIsMobileSidebarOpen(false)
                  }
                  pushNavState({ activeMenuId: entry.id, selectedSessionId: selectedId, selectedAgentId: entry.id === 'agents' ? selectedAgentId : null, inlineSessionId: null })
                }}
                className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors ${
                  isActive
                    ? 'text-[var(--accent-text)]'
                    : 'text-[var(--text-dim)]'
                }`}
              >
                <span className="w-5 h-5">{entry.icon}</span>
                <span className="text-[10px]">{entry.label}</span>
              </button>
            )
          })}
        </div>
        </>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* 信頼プロンプト中継モーダル（Phase 5c / 5d） */}
      <TrustPromptModal
        item={currentTrustPrompt}
        onChoice={(choiceId) => {
          if (!currentTrustPrompt) return
          respondTrustPromptChoice(
            currentTrustPrompt.payload.promptId,
            currentTrustPrompt.payload.windowName,
            choiceId,
          )
        }}
        onRawKeys={(rawKeys) => {
          if (!currentTrustPrompt) return
          respondTrustPromptRawKeys(
            currentTrustPrompt.payload.promptId,
            currentTrustPrompt.payload.windowName,
            rawKeys,
          )
        }}
        onDismiss={() => {
          if (!currentTrustPrompt) return
          dismissTrustPrompt(currentTrustPrompt.payload.promptId)
        }}
      />
    </div>
  )
}
