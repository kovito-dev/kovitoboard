/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'
import { getAgentDescription, getAgentDisplayName, getAgentRole } from '../utils/agent-display'
import { t } from '../i18n'

interface AgentListProps {
  agents: AgentInfo[]
  onSelectAgent: (agentId: string) => void
  /** Click handler for the add new agent button */
  onAddAgent?: () => void
  /** UI theme */
  theme?: 'dark' | 'light'
}

/** Shorten model name for display */
function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

/** Sort by employee_id ascending (unset values go to the end) */
function sortByEmployeeId(agents: AgentInfo[]): AgentInfo[] {
  return [...agents].sort((a, b) => {
    const aNum = a.employeeId ? parseInt(a.employeeId, 10) : Infinity
    const bNum = b.employeeId ? parseInt(b.employeeId, 10) : Infinity
    return aNum - bNum
  })
}

/**
 * Q13 / AA-7: split the agent list into three vertical sections —
 * bundled (KB-shipped templates), user (anything else), and system
 * (KB-managed virtual entries flagged `isSystem`). The split keeps
 * the always-present "Claude (default)" pinned at the bottom while
 * the existing employee-id sorting still applies inside each group.
 *
 * "Bundled" is approximated by the presence of an `employeeId`
 * because every KB-shipped template carries one in its frontmatter
 * (kovito-concierge / kovito-developer / etc.) while user-authored
 * agents typically omit it. This avoids changing the agent file
 * format just to flag bundled status.
 */
function partitionAgents(agents: AgentInfo[]): {
  bundled: AgentInfo[]
  user: AgentInfo[]
  system: AgentInfo[]
} {
  const bundled: AgentInfo[] = []
  const user: AgentInfo[] = []
  const system: AgentInfo[] = []
  for (const agent of agents) {
    if (agent.isSystem) system.push(agent)
    else if (agent.employeeId) bundled.push(agent)
    else user.push(agent)
  }
  return {
    bundled: sortByEmployeeId(bundled),
    user: sortByEmployeeId(user),
    system,
  }
}

export function AgentList({ agents, onSelectAgent, onAddAgent, theme = 'dark' }: AgentListProps) {
  const { bundled, user, system } = partitionAgents(agents)
  const renderableAgents = agents.filter((a) => !a.isSystem)

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-secondary)]">{t('agent.list.title')}</h2>
          <p className="text-sm text-[var(--text-dim)] mt-1">
            {t('agent.list.description', { count: renderableAgents.length })}
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
            {t('agent.list.button.add')}
          </button>
        )}
      </div>

      {/* Sections: bundled → user → system. Each section renders only
          when it has at least one entry so the page stays compact for
          first-time users (who only see system + maybe bundled). */}
      {bundled.length > 0 && (
        <AgentSection
          titleKey="agent.list.section.bundled"
          agents={bundled}
          onSelectAgent={onSelectAgent}
          theme={theme}
        />
      )}
      {user.length > 0 && (
        <AgentSection
          titleKey="agent.list.section.user"
          agents={user}
          onSelectAgent={onSelectAgent}
          theme={theme}
        />
      )}
      {system.length > 0 && (
        <AgentSection
          titleKey="agent.list.section.system"
          agents={system}
          onSelectAgent={onSelectAgent}
          theme={theme}
        />
      )}

      {renderableAgents.length === 0 && (
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
              <h3 className="text-base font-semibold text-[var(--text-secondary)]">{t('agent.list.empty')}</h3>
              <p className="text-sm text-[var(--text-dim)] mt-1">
                {t('agent.list.emptyHint')}
              </p>
            </div>

            {/* Steps */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-[var(--text-tertiary)]">{t('agent.list.guide.title')}</h4>
              <ol className="space-y-2 text-sm text-[var(--text-muted)]">
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">1</span>
                  <span>{t('agent.list.guide.step1')}</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">2</span>
                  <span>{t('agent.list.guide.step2')}</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">3</span>
                  <span>{t('agent.list.guide.step3')}</span>
                </li>
              </ol>
            </div>

            {/* Template example */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-[var(--text-tertiary)]">{t('agent.list.guide.templateTitle')}</h4>
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
              {t('agent.list.guide.restartHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Single grouping (bundled / user / system) inside the agent list.
 * Pulled out so each group can have its own divider + label without
 * blowing up the main render branch.
 *
 * `titleKey` accepts the same keys exposed in i18n/{ja,en}.ts under
 * `agent.list.section.*`.
 */
function AgentSection({
  titleKey,
  agents,
  onSelectAgent,
  theme,
}: {
  titleKey: 'agent.list.section.bundled' | 'agent.list.section.user' | 'agent.list.section.system'
  agents: AgentInfo[]
  onSelectAgent: (agentId: string) => void
  theme: 'dark' | 'light'
}) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-dim)]">
          {t(titleKey)}
        </h3>
        <div className="flex-1 h-px bg-[var(--border)]" aria-hidden />
        <span className="text-[10px] text-[var(--text-faint)]">
          {agents.length}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onSelect={() => onSelectAgent(agent.id)}
            theme={theme}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Single agent card. Extracted from the inline JSX to keep
 * AgentSection readable and to make the system-agent rendering
 * (which wants to swap the role chip for a "System" badge) trivial
 * to override later if needed.
 */
function AgentCard({
  agent,
  onSelect,
  theme,
}: {
  agent: AgentInfo
  onSelect: () => void
  theme: 'dark' | 'light'
}) {
  return (
    <button
      onClick={onSelect}
      className="group text-left rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-[var(--accent-shadow)]"
    >
      {/* Card top: gradient background */}
      <div
        className="px-5 pt-5 pb-4 relative"
        style={{
          background: `linear-gradient(135deg, ${agent.color}22, ${agent.color}08)`,
        }}
      >
        {/* Active badge */}
        {agent.activeSessionCount > 0 && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-green-500/20 text-green-400 text-[10px] font-medium px-2 py-0.5 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Active
          </div>
        )}

        {/* Avatar + name */}
        <div className="flex items-center gap-3 mb-3">
          <AgentAvatar
            name={getAgentDisplayName(agent)}
            color={agent.color}
            size={64}
            avatar={agent.avatar}
            agentId={agent.id}
            theme={theme}
          />
          <div className="min-w-0">
            <div className="text-base font-semibold text-[var(--text-primary)] group-hover:text-white transition-colors">
              {getAgentDisplayName(agent)}
            </div>
            {agent.origin && (
              <div className="text-xs text-[var(--text-dim)] truncate">{agent.origin}</div>
            )}
          </div>
        </div>

        {/* Role */}
        {getAgentRole(agent) && (
          <div
            className="inline-block text-xs font-medium px-2.5 py-1 rounded-full mb-2"
            style={{
              backgroundColor: `${agent.color}25`,
              color: agent.color,
              borderWidth: 1,
              borderColor: `${agent.color}30`,
            }}
          >
            {getAgentRole(agent)}
          </div>
        )}
      </div>

      {/* Card bottom: detail information */}
      <div className="px-5 py-4 bg-[var(--bg-elevated)] border-t border-[var(--border)] group-hover:bg-[var(--bg-hover)] transition-colors">
        {agent.summary && (
          <p className="text-xs text-[var(--text-tertiary)] mb-2 font-medium leading-relaxed">
            {agent.summary}
          </p>
        )}
        <p className="text-xs text-[var(--text-muted)] mb-3 line-clamp-2 leading-relaxed">
          {getAgentDescription(agent)}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-[var(--text-faint)]"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="text-[11px] text-[var(--text-dim)]">{shortModel(agent.model)}</span>
            </div>

            <div className="flex items-center gap-1">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-[var(--text-faint)]"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="text-[11px] text-[var(--text-dim)]">
                {agent.totalSessionCount} sessions
              </span>
            </div>
          </div>

          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-[var(--text-faint)] group-hover:text-[var(--text-muted)] transition-colors"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </button>
  )
}
