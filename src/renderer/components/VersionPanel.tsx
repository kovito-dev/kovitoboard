/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import { ConfirmModal } from './ConfirmModal'
import { createLogger } from '../lib/logger'
import type { AgentInfo } from '../types'
import type { UseVersionInfoResult } from '../hooks/useVersionInfo'
import { kbFetch } from '../lib/kbFetch'

const log = createLogger('VersionPanel')

/** Default agent picked when present in /api/agents (per Konsuke-san
 *  guidance, 2026-04-27): kovito-concierge tends to be the agent the
 *  user actually has installed. Falls back to the first available
 *  agent when concierge is absent. */
const PREFERRED_DEFAULT_AGENT = 'kovito-concierge'

/**
 * VersionPanel — popover-embedded "Versions" section
 * (`v0.1.0-version-display.md` §2.1 / §5.2).
 *
 * Displayed inside StatusIndicator's popover. Shows the running KB +
 * Claude Code versions, the upstream comparison result, and a manual
 * "recheck now" affordance. The "Request upgrade" button arrives in
 * Phase C; this Phase-B panel renders the Versions surface only.
 *
 * State source: a `useVersionInfo` instance lifted up to TitleBar so
 * VersionHeaderBadge and this panel never disagree.
 */

interface VersionPanelProps {
  versionInfo: UseVersionInfoResult
}

export function VersionPanel({ versionInfo }: VersionPanelProps) {
  const { data, loading, rechecking, recheck, startUpgrade, error } = versionInfo
  const navigate = useNavigate()

  // --- Agent picker for the upgrade dispatch ---
  // Fetched independently rather than threaded through props because
  // the panel is mounted on demand (popover open) and the data is
  // small + cacheable. Spec §6 / Konsuke-san 2026-04-27: default to
  // kovito-concierge, fall back to the first agent, disable the
  // button when no agents exist.
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dispatching, setDispatching] = useState(false)

  useEffect(() => {
    let cancelled = false
    kbFetch('/api/agents')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: AgentInfo[]) => {
        if (cancelled) return
        setAgents(list)
        // Honor the preferred default when present; otherwise pick the first.
        const preferred = list.find((a) => a.id === PREFERRED_DEFAULT_AGENT)
        setSelectedAgent(preferred?.id ?? list[0]?.id ?? '')
      })
      .catch((err) => {
        if (cancelled) return
        log.warn({ err }, 'Failed to fetch /api/agents for upgrade picker')
        setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const isOutdated = useMemo<boolean>(() => {
    if (!data) return false
    const { kb, config } = data
    if (config.disabledBy !== null) return false
    return !kb.isUpToDate && kb.latestFetchSucceeded && kb.latest !== null
  }, [data])

  const dispatchUpgrade = async () => {
    if (!selectedAgent) return
    setConfirmOpen(false)
    setDispatching(true)
    try {
      const result = await startUpgrade(selectedAgent)
      // Per spec §6.1, route the user into the live agent surface.
      // Tmux launches don't surface a sessionId synchronously, so we
      // navigate to /sessions to surface the session list — once the
      // watcher picks up the JSONL, the new session shows up there.
      navigate('/sessions')
      log.info(
        { agentId: selectedAgent, via: result.via, windowName: result.windowName },
        'Upgrade dispatch succeeded',
      )
    } catch (err) {
      log.warn({ err, agentId: selectedAgent }, 'Upgrade dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  if (loading) {
    return (
      <div
        data-testid="version-panel"
        data-state="loading"
        className="px-4 py-3 border-t border-[var(--border)] text-xs text-[var(--text-faint)]"
      >
        {t('version.loading')}
      </div>
    )
  }

  if (!data) {
    return (
      <div
        data-testid="version-panel"
        data-state="error"
        className="px-4 py-3 border-t border-[var(--border)] text-xs text-[var(--text-faint)]"
      >
        {error ?? t('version.loadFailed')}
      </div>
    )
  }

  const { kb, claudeCode, config } = data

  return (
    <div
      data-testid="version-panel"
      data-state="ready"
      className="px-4 py-3 border-t border-[var(--border)] space-y-3 text-xs"
    >
      <div className="text-[var(--text-tertiary)] font-semibold uppercase tracking-wide text-[10px]">
        {t('version.section.title')}
      </div>

      {/* KB section */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[var(--text-secondary)] font-medium">
            {t('version.kb.label')}
          </span>
          <span
            data-testid="version-panel-kb-current"
            className="font-mono text-[var(--text-secondary)]"
          >
            v{kb.current}
          </span>
        </div>
        <KbStatusLine
          kb={kb}
          disabledBy={config.disabledBy}
        />
        {/* Recheck button: hidden when disabled (no point) */}
        {config.disabledBy === null && (
          <button
            type="button"
            data-testid="version-panel-recheck"
            onClick={() => {
              void recheck()
            }}
            disabled={rechecking}
            className="
              text-[10px] px-2 py-0.5 rounded
              text-[var(--text-muted)] hover:text-[var(--text-secondary)]
              hover:bg-[var(--bg-surface)] transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            {rechecking ? t('version.kb.rechecking') : t('version.kb.recheckButton')}
          </button>
        )}

        {/* Upgrade dispatch — only when KB is actually outdated. */}
        {isOutdated && (
          <UpgradeDispatchRow
            agents={agents}
            selectedAgent={selectedAgent}
            setSelectedAgent={setSelectedAgent}
            onClickUpgrade={() => setConfirmOpen(true)}
            dispatching={dispatching}
          />
        )}
      </div>

      {/* Confirmation modal — gates the upgrade dispatch */}
      <ConfirmModal
        isOpen={confirmOpen}
        title={t('version.upgrade.confirm.title')}
        body={
          <div className="space-y-2 text-sm">
            <p>
              {t('version.upgrade.confirm.body', {
                agentId: selectedAgent || '?',
                latest: kb.latest ?? '?',
              })}
            </p>
            <p className="text-xs text-[var(--text-faint)]">
              {t('version.upgrade.confirm.note')}
            </p>
          </div>
        }
        confirmLabel={t('version.upgrade.confirm.ok')}
        onConfirm={() => {
          void dispatchUpgrade()
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Claude Code section */}
      <div className="space-y-1 pt-2 border-t border-[var(--border)]/50">
        <div className="flex items-baseline justify-between">
          <span className="text-[var(--text-secondary)] font-medium">
            {t('version.claudeCode.label')}
          </span>
          <span
            data-testid="version-panel-claude-current"
            className="font-mono text-[var(--text-secondary)]"
          >
            {claudeCode.detected ?? '—'}
          </span>
        </div>
        <ClaudeCodeStatusLine claudeCode={claudeCode} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function UpgradeDispatchRow({
  agents,
  selectedAgent,
  setSelectedAgent,
  onClickUpgrade,
  dispatching,
}: {
  agents: AgentInfo[] | null
  selectedAgent: string
  setSelectedAgent: (id: string) => void
  onClickUpgrade: () => void
  dispatching: boolean
}) {
  if (agents === null) {
    return (
      <p className="text-[10px] text-[var(--text-faint)]">
        {t('version.upgrade.loadingAgents')}
      </p>
    )
  }
  if (agents.length === 0) {
    return (
      <p className="text-[10px] text-[var(--text-faint)]" data-testid="version-panel-upgrade-no-agents">
        {t('version.upgrade.noAgents')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5 mt-1" data-testid="version-panel-upgrade-row">
      <label
        htmlFor="version-panel-agent-picker"
        className="text-[10px] text-[var(--text-muted)]"
      >
        {t('version.upgrade.agentLabel')}
      </label>
      <select
        id="version-panel-agent-picker"
        data-testid="version-panel-agent-picker"
        value={selectedAgent}
        onChange={(e) => setSelectedAgent(e.target.value)}
        disabled={dispatching}
        className="
          text-xs rounded border border-[var(--border)]
          bg-[var(--bg-surface)] text-[var(--text-secondary)]
          px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
          disabled:opacity-50 disabled:cursor-not-allowed
        "
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.displayName} ({agent.id})
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="version-panel-upgrade-button"
        onClick={onClickUpgrade}
        disabled={dispatching || !selectedAgent}
        className="
          text-xs px-3 py-1 rounded self-start
          bg-amber-500/80 text-white hover:bg-amber-500
          disabled:opacity-40 disabled:cursor-not-allowed
          transition-colors
        "
      >
        {dispatching ? t('version.upgrade.dispatching') : t('version.kb.upgradeButton')}
      </button>
    </div>
  )
}

function KbStatusLine({
  kb,
  disabledBy,
}: {
  kb: { latest: string | null; latestFetchSucceeded: boolean; isUpToDate: boolean }
  disabledBy: 'env' | 'config' | null
}) {
  if (disabledBy !== null) {
    return (
      <p className="text-[var(--text-faint)] italic">
        {disabledBy === 'env'
          ? t('version.kb.disabledByEnv')
          : t('version.kb.disabledByConfig')}
      </p>
    )
  }
  if (!kb.latestFetchSucceeded) {
    return (
      <p
        data-testid="version-panel-kb-status"
        data-status="fetch-failed"
        className="text-[var(--text-faint)]"
      >
        {t('version.kb.fetchFailed')}
      </p>
    )
  }
  if (kb.isUpToDate) {
    return (
      <p
        data-testid="version-panel-kb-status"
        data-status="up-to-date"
        className="text-emerald-400"
      >
        {t('version.kb.upToDate')}
      </p>
    )
  }
  return (
    <p
      data-testid="version-panel-kb-status"
      data-status="outdated"
      className="text-amber-400"
    >
      {t('version.kb.outdated', { latest: kb.latest ?? '?' })}
    </p>
  )
}

function ClaudeCodeStatusLine({
  claudeCode,
}: {
  claudeCode: { detected: string | null; primaryTested: string; tier: 'primary' | 'best-effort' | 'out-of-range' | 'unknown' }
}) {
  if (claudeCode.detected === null) {
    return (
      <p
        data-testid="version-panel-claude-status"
        data-tier="unknown"
        className="text-[var(--text-faint)]"
      >
        {t('version.claudeCode.notDetected')}
      </p>
    )
  }
  if (claudeCode.tier === 'primary') {
    return (
      <p
        data-testid="version-panel-claude-status"
        data-tier="primary"
        className="text-emerald-400"
      >
        {t('version.claudeCode.primary')}
      </p>
    )
  }
  if (claudeCode.tier === 'best-effort') {
    return (
      <p
        data-testid="version-panel-claude-status"
        data-tier="best-effort"
        className="text-amber-400"
      >
        {t('version.claudeCode.bestEffort', { primary: claudeCode.primaryTested })}
      </p>
    )
  }
  return (
    <p
      data-testid="version-panel-claude-status"
      data-tier="out-of-range"
      className="text-red-400"
    >
      {t('version.claudeCode.outOfRange', { primary: claudeCode.primaryTested })}
    </p>
  )
}
