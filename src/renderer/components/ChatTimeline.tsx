import { useEffect, useRef, useState, useCallback } from 'react'
import type { Session, AgentConfig, ParsedEvent } from '../types'
import { MessageBubble } from './MessageBubble'
import { MessageInput } from './MessageInput'
import { eventsToMarkdown, copyToClipboard, buildContinueSessionMessage } from '../utils/format'

type ViewMode = 'summary' | 'detail'
type NewTopicState = 'idle' | 'input' | 'sending'

/**
 * システム注入コンテンツのみで構成されたユーザーメッセージを判定する
 * パーサーではなく表示層でフィルタすることで、データを安全に保持しつつ表示を制御する
 */
const SYSTEM_ONLY_PATTERNS = [
  /^<local-command-caveat>[\s\S]*$/,
  /^<command-name>[\s\S]*$/,
  /^<local-command-stdout>[\s\S]*$/,
  /^<task-notification>[\s\S]*<\/task-notification>\s*$/,
  /^This session is being continued from a previous conversation/,
]

function isSystemOnlyMessage(event: ParsedEvent): boolean {
  if (event.type !== 'user') return false
  const text = event.content.text
  if (!text) return false
  return SYSTEM_ONLY_PATTERNS.some((p) => p.test(text.trim()))
}

interface ChatTimelineProps {
  session: Session
  agentConfig: AgentConfig
  userConfig: AgentConfig
  onSendMessage?: (sessionId: string, message: string) => Promise<void>
  onReload?: () => void
  /** 新しい話題でセッションを開始するコールバック（agentId, message） */
  onStartNewTopic?: (agentId: string, message: string) => Promise<void>
  /** 現在のセッションに紐づくエージェントID */
  agentId?: string
  /** 新規セッション待機中フラグ */
  isPendingNewSession?: boolean
  /** セッション引き継ぎで新規セッションを開始するコールバック（agentId, message） */
  onContinueSession?: (agentId: string, message: string) => Promise<void>
  /** ファイルパスクリック時のコールバック */
  onFilePathClick?: (path: string) => void
  /** メッセージからタスク追加するコールバック */
  onAddTask?: (messageText: string) => void
  /** 送信失敗時のコールバック（オプティミスティックメッセージのロールバック用） */
  onSendError?: (error: Error) => void
  /** UIテーマ */
  theme?: 'dark' | 'light'
}

export function ChatTimeline({ session, agentConfig, userConfig, onSendMessage, onReload, onStartNewTopic, agentId, isPendingNewSession, onContinueSession, onFilePathClick, onAddTask, onSendError, theme = 'dark' }: ChatTimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const [viewMode, setViewMode] = useState<ViewMode>('summary')
  const [isSending, setIsSending] = useState(false)
  const [allCopied, setAllCopied] = useState(false)
  const [newTopicState, setNewTopicState] = useState<NewTopicState>('idle')
  const [newTopicMessage, setNewTopicMessage] = useState('')
  const newTopicInputRef = useRef<HTMLTextAreaElement>(null)
  const [isContinuing, setIsContinuing] = useState(false)

  // セッション引き継ぎで新規セッション開始
  const handleContinueSession = useCallback(async () => {
    if (!onContinueSession || !agentId) return
    setIsContinuing(true)
    try {
      const message = buildContinueSessionMessage(session.id, session.events)
      await onContinueSession(agentId, message)
    } finally {
      setIsContinuing(false)
    }
  }, [onContinueSession, agentId, session.id, session.events])

  const handleSend = useCallback(async (message: string) => {
    if (!onSendMessage) return
    setIsSending(true)
    try {
      await onSendMessage(session.id, message)
    } finally {
      setIsSending(false)
    }
  }, [onSendMessage, session.id])

  // 新しい話題で開始
  const handleNewTopic = useCallback(async () => {
    if (!onStartNewTopic || !agentId || !newTopicMessage.trim()) return
    setNewTopicState('sending')
    try {
      await onStartNewTopic(agentId, newTopicMessage.trim())
      setNewTopicMessage('')
      setNewTopicState('idle')
    } catch {
      setNewTopicState('input')
    }
  }, [onStartNewTopic, agentId, newTopicMessage])

  // 入力欄を開いた時にフォーカス
  useEffect(() => {
    if (newTopicState === 'input') {
      newTopicInputRef.current?.focus()
    }
  }, [newTopicState])

  // 自動スクロール判定
  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }

  // 新メッセージ時の自動スクロール
  useEffect(() => {
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [session.events.length])

  // 表示対象イベントのフィルタリング
  const visibleEvents = session.events.filter((e) => {
    // 共通: progress と空の tool_result は常に除外
    if (e.type === 'progress') return false
    if (e.type === 'tool_result' && !e.content.toolOutput) return false

    // 標準表示: システム注入のみのメッセージ・空メッセージを非表示
    if (viewMode === 'summary') {
      if (isSystemOnlyMessage(e)) return false
      if ((e.type === 'user' || e.type === 'assistant') && !e.content.text?.trim()) return false
      return e.type === 'user' || e.type === 'assistant'
    }

    // 詳細表示: すべて表示（デバッグ用にシステム注入も含む）
    return true
  })

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* セッション情報ヘッダー（固定表示） */}
      <div className="shrink-0 flex justify-center py-2 md:py-3 border-b border-[var(--border)] bg-[var(--bg-base)] px-2">
        <div className="text-xs md:text-sm text-[var(--text-dim)] bg-[var(--bg-surface)] px-3 md:px-5 py-1.5 md:py-2 rounded-full flex items-center gap-2 md:gap-3 flex-wrap justify-center">
          <span className="hidden sm:inline">{session.projectName}</span>
          <span className="hidden sm:inline">|</span>
          <span>{session.id.slice(0, 8)}</span>
          <span className="hidden md:inline">|</span>
          <span className="hidden md:inline">{new Date(session.startedAt).toLocaleDateString('ja-JP')}</span>
          <span>|</span>
          {/* 表示モード切替ボタン */}
          <div className="flex bg-[var(--bg-inset)] rounded-full p-0.5">
            <button
              onClick={() => setViewMode('summary')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === 'summary'
                  ? 'bg-[var(--accent-bg-strong)] text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-muted)]'
              }`}
            >
              標準
            </button>
            <button
              onClick={() => setViewMode('detail')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === 'detail'
                  ? 'bg-[var(--accent-bg-strong)] text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-muted)]'
              }`}
            >
              詳細
            </button>
          </div>
          {/* リロードボタン */}
          {onReload && (
            <>
              <span>|</span>
              <button
                onClick={onReload}
                className="text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] transition-colors"
                title="セッション再読み込み"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </>
          )}
          {/* 全メッセージコピーボタン */}
          <span>|</span>
          <button
            onClick={async () => {
              const md = eventsToMarkdown(visibleEvents, (e) => {
                if (e.type === 'user') return userConfig.name
                if (e.type === 'assistant') return agentConfig.name
                return e.type
              })
              const ok = await copyToClipboard(md)
              if (ok) {
                setAllCopied(true)
                setTimeout(() => setAllCopied(false), 1500)
              }
            }}
            className="text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] transition-colors"
            title="全メッセージをMarkdownでコピー"
          >
            {allCopied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {/* 新しい話題ボタン */}
          {onStartNewTopic && agentId && (
            <>
              <span>|</span>
              <button
                onClick={() => {
                  if (newTopicState === 'input') {
                    setNewTopicState('idle')
                    setNewTopicMessage('')
                  } else {
                    setNewTopicState('input')
                  }
                }}
                disabled={newTopicState === 'sending' || isPendingNewSession}
                className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  newTopicState === 'input'
                    ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
                    : isPendingNewSession
                      ? 'bg-[var(--accent-bg-subtle)] text-[var(--accent-text-vivid)] animate-pulse'
                      : 'text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] hover:bg-[var(--accent-bg-subtle)]'
                }`}
                title="新しい話題でセッションを始める"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span className="hidden sm:inline">{isPendingNewSession ? 'アクティブ' : '新しい話題'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 新しい話題: メッセージ入力エリア */}
      {newTopicState !== 'idle' && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            <span className="text-[11px] text-[var(--accent-text)] font-medium">
              {agentConfig.name} と新しい話題を始める
            </span>
          </div>
          <div className="flex gap-2">
            <textarea
              ref={newTopicInputRef}
              value={newTopicMessage}
              onChange={(e) => setNewTopicMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  handleNewTopic()
                }
                if (e.key === 'Escape') {
                  setNewTopicState('idle')
                  setNewTopicMessage('')
                }
              }}
              disabled={newTopicState === 'sending'}
              placeholder="最初のメッセージを入力... (Ctrl+Enter で送信, Esc でキャンセル)"
              className="flex-1 bg-[var(--bg-inset)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] placeholder-gray-600 resize-none focus:outline-none focus:border-[var(--accent-strong)] disabled:opacity-50"
              rows={2}
            />
            <div className="flex flex-col gap-1.5">
              <button
                onClick={handleNewTopic}
                disabled={!newTopicMessage.trim() || newTopicState === 'sending'}
                className="px-3 py-1.5 bg-[var(--accent-bg-strong)] hover:bg-[var(--accent-bg-strong)] disabled:bg-gray-700/30 disabled:text-[var(--text-faint)] text-[var(--accent-text)] text-xs font-medium rounded-lg transition-colors"
              >
                {newTopicState === 'sending' ? '送信中...' : '開始'}
              </button>
              <button
                onClick={() => {
                  setNewTopicState('idle')
                  setNewTopicMessage('')
                }}
                disabled={newTopicState === 'sending'}
                className="px-3 py-1.5 text-[var(--text-dim)] hover:text-[var(--text-muted)] text-xs rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* メッセージ一覧（スクロール領域） */}
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-2 md:px-4 py-3">
        {visibleEvents.map((event) => (
          <MessageBubble key={event.id} event={event} agentConfig={agentConfig} userConfig={userConfig} onFilePathClick={onFilePathClick} onAddTask={onAddTask} theme={theme} />
        ))}

        {/* タイピングインジケーター: エージェントが応答準備中の表示 */}
        {(isSending || session.status === 'thinking' || session.status === 'waiting') && (
          <div className="flex justify-start mb-3">
            <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)]">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: agentConfig.color, animation: 'pulse-dot 1.4s ease-in-out infinite', animationDelay: '0s' }}
              />
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: agentConfig.color, animation: 'pulse-dot 1.4s ease-in-out infinite', animationDelay: '0.2s' }}
              />
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: agentConfig.color, animation: 'pulse-dot 1.4s ease-in-out infinite', animationDelay: '0.4s' }}
              />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* メッセージ入力 or 読み取り専用表示 */}
      {onSendMessage ? (
        <MessageInput
          onSend={handleSend}
          isSending={isSending}
          onSendError={onSendError}
          placeholder={
            session.status === 'idle'
              ? 'セッションを再開する... (Ctrl+Enter で送信)'
              : 'メッセージを入力... (Ctrl+Enter で送信)'
          }
        />
      ) : (
        <div className="shrink-0 px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-surface)]">
          <div className="text-xs text-[var(--text-dim)] text-center py-1">
            このセッションは読み取り専用です（終了済み、またはエージェント未起動）
          </div>
          {/* 引き継ぎボタン: エージェントが紐づいている終了済みセッションのみ表示 */}
          {onContinueSession && agentId && session.status === 'idle' && (
            <div className="flex justify-center py-1.5">
              <button
                onClick={handleContinueSession}
                disabled={isContinuing || isPendingNewSession}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isContinuing || isPendingNewSession
                    ? 'bg-[var(--accent-bg-subtle)] text-[var(--accent-text-vivid)] animate-pulse cursor-wait'
                    : 'bg-[var(--accent-bg)] text-[var(--accent-text)] hover:bg-[var(--accent-bg)] hover:text-[var(--accent-text)]'
                }`}
                title="このセッションの内容を引き継いで新しいセッションを開始する"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                {isContinuing || isPendingNewSession ? '引き継ぎ中...' : '引き継いで新規セッション開始'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
