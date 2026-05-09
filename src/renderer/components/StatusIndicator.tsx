/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Server status indicator + admin popover.
 *
 * Renders a small colored circle in the header. Clicking it opens
 * a popover showing server health, tmux, agent status, and admin
 * actions (restart / stop / per-agent restart).
 *
 * @see DEC-016 (dev-mode canonical)
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { t } from '../i18n'
import { ConfirmModal } from './ConfirmModal'
import { useToast } from './Toast'
import { VersionPanel } from './VersionPanel'
import type { IndicatorState, AdminStatusData } from '../hooks/useAdminStatus'
import type { UseVersionInfoResult } from '../hooks/useVersionInfo'
import { kbFetch } from '../lib/kbFetch'

interface StatusIndicatorProps {
  indicatorState: IndicatorState
  data: AdminStatusData | null
  wsConnected: boolean
  /** Called after POST /api/admin/stop succeeds */
  onStopped: () => void
  /**
   * Version info from useVersionInfo (lifted up to TitleBar so it
   * can also feed the header badge). Optional so the legacy callers
   * keep working without surfacing the Versions panel.
   */
  versionInfo?: UseVersionInfoResult
  /**
   * External signal to force the popover open. Used by
   * VersionHeaderBadge so clicking the warning chip drops the user
   * straight onto the matching VersionPanel section. Counter-based
   * (rather than boolean) so each click reliably toggles the
   * popover open even if it was already open.
   */
  forceOpenSignal?: number
}

/** Format milliseconds as a human-readable duration */
function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  const remainMin = min % 60
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`
}

// ---------------------------------------------------------------------------
// Indicator dot colors / icons
// ---------------------------------------------------------------------------

function IndicatorDot({ state }: { state: IndicatorState }) {
  const colorClass =
    state === 'healthy'
      ? 'bg-emerald-400'
      : state === 'degraded'
        ? 'bg-yellow-400'
        : state === 'down'
          ? 'bg-red-500'
          : 'bg-gray-400'

  return <span className={`block w-2.5 h-2.5 rounded-full ${colorClass}`} />
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StatusIndicator({
  indicatorState,
  data,
  wsConnected,
  onStopped,
  versionInfo,
  forceOpenSignal,
}: StatusIndicatorProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  // Open the popover whenever the parent's forceOpenSignal increments.
  // Using a counter (not a boolean) avoids the "stuck open" pitfall:
  // each click on the header badge bumps the signal and we react to
  // the change, not to a steady-state value.
  useEffect(() => {
    if (forceOpenSignal !== undefined && forceOpenSignal > 0) {
      setPopoverOpen(true)
    }
  }, [forceOpenSignal])
  const [confirmAction, setConfirmAction] = useState<
    'restart' | 'stop' | { type: 'agent'; agentId: string; agentName: string } | null
  >(null)
  const [restartingAgents, setRestartingAgents] = useState<Set<string>>(new Set())

  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { addToast } = useToast()

  // Git checkout state for the SP-3 row in the popover. Lazy-fetched
  // when the popover opens so we do not poll the git binary on every
  // 5s admin/status tick. Cleared between opens so a stale `(dirty)`
  // flag from a previous popover doesn't linger after the user
  // committed in another terminal.
  const [gitStatus, setGitStatus] = useState<
    | { tracked: false }
    | { tracked: true; branch: string | null; sha: string | null; dirty: boolean }
    | null
  >(null)
  useEffect(() => {
    if (!popoverOpen) {
      setGitStatus(null)
      return
    }
    let cancelled = false
    kbFetch('/api/admin/git-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setGitStatus(j)
      })
      .catch(() => {
        // Silently ignore — popover row simply stays "—".
      })
    return () => {
      cancelled = true
    }
  }, [popoverOpen])

  // Monitor WS reconnection after server restart
  const waitingForRestart = useRef(false)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (waitingForRestart.current && wsConnected) {
      // Server came back
      waitingForRestart.current = false
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      addToast(t('admin.restart.done'), 'success')
    }
  }, [wsConnected, addToast])

  // Click-outside handler for popover
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  // ESC key to close popover
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [popoverOpen])

  // Handle WS agent_restarted events (clear loading state)
  // This is handled via prop data refresh; we clear restartingAgents when
  // the data changes and the agent is back in the list.
  useEffect(() => {
    if (!data?.agents) return
    const runningIds = new Set(data.agents.map((a) => a.id))
    setRestartingAgents((prev) => {
      const next = new Set<string>()
      for (const id of prev) {
        if (!runningIds.has(id)) next.add(id)
      }
      return next.size === prev.size ? prev : next
    })
  }, [data?.agents])

  // --- Actions ---

  const handleRestart = useCallback(async () => {
    setConfirmAction(null)
    setPopoverOpen(false)
    addToast(t('admin.restart.progress'), 'info')
    waitingForRestart.current = true

    try {
      await kbFetch('/api/admin/restart', { method: 'POST' })
    } catch {
      // Expected — server is shutting down
    }

    // Timeout: if WS doesn't reconnect in 10s, show error
    restartTimerRef.current = setTimeout(() => {
      if (waitingForRestart.current) {
        waitingForRestart.current = false
        addToast(t('admin.restart.failed'), 'error')
      }
    }, 10_000)
  }, [addToast])

  const handleStop = useCallback(async () => {
    setConfirmAction(null)
    setPopoverOpen(false)

    try {
      await kbFetch('/api/admin/stop', { method: 'POST' })
    } catch {
      // Expected
    }

    addToast(t('admin.stop.done'), 'info')
    onStopped()
  }, [addToast, onStopped])

  const handleAgentRestart = useCallback(
    async (agentId: string, agentName: string) => {
      setConfirmAction(null)
      setRestartingAgents((prev) => new Set(prev).add(agentId))
      addToast(t('admin.agent.restart.progress', { agentName }), 'info')

      try {
        const res = await kbFetch(`/api/agents/${agentId}/restart`, {
          method: 'POST',
        })
        if (res.ok) {
          addToast(t('admin.agent.restart.done', { agentName }), 'success')
        } else {
          addToast(t('admin.agent.restart.failed', { agentName }), 'error')
        }
      } catch {
        addToast(t('admin.agent.restart.failed', { agentName }), 'error')
      } finally {
        setRestartingAgents((prev) => {
          const next = new Set(prev)
          next.delete(agentId)
          return next
        })
      }
    },
    [addToast],
  )

  // --- Render helpers ---

  const statusLabel =
    indicatorState === 'healthy'
      ? t('admin.status.healthy')
      : indicatorState === 'degraded'
        ? t('admin.status.degraded')
        : indicatorState === 'down'
          ? t('admin.status.down')
          : t('admin.status.unknown')

  return (
    <div className="relative">
      {/* Indicator button */}
      <button
        ref={buttonRef}
        onClick={() => setPopoverOpen(!popoverOpen)}
        className="p-1.5 md:p-2 rounded-full transition-all duration-150 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20 flex items-center justify-center"
        title={t('admin.status.indicator.title')}
      >
        <IndicatorDot state={indicatorState} />
      </button>

      {/* Popover */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-2 w-72 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl shadow-2xl z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <IndicatorDot state={indicatorState} />
            <span className="text-sm font-medium text-[var(--text-secondary)]">
              {statusLabel}
            </span>
          </div>

          {/* Status details */}
          <div className="px-4 py-3 space-y-2 text-xs text-[var(--text-muted)]">
            {/* Backend */}
            <StatusRow label={t('admin.status.be')}>
              {data
                ? t('admin.status.uptime', {
                    duration: formatUptime(data.be.uptimeMs),
                  })
                : '—'}
            </StatusRow>

            {/* Server URL — surfaces the actual frontend port the
                supervisor probed onto. Useful when 5173 was busy and
                the user was punted to 5174 / 5175 / etc. (SP-2). */}
            <StatusRow label={t('admin.status.url')}>
              <span className="font-mono text-[var(--text-secondary)]">
                {`${location.protocol}//${location.host}`}
              </span>
            </StatusRow>

            {/* Git checkout state — branch + short sha + dirty flag.
                Renders "Not a git checkout" when KB was installed
                without a .git directory (npm package / zip / etc.,
                SP-3). */}
            <StatusRow label={t('admin.status.git')}>
              {gitStatus
                ? gitStatus.tracked
                  ? (
                      <span className="font-mono text-[var(--text-secondary)]">
                        {gitStatus.branch ?? 'detached'}
                        {gitStatus.sha ? ` @ ${gitStatus.sha}` : ''}
                        {gitStatus.dirty ? ' *' : ''}
                      </span>
                    )
                  : t('admin.status.git.untracked')
                : '—'}
            </StatusRow>

            {/* tmux */}
            <StatusRow label={t('admin.status.tmux')}>
              {data
                ? data.tmux.alive
                  ? `✓ ${data.tmux.session}`
                  : '✗ not running'
                : '—'}
            </StatusRow>

            {/* Agents */}
            <StatusRow label={t('admin.status.agents')}>
              {data
                ? t('admin.status.activeCount', {
                    count: data.agents.length,
                  })
                : '—'}
            </StatusRow>

            {/* Agent list with restart buttons */}
            {data?.agents && data.agents.length > 0 && (
              <div className="mt-1 space-y-1">
                {data.agents.map((agent) => {
                  const isRestarting = restartingAgents.has(agent.id)
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between pl-2"
                    >
                      <span className="text-[var(--text-secondary)]">
                        • {agent.id}
                      </span>
                      <button
                        onClick={() =>
                          setConfirmAction({
                            type: 'agent',
                            agentId: agent.id,
                            agentName: agent.id,
                          })
                        }
                        disabled={isRestarting}
                        className="text-[10px] px-2 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors disabled:opacity-50"
                      >
                        {isRestarting
                          ? '...'
                          : t('admin.agent.restart.button')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Versions section (v0.1.0-version-display.md §2.1) */}
          {versionInfo && <VersionPanel versionInfo={versionInfo} />}

          {/* Server actions */}
          <div className="px-4 py-3 border-t border-[var(--border)] space-y-2">
            <button
              onClick={() => setConfirmAction('restart')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {t('admin.restart.button')}
            </button>
            <button
              onClick={() => setConfirmAction('stop')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {t('admin.stop.button')}
            </button>
          </div>
        </div>
      )}

      {/* Confirmation modals */}
      <ConfirmModal
        isOpen={confirmAction === 'restart'}
        title={t('admin.restart.confirm.title')}
        body={t('admin.restart.confirm.body')}
        confirmLabel={t('admin.restart.confirm.ok')}
        onConfirm={handleRestart}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmModal
        isOpen={confirmAction === 'stop'}
        title={t('admin.stop.confirm.title')}
        body={t('admin.stop.confirm.body')}
        confirmLabel={t('admin.stop.confirm.ok')}
        onConfirm={handleStop}
        onCancel={() => setConfirmAction(null)}
        variant="danger"
      />

      {confirmAction !== null &&
        typeof confirmAction === 'object' &&
        confirmAction.type === 'agent' && (
          <ConfirmModal
            isOpen={true}
            title={t('admin.agent.restart.confirm.title', {
              agentName: confirmAction.agentName,
            })}
            body={
              <div className="space-y-2">
                <p>{t('admin.agent.restart.confirm.body.line1')}</p>
                <ul className="space-y-1 mt-2">
                  <li className="flex items-start gap-2">
                    <span className="text-emerald-400 shrink-0">✓</span>
                    <span>
                      {t('admin.agent.restart.confirm.body.line2')}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400 shrink-0">✗</span>
                    <span>
                      {t('admin.agent.restart.confirm.body.line3')}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400 shrink-0">✗</span>
                    <span>
                      {t('admin.agent.restart.confirm.body.line4')}
                    </span>
                  </li>
                </ul>
              </div>
            }
            confirmLabel={t('admin.agent.restart.confirm.ok')}
            onConfirm={() =>
              handleAgentRestart(
                (confirmAction as { agentId: string; agentName: string }).agentId,
                (confirmAction as { agentId: string; agentName: string }).agentName,
              )
            }
            onCancel={() => setConfirmAction(null)}
          />
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-tertiary)]">{label}</span>
      <span className="text-[var(--text-secondary)]">{children}</span>
    </div>
  )
}
