/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useCallback } from 'react'
import type { AgentInfo, SessionSummary } from '../types'
import { AgentAvatar } from './AgentAvatar'
import { AgentAvatarUpload } from './AgentAvatarUpload'
import { ConfirmModal } from './ConfirmModal'
import { MarkdownPreview } from './MarkdownPreview'
import { MessageInput } from './MessageInput'
import { useToast } from './Toast'
import { STATUS_INDICATORS, relativeTime, formatTokens, shortModel } from '../utils/format'
import { getAgentDescription, getAgentDisplayName, getAgentRole } from '../utils/agent-display'
import { t } from '../i18n'
import { kbFetch } from '../lib/kbFetch'

interface AgentDetailProps {
  agent: AgentInfo
  /** List of sessions associated with this agent */
  sessions: SessionSummary[]
  onBack: () => void
  onSelectSession: (sessionId: string) => void
  onStartNewSession?: (agentId: string, message: string) => Promise<void>
  /** Waiting for new session detection */
  isPendingNewSession?: boolean
  /** Callback when avatar changes (used for refreshing agent list, etc.) */
  onAvatarChange?: () => void
  /** Navigate to agent edit page */
  onEdit?: (agentId: string) => void
  /** Restart this agent via admin API */
  onRestartAgent?: (agentId: string) => Promise<void>
  /** UI theme */
  theme?: 'dark' | 'light'
}

type TabId = 'profile' | 'sessions' | 'definition'

/** Confirmation state when an active session is detected */
interface ActiveSessionConfirm {
  /** The detected active session */
  activeSession: SessionSummary
}

export function AgentDetail({
  agent, sessions,
  onBack, onSelectSession, onStartNewSession,
  isPendingNewSession,
  onAvatarChange,
  onEdit,
  onRestartAgent,
  theme = 'dark',
}: AgentDetailProps) {
  const [activeTab, setActiveTab] = useState<TabId>('profile')
  const [showNewSession, setShowNewSession] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  // Local draft for the new-session input. Per-session draft persistence
  // (useIPC.getDraft/setDraft) only applies to existing sessions; the
  // "start a new session for this agent" form uses ephemeral local state
  // and is cleared once a session has been created.
  const [newSessionDraft, setNewSessionDraft] = useState('')
  // Active session confirmation dialog state
  const [activeConfirm, setActiveConfirm] = useState<ActiveSessionConfirm | null>(null)
  // Agent restart state
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const { addToast } = useToast()

  // "New session" button click: show confirmation UI if an active session exists
  const handleNewSessionClick = useCallback(() => {
    if (showNewSession) {
      // Already open -> close it
      setShowNewSession(false)
      setActiveConfirm(null)
      return
    }

    // Check if this agent has an active session
    const activeSession = sessions.find((s) => s.status !== 'idle')
    if (activeSession) {
      // Show confirmation UI (before message input)
      setActiveConfirm({ activeSession })
      setShowNewSession(true)
      return
    }

    // No active session -> show message input directly
    setShowNewSession(true)
  }, [showNewSession, sessions])

  const handleStartSession = useCallback(async (message: string) => {
    if (!onStartNewSession) return

    setIsStarting(true)
    try {
      await onStartNewSession(agent.id, message)
      setShowNewSession(false)
    } finally {
      setIsStarting(false)
    }
  }, [onStartNewSession, agent.id])

  // Confirmation UI: user chose to start a new session -> show message input
  const handleConfirmNewSession = useCallback(() => {
    setActiveConfirm(null)
    // showNewSession remains true -> MessageInput is displayed
  }, [])

  // Confirmation UI: open the active session
  const handleOpenActiveSession = useCallback(() => {
    if (!activeConfirm) return
    const { activeSession } = activeConfirm
    setActiveConfirm(null)
    setShowNewSession(false)
    onSelectSession(activeSession.id)
  }, [activeConfirm, onSelectSession])

  // Confirmation UI: cancel
  const handleConfirmCancel = useCallback(() => {
    setActiveConfirm(null)
    setShowNewSession(false)
  }, [])

  const handleRestartAgent = useCallback(async () => {
    setShowRestartConfirm(false)
    if (!onRestartAgent) return
    setIsRestarting(true)
    addToast(t('admin.agent.restart.progress', { agentName: agent.displayName }), 'info')
    try {
      await onRestartAgent(agent.id)
      addToast(t('admin.agent.restart.done', { agentName: agent.displayName }), 'success')
    } catch {
      addToast(t('admin.agent.restart.failed', { agentName: agent.displayName }), 'error')
    } finally {
      setIsRestarting(false)
    }
  }, [onRestartAgent, agent.id, agent.displayName, addToast])

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'profile', label: t('agent.detail.tab.profile') },
    { id: 'sessions', label: t('agent.detail.tab.sessions'), count: sessions.length },
    { id: 'definition', label: t('agent.detail.tab.definition') },
  ]

  // Aggregate session statistics
  const totalMessages = sessions.reduce((sum, s) => sum + s.stats.userMessages + s.stats.assistantMessages, 0)
  const totalToolCalls = sessions.reduce((sum, s) => sum + s.stats.toolCalls, 0)
  const totalTokens = sessions.reduce((sum, s) => sum + s.stats.totalInputTokens + s.stats.totalOutputTokens, 0)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="shrink-0 border-b border-[var(--border)]"
        style={{
          background: `linear-gradient(135deg, ${agent.color}15, ${agent.color}05)`
        }}
      >
        <div className="px-3 md:px-6 pt-3 md:pt-4 pb-2 md:pb-3">
              <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors mb-3"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                {t('agent.detail.button.backToList')}
              </button>

              <div className="flex items-center gap-3 md:gap-4">
                <AgentAvatar name={getAgentDisplayName(agent)} color={agent.color} size={56} avatar={agent.avatar} agentId={agent.id} theme={theme} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 md:gap-3 flex-wrap">
                    <h2 className="text-lg md:text-xl font-bold text-[var(--text-primary)]">{getAgentDisplayName(agent)}</h2>
                    {agent.activeSessionCount > 0 && (
                      <div className="flex items-center gap-1.5 bg-green-500/20 text-green-400 text-[10px] font-medium px-2 py-0.5 rounded-full">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        Active
                      </div>
                    )}
                  </div>
                  {getAgentRole(agent) && (
                    <p className="text-sm text-[var(--text-muted)] mt-0.5">{getAgentRole(agent)}</p>
                  )}
                  {agent.origin && (
                    <p className="text-xs text-[var(--text-dim)] mt-0.5">{agent.origin}</p>
                  )}
                </div>

                {/* Restart agent button */}
                {onRestartAgent && (
                  <button
                    onClick={() => setShowRestartConfirm(true)}
                    disabled={isRestarting}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors disabled:opacity-50"
                    title={t('admin.agent.restart.button')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    {t('admin.agent.restart.button')}
                  </button>
                )}

                {/* New session button */}
                {onStartNewSession && (
                  <button
                    onClick={handleNewSessionClick}
                    className={`
                      shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                      transition-all duration-200
                      ${showNewSession
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-tertiary)] border border-[var(--border)]'
                        : 'bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent-shadow)]'
                      }
                    `}
                  >
                    {showNewSession ? (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                        {t('common.cancel')}
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        {t('agent.detail.button.newSession')}
                      </>
                    )}
                  </button>
                )}
              </div>

              {/* New session input or active session confirmation UI */}
              {showNewSession && !isPendingNewSession && (
                <div className="mt-3">
                  {activeConfirm ? (
                    /* --- Active session confirmation UI --- */
                    <ActiveSessionConfirmDialog
                      confirm={activeConfirm}
                      agentName={agent.displayName}
                      onNewSession={handleConfirmNewSession}
                      onOpenActive={handleOpenActiveSession}
                      onCancel={handleConfirmCancel}
                    />
                  ) : (
                    <MessageInput
                      onSend={handleStartSession}
                      isSending={isStarting}
                      value={newSessionDraft}
                      onChange={setNewSessionDraft}
                      placeholder={t('agent.detail.newSession.placeholder', { agent: agent.displayName })}
                    />
                  )}
                </div>
              )}

              {/* Pulse animation while waiting for new session detection */}
              {isPendingNewSession && (
                <div className="mt-3 flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)]">
                  <div className="relative flex items-center justify-center w-5 h-5">
                    <div
                      className="absolute w-5 h-5 rounded-full animate-ping opacity-30"
                      style={{ backgroundColor: agent.color }}
                    />
                    <div
                      className="w-2.5 h-2.5 rounded-full animate-pulse"
                      style={{ backgroundColor: agent.color }}
                    />
                  </div>
                  <span className="text-sm text-[var(--text-muted)]">{t('agent.detail.status.creatingSession')}</span>
                </div>
              )}
        </div>

        {/* Tabs */}
          <div className="flex gap-0 px-3 md:px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  px-4 py-2 text-sm font-medium border-b-2 transition-colors
                  ${activeTab === tab.id
                    ? 'border-[var(--accent-border)] text-[var(--accent-text)]'
                    : 'border-transparent text-[var(--text-dim)] hover:text-[var(--text-tertiary)]'
                  }
                `}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span className={`ml-1.5 text-xs ${activeTab === tab.id ? 'text-[var(--accent-text-vivid)]' : 'text-[var(--text-faint)]'}`}>
                    ({tab.count})
                  </span>
                )}
              </button>
            ))}
          </div>
      </div>

      {/* Main content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'profile' && (
            <ProfileTab
              agent={agent}
              totalSessions={sessions.length}
              totalMessages={totalMessages}
              totalToolCalls={totalToolCalls}
              totalTokens={totalTokens}
              onAvatarChange={onAvatarChange}
              onEdit={onEdit}
            />
          )}
          {activeTab === 'sessions' && (
            <SessionsTab
              sessions={sessions}
              agentColor={agent.color}
              onSelectSession={onSelectSession}
            />
          )}
          {activeTab === 'definition' && (
            <DefinitionTab agentId={agent.id} />
          )}
        </div>

      {/* Agent restart confirmation modal */}
      <ConfirmModal
        isOpen={showRestartConfirm}
        title={t('admin.agent.restart.confirm.title', { agentName: agent.displayName })}
        body={
          <div className="space-y-2">
            <p>{t('admin.agent.restart.confirm.body.line1')}</p>
            <ul className="space-y-1 mt-2">
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 shrink-0">✓</span>
                <span>{t('admin.agent.restart.confirm.body.line2')}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400 shrink-0">✗</span>
                <span>{t('admin.agent.restart.confirm.body.line3')}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400 shrink-0">✗</span>
                <span>{t('admin.agent.restart.confirm.body.line4')}</span>
              </li>
            </ul>
          </div>
        }
        confirmLabel={t('admin.agent.restart.confirm.ok')}
        onConfirm={handleRestartAgent}
        onCancel={() => setShowRestartConfirm(false)}
        loading={isRestarting}
      />
    </div>
  )
}

// --- Profile tab ---

interface ProfileTabProps {
  agent: AgentInfo
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  totalTokens: number
  onAvatarChange?: () => void
  onEdit?: (agentId: string) => void
}

function ProfileTab({ agent, totalSessions, totalMessages, totalToolCalls, totalTokens, onAvatarChange, onEdit }: ProfileTabProps) {
  return (
    <div className="p-3 md:p-6 space-y-4 md:space-y-6">
      {/* Edit button banner */}
      {onEdit && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]">
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)] shrink-0">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span className="text-xs text-[var(--text-dim)]">
              {t('agent.detail.editBanner.description')}
            </span>
          </div>
          <button
            onClick={() => onEdit(agent.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--accent-bg)] text-[var(--accent-text)] hover:opacity-90 transition-opacity shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            {t('common.edit')}
          </button>
        </div>
      )}

      {/* Overview card */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-3">{t('agent.detail.section.overview')}</h3>
        {agent.summary && (
          <p className="text-sm text-[var(--text-tertiary)] mb-2 font-medium">{agent.summary}</p>
        )}
        <p className="text-sm text-[var(--text-muted)] leading-relaxed">{getAgentDescription(agent)}</p>
      </div>

      {/* Basic information */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">{t('agent.detail.section.basicInfo')}</h3>
        <div className="space-y-3">
          {agent.employeeId && (
            <InfoRow label={t('agent.detail.field.employeeId')} value={agent.employeeId} />
          )}
          <InfoRow label={t('agent.detail.field.agentId')} value={agent.id} />
          <InfoRow label={t('agent.detail.field.model')} value={shortModel(agent.model)} subValue={agent.model} />
          <InfoRow label={t('agent.detail.field.command')} value={agent.command} mono />
          <InfoRow label={t('agent.detail.field.themeColor')} value={agent.color} color={agent.color} />
        </div>
      </div>

      {/* Avatar settings */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">{t('agent.detail.section.avatar')}</h3>
        <div className="flex items-start gap-4">
          <AgentAvatar name={agent.displayName} color={agent.color} size={64} avatar={agent.avatar} agentId={agent.id} />
          <AgentAvatarUpload
            agentId={agent.id}
            onUploadComplete={onAvatarChange || (() => {})}
          />
        </div>
      </div>

      {/* Cumulative statistics */}
      <div className="bg-[var(--bg-elevated)] rounded-xl p-5 border border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--text-tertiary)] mb-4">{t('agent.detail.section.stats')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label={t('agent.detail.stat.sessions')} value={String(totalSessions)} icon="sessions" color="#8B5CF6" />
          <StatCard label={t('agent.detail.stat.messages')} value={String(totalMessages)} icon="messages" color="#3B82F6" />
          <StatCard label={t('agent.detail.stat.toolCalls')} value={String(totalToolCalls)} icon="tools" color="#10B981" />
          <StatCard label={t('agent.detail.stat.tokens')} value={formatTokens(totalTokens)} icon="tokens" color="#F59E0B" />
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, subValue, mono, color }: {
  label: string
  value: string
  subValue?: string
  mono?: boolean
  color?: string
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="text-xs text-[var(--text-dim)]">{label}</span>
      <div className="flex items-center gap-2">
        {color && (
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
        )}
        <span className={`text-sm text-[var(--text-tertiary)] ${mono ? 'font-mono text-xs bg-[var(--bg-surface)] px-2 py-0.5 rounded' : ''}`}>
          {value}
        </span>
        {subValue && (
          <span className="text-[10px] text-[var(--text-faint)] hidden lg:inline">({subValue})</span>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, icon, color }: {
  label: string
  value: string
  icon: string
  color: string
}) {
  const icons: Record<string, React.ReactNode> = {
    sessions: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    messages: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
      </svg>
    ),
    tools: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
    tokens: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    )
  }

  return (
    <div className="bg-[var(--bg-surface)] rounded-lg p-3 text-center">
      <div className="flex justify-center mb-2" style={{ color }}>
        {icons[icon]}
      </div>
      <div className="text-lg font-bold text-[var(--text-secondary)]">{value}</div>
      <div className="text-[10px] text-[var(--text-dim)] mt-0.5">{label}</div>
    </div>
  )
}

// --- Active session confirmation dialog ---

interface ActiveSessionConfirmDialogProps {
  confirm: ActiveSessionConfirm
  agentName: string
  onNewSession: () => void
  onOpenActive: () => void
  onCancel: () => void
}

function ActiveSessionConfirmDialog({
  confirm, agentName, onNewSession, onOpenActive, onCancel,
}: ActiveSessionConfirmDialogProps) {
  const statusIndicator = STATUS_INDICATORS[confirm.activeSession.status] || STATUS_INDICATORS.idle

  return (
    <div className="bg-[var(--bg-elevated)] rounded-xl border border-[var(--border)] p-4 space-y-3">
      {/* Warning message */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-400">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div>
          <p className="text-sm text-[var(--text-secondary)] font-medium">
            {t('agent.detail.activeConfirm.message', { agent: agentName })}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <div className={`w-2 h-2 rounded-full ${statusIndicator.dot}`} />
            <span className="text-xs text-[var(--text-muted)]">{confirm.activeSession.id.slice(0, 8)}</span>
            <span className="text-xs text-[var(--text-dim)]">
              {confirm.activeSession.lastMessage
                ? `"${confirm.activeSession.lastMessage.slice(0, 40)}${confirm.activeSession.lastMessage.length > 40 ? '...' : ''}"`
                : confirm.activeSession.projectName
              }
            </span>
          </div>
        </div>
      </div>

      {/* Three-choice buttons */}
      <div className="flex flex-col gap-2">
        {/* Start new session */}
        <button
          onClick={onNewSession}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-medium
            bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('agent.detail.activeConfirm.startNew')}
        </button>

        {/* Open active session — use the themed accent color so the
            label keeps contrast against `--bg-surface` in both light
            and dark themes. The previous hardcoded `text-blue-300`
            collapsed to near-black on the light theme. */}
        <button
          onClick={onOpenActive}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-medium
            bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--accent-text)] border border-[var(--border)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {t('agent.detail.activeConfirm.openActive')}
        </button>

        {/* Cancel */}
        <button
          onClick={onCancel}
          className="w-full px-4 py-2 rounded-lg text-sm text-[var(--text-dim)] hover:text-[var(--text-tertiary)]
            hover:bg-[var(--bg-surface)] transition-colors"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

// --- Session history tab ---

interface SessionsTabProps {
  sessions: SessionSummary[]
  agentColor: string
  onSelectSession: (sessionId: string) => void
}

function SessionsTab({ sessions, agentColor, onSelectSession }: SessionsTabProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--text-dim)]">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-[var(--text-faint)]">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p className="text-sm">{t('agent.detail.sessions.empty')}</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">{t('agent.detail.sessions.emptyHint')}</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[var(--bg-hover)]">
      {sessions.map((s) => {
        const indicator = STATUS_INDICATORS[s.status] || STATUS_INDICATORS.idle
        return (
          <button
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className="w-full text-left px-6 py-4 hover:bg-[var(--bg-elevated)] transition-colors group"
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-2 h-2 rounded-full shrink-0 ${indicator.dot}`} />
                <span className="text-sm font-medium text-[var(--text-secondary)] truncate">{s.projectName}</span>
                <span className="text-[10px] text-[var(--text-faint)] shrink-0">{s.id.slice(0, 8)}</span>
              </div>
              <span className="text-xs text-[var(--text-dim)] shrink-0 ml-3">{relativeTime(s.lastEventAt)}</span>
            </div>

            {/* Last message */}
            {s.lastMessage && (
              <p className="text-xs text-[var(--text-dim)] mb-2 truncate pl-4">{s.lastMessage}</p>
            )}

            {/* Stats bar */}
            <div className="flex items-center gap-4 pl-4">
              <span className="text-[10px] text-[var(--text-faint)]">
                {s.stats.userMessages + s.stats.assistantMessages} msgs
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">
                {s.stats.toolCalls} tools
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">
                {formatTokens(s.stats.totalInputTokens + s.stats.totalOutputTokens)} tokens
              </span>
              {/* Accent spacer */}
              <div className="flex-1" />
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="text-[var(--text-faint)] group-hover:text-[var(--text-muted)] transition-colors"
                style={{ color: undefined }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// --- Definition file tab ---

function DefinitionTab({ agentId }: { agentId: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(false)
    kbFetch(`/api/agents/${agentId}/definition`)
      .then((res) => {
        if (!res.ok) throw new Error('Not found')
        return res.json()
      })
      .then((data: { content: string }) => setContent(data.content))
      .catch(() => {
        setContent(null)
        setError(true)
      })
      .finally(() => setLoading(false))
  }, [agentId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--text-dim)] text-sm">
        {t('common.loading')}
      </div>
    )
  }

  if (error || !content) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--text-dim)]">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-[var(--text-faint)]">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <p className="text-sm">{t('agent.detail.definition.notFound')}</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">.claude/agents/{agentId}.md</p>
      </div>
    )
  }

  return (
    <div className="p-3 md:p-6">
      <div className="bg-[var(--bg-elevated)] rounded-xl border border-[var(--border)] p-5 overflow-auto">
        <MarkdownPreview content={content} variant="document" />
      </div>
    </div>
  )
}
