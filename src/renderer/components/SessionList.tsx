/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useMemo } from 'react'
import type { SessionSummary, AgentConfig } from '../types'
import { t } from '../i18n'
import { STATUS_INDICATORS, relativeTime } from '../utils/format'
import { AgentAvatar } from './AgentAvatar'

type FilterMode = 'latest' | 'all'

interface SessionListProps {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Map of session ID -> agent definition file name */
  sessionAgentMap: Record<string, string>
  /** Map of agent definition file name -> AgentConfig */
  agentConfigs: Record<string, AgentConfig>
  /** Default assistant config */
  defaultAgentConfig: AgentConfig
  /** UI theme */
  theme?: 'dark' | 'light'
}

export function SessionList({ sessions, selectedId, onSelect, sessionAgentMap, agentConfigs, defaultAgentConfig, theme = 'dark' }: SessionListProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>('latest')

  // Filter to only the latest session per agent
  const filteredSessions = useMemo(() => {
    if (filterMode === 'all') return sessions

    // Assumes sessions are sorted by lastEventAt descending (newest first).
    // The first occurrence for each agent = latest session
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
      {/* Header + filter buttons */}
      <div className="px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Sessions</h2>
          <span className="text-[10px] text-[var(--text-faint)]">{filteredSessions.length}</span>
        </div>
        <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
          <FilterButton
            label={t('session.list.tab.latest')}
            active={filterMode === 'latest'}
            onClick={() => setFilterMode('latest')}
          />
          <FilterButton
            label={t('session.list.tab.all')}
            active={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
          />
        </div>
      </div>

      {/* Session list */}
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
                {/* Avatar + status dot */}
                <div className="relative shrink-0">
                  <AgentAvatar name={agentCfg.name} color={agentCfg.color} size={28} avatar={agentCfg.avatar} theme={theme} />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-surface)] ${indicator.dot}`} />
                </div>
                {/* Session info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-medium truncate" style={{ color: agentCfg.color }}>
                      {agentCfg.name}
                    </span>
                    {/* Sidebar-origin badge (DEC-020 §2.6 / EU8). Surfaces
                        sessions started from the AmbientSidebar so the user
                        can tell them apart from the standard Sessions
                        timeline at a glance. */}
                    {s.origin === 'sidebar' && (
                      <span
                        data-testid="session-list-sidebar-badge"
                        title={t('session.list.badge.sidebarOrigin')}
                        className="text-[9px] px-1 py-px rounded shrink-0 bg-[var(--accent-bg)] text-[var(--accent-text)]"
                      >
                        {t('session.list.badge.sidebar')}
                      </span>
                    )}
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
            {t('session.list.empty')}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Filter button ---

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
