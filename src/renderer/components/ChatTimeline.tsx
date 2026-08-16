/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { Session, AgentConfig } from '../types'
import { MessageBubble } from './MessageBubble'
import { MessageInput } from './MessageInput'
import { SessionStatusBar } from './SessionStatusBar'
import { SlashCommandWarningModal } from './SlashCommandWarningModal'
import { eventsToMarkdown, copyToClipboard, buildContinueSessionMessage } from '../utils/format'
import { isSystemOnlyMessage } from '../utils/system-only-message'
import {
  detectSlashCommand,
  isSlashCommandWarningSuppressed,
  suppressSlashCommandWarning,
} from '../utils/slash-command'
import { t } from '../i18n'

type ViewMode = 'summary' | 'detail'
type NewTopicState = 'idle' | 'input' | 'sending'

/**
 * Whether the typing indicator should be shown.
 *
 * Extracted as a pure predicate so the OR condition is unit-testable.
 * `awaitingFirstResponse` covers the onboarding first-session window
 * (S2) where the watcher restores the new JSONL as historical and the
 * session sits at `status='idle'` until Kobi's first reply, so the
 * status-driven conditions never fire (BL-2026-294,
 * onboarding-scenarios.md §5.3.3).
 */
export function shouldShowTypingIndicator(args: {
  isSending: boolean
  status: Session['status']
  awaitingFirstResponse?: boolean
}): boolean {
  return (
    args.isSending ||
    args.status === 'thinking' ||
    args.status === 'waiting' ||
    args.awaitingFirstResponse === true
  )
}

interface ChatTimelineProps {
  session: Session
  agentConfig: AgentConfig
  userConfig: AgentConfig
  onSendMessage?: (sessionId: string, message: string) => Promise<void>
  onReload?: () => void
  /** Callback to start a session with a new topic (agentId, message) */
  onStartNewTopic?: (agentId: string, message: string) => Promise<void>
  /** Agent ID associated with the current session */
  agentId?: string
  /** Waiting for new session flag */
  isPendingNewSession?: boolean
  /** Callback to continue a session by starting a new one (agentId, message) */
  onContinueSession?: (agentId: string, message: string) => Promise<void>
  /** Callback when a file path is clicked */
  onFilePathClick?: (path: string) => void
  /** Callback on send failure (for rolling back optimistic messages) */
  onSendError?: (error: Error) => void
  /**
   * Q6 / SS-5: invoked when the user clicks the Stop button or
   * presses Esc inside the composer while the agent is producing a
   * response. Wrapped by the parent to dispatch Ctrl-C via tmux.
   */
  onInterrupt?: () => void
  /** Agent name (for header display) */
  agentName?: string
  /** Agent color (for header display) */
  agentColor?: string
  /** UI theme */
  theme?: 'dark' | 'light'
  /**
   * Per-session draft text for the message input. Owned by the parent so
   * unsent text survives session switches (see `useIPC.getDraft`).
   */
  draftValue: string
  /** Called when the message input content changes. */
  onDraftChange: (value: string) => void
  /**
   * Latest activity line from the agent's tmux pane. Shown next to the
   * typing indicator while the agent is preparing a response so the user
   * can see what is happening underneath the spinner. Sourced from
   * `useIPC.agentActivities[session.id]`.
   */
  activityLine?: string
  /**
   * S2 of the onboarding first-session loading state machine
   * (onboarding-scenarios.md §5.3.3). When true, the typing indicator
   * is shown even though `status` is still `idle` — the new session's
   * JSONL was restored as historical, so the status-driven conditions
   * never fire until Kobi's first reply. Defaults to false; existing
   * callers keep their previous behaviour (BL-2026-294).
   */
  awaitingFirstResponse?: boolean
}

export function ChatTimeline({ session, agentConfig, userConfig, onSendMessage, onReload, onStartNewTopic, agentId, isPendingNewSession, onContinueSession, onFilePathClick, onSendError, onInterrupt, agentName, agentColor, theme = 'dark', draftValue, onDraftChange, activityLine, awaitingFirstResponse }: ChatTimelineProps) {
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
  // Pending slash-command awaiting confirmation (Q12 / SS-6). When
  // non-null, the SlashCommandWarningModal is displayed and the
  // message has not yet been forwarded to onSendMessage.
  const [pendingSlashMessage, setPendingSlashMessage] = useState<string | null>(null)

  // Start a new session by continuing from the current one
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

  const performSend = useCallback(async (message: string) => {
    if (!onSendMessage) return
    setIsSending(true)
    try {
      await onSendMessage(session.id, message)
    } finally {
      setIsSending(false)
    }
  }, [onSendMessage, session.id])

  const handleSend = useCallback(async (message: string) => {
    if (!onSendMessage) return
    // Q12 / SS-6: warn the user once when sending a Claude Code TUI
    // command. KB cannot render the response (the TUI consumes the
    // command before it reaches the JSONL transcript), so without
    // this dialog the message looks lost from the UI's perspective.
    if (detectSlashCommand(message) && !isSlashCommandWarningSuppressed()) {
      setPendingSlashMessage(message)
      return
    }
    await performSend(message)
  }, [onSendMessage, performSend])

  const handleConfirmSlashCommand = useCallback(
    (suppressFuture: boolean) => {
      const message = pendingSlashMessage
      setPendingSlashMessage(null)
      if (!message) return
      if (suppressFuture) suppressSlashCommandWarning()
      void performSend(message)
    },
    [pendingSlashMessage, performSend],
  )

  const handleCancelSlashCommand = useCallback(() => {
    setPendingSlashMessage(null)
  }, [])

  // Start with a new topic
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

  // Focus input when opened
  useEffect(() => {
    if (newTopicState === 'input') {
      newTopicInputRef.current?.focus()
    }
  }, [newTopicState])

  // Auto-scroll detection
  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }

  // Auto-scroll on new messages
  useEffect(() => {
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [session.events.length])

  // Snap to the bottom instantly when switching sessions.
  // Without this, the scroll position from the previous session lingers
  // (or the view jumps to the top on first mount), forcing the user to
  // scroll down manually to see the most recent activity.
  // useLayoutEffect runs synchronously after DOM mutation so the snap
  // happens before paint — no visible scroll animation.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
    wasAtBottomRef.current = true
  }, [session.id])

  // Filter events for display
  const visibleEvents = session.events.filter((e) => {
    // Common: always exclude progress and empty tool_result
    if (e.type === 'progress') return false
    if (e.type === 'tool_result' && !e.content.toolOutput) return false

    // Summary view: hide system-only and empty messages
    if (viewMode === 'summary') {
      if (isSystemOnlyMessage(e)) return false
      if ((e.type === 'user' || e.type === 'assistant') && !e.content.text?.trim()) return false
      return e.type === 'user' || e.type === 'assistant'
    }

    // Detail view: show everything (including system-injected for debugging)
    return true
  })

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Session info header (fixed) */}
      <div className="shrink-0 flex justify-center py-2 md:py-3 border-b border-[var(--border)] bg-[var(--bg-base)] px-2">
        <div className="text-xs md:text-sm text-[var(--text-dim)] bg-[var(--bg-surface)] px-3 md:px-5 py-1.5 md:py-2 rounded-full flex items-center gap-2 md:gap-3 flex-wrap justify-center">
          {agentName && (
            <>
              <span className="font-medium" style={agentColor ? { color: agentColor } : undefined}>{agentName}</span>
              <span>|</span>
            </>
          )}
          <span className="hidden sm:inline">{session.projectName}</span>
          <span className="hidden sm:inline">|</span>
          <span>{session.id.slice(0, 8)}</span>
          <span className="hidden md:inline">|</span>
          <span className="hidden md:inline">{new Date(session.startedAt).toLocaleDateString('ja-JP')}</span>
          <span>|</span>
          {/* View mode toggle buttons */}
          <div className="flex bg-[var(--bg-inset)] rounded-full p-0.5">
            <button
              onClick={() => setViewMode('summary')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === 'summary'
                  ? 'bg-[var(--accent-bg-strong)] text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-muted)]'
              }`}
            >
              {t('chat.timeline.mode.standard')}
            </button>
            <button
              onClick={() => setViewMode('detail')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === 'detail'
                  ? 'bg-[var(--accent-bg-strong)] text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-muted)]'
              }`}
            >
              {t('chat.timeline.mode.detail')}
            </button>
          </div>
          {/* Reload button */}
          {onReload && (
            <>
              <span>|</span>
              <button
                onClick={onReload}
                className="text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] transition-colors"
                title={t('tooltip.chat.reload')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </>
          )}
          {/* Copy all messages button */}
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
            title={t('tooltip.chat.copyAll')}
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
          {/* New topic button */}
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
                title={t('tooltip.chat.startNew')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span className="hidden sm:inline">{isPendingNewSession ? t('chat.topic.active') : t('chat.topic.new')}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* New topic: message input area */}
      {newTopicState !== 'idle' && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            <span className="text-[11px] text-[var(--accent-text)] font-medium">
              {t('chat.topic.startNew', { agent: agentConfig.name })}
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
              placeholder={t('chat.topic.placeholder')}
              className="flex-1 bg-[var(--bg-inset)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] placeholder-gray-600 resize-none focus:outline-none focus:border-[var(--accent-strong)] disabled:opacity-50"
              rows={2}
            />
            <div className="flex flex-col gap-1.5">
              <button
                onClick={handleNewTopic}
                disabled={!newTopicMessage.trim() || newTopicState === 'sending'}
                className="px-3 py-1.5 bg-[var(--accent-bg-strong)] hover:bg-[var(--accent-bg-strong)] disabled:bg-gray-700/30 disabled:text-[var(--text-faint)] text-[var(--accent-text)] text-xs font-medium rounded-lg transition-colors"
              >
                {newTopicState === 'sending' ? t('chat.topic.status.sending') : t('chat.topic.button.start')}
              </button>
              <button
                onClick={() => {
                  setNewTopicState('idle')
                  setNewTopicMessage('')
                }}
                disabled={newTopicState === 'sending'}
                className="px-3 py-1.5 text-[var(--text-dim)] hover:text-[var(--text-muted)] text-xs rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Q5 / SS-4 session meta information (model / context / elapsed). */}
      <SessionStatusBar session={session} />

      {/* Message list (scrollable area) */}
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-2 md:px-4 py-3">
        {visibleEvents.map((event) => (
          <MessageBubble key={event.id} event={event} agentConfig={agentConfig} userConfig={userConfig} onFilePathClick={onFilePathClick} theme={theme} />
        ))}

        {/* Typing indicator: shown while agent is preparing a response.
            When `activityLine` is present we surface the latest line
            from the agent's tmux pane next to the dots so the user can
            see whether Claude is reading a file, running a command, or
            generating a response — instead of just a silent pulse. */}
        {shouldShowTypingIndicator({ isSending, status: session.status, awaitingFirstResponse }) && (
          <div className="flex justify-start mb-3">
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] max-w-full">
              <div className="flex items-center gap-1.5 shrink-0">
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
              {activityLine && (
                <span
                  className="text-xs text-[var(--text-dim)] truncate max-w-[420px] font-mono"
                  title={activityLine}
                >
                  {activityLine}
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Message input or read-only display */}
      {onSendMessage ? (
        <MessageInput
          onSend={handleSend}
          isSending={isSending}
          onSendError={onSendError}
          isAgentBusy={session.status === 'thinking' || session.status === 'waiting'}
          onInterrupt={onInterrupt}
          value={draftValue}
          onChange={onDraftChange}
          placeholder={
            session.status === 'idle'
              ? t('chat.input.placeholder.resume')
              : t('chat.input.placeholder.active')
          }
        />
      ) : (
        <div className="shrink-0 px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-surface)]">
          <div className="text-xs text-[var(--text-dim)] text-center py-1">
            {t('chat.timeline.readOnly')}
          </div>
          {/* Continue button: shown only for ended sessions with an associated agent */}
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
                title={t('tooltip.chat.continueInNew')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                {isContinuing || isPendingNewSession ? t('chat.timeline.continue.loading') : t('chat.timeline.continue.button')}
              </button>
            </div>
          )}
        </div>
      )}
      <SlashCommandWarningModal
        message={pendingSlashMessage}
        onConfirm={handleConfirmSlashCommand}
        onCancel={handleCancelSlashCommand}
      />
    </div>
  )
}
