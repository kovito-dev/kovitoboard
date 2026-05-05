/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useMemo, useState } from 'react'
import type { Session } from '../types'
import { t } from '../i18n'
import {
  computeContextTokens,
  findLatestAssistantWithUsage,
  formatElapsed,
  formatTokens,
  resolveContextWindow,
} from '../utils/session-status'

/**
 * Session status bar (Q5 / SS-4).
 *
 * Displays per-session meta information at the top of `ChatTimeline`:
 * the active model, the input-token utilisation against the model's
 * context window, and the elapsed time since the session started.
 *
 * The "effort" axis from the spec is intentionally deferred to v0.1.1
 * because the underlying concept is not yet stable in Claude Code's
 * JSONL output (architect §6.4 explicitly defers it to v0.1.1).
 *
 * Collapse state is persisted to localStorage so a user who finds the
 * bar noisy keeps it folded across reloads. The bar starts collapsed
 * — a manual-test pass on v0.1.0 found the expanded default visually
 * busy at the top of every chat, and the summary line on the toggle
 * already conveys the model and token utilisation users care about.
 * Users who want the breakdown back can click the toggle once and
 * the choice persists across reloads via localStorage.
 */

const COLLAPSE_STORAGE_KEY = 'kb.sessionStatusBar.collapsed'

function readPersistedCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    // Explicit '0' pins the bar open across reloads. Anything else —
    // including the unset case for a fresh user — folds the bar.
    return stored !== '0'
  } catch {
    return true
  }
}

function persistCollapsed(value: boolean): void {
  try {
    // Persist both states explicitly. We can no longer rely on
    // "absent → expanded" because the default flipped to collapsed.
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // best-effort
  }
}

export interface SessionStatusBarProps {
  session: Session
}

export function SessionStatusBar({ session }: SessionStatusBarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readPersistedCollapsed())
  // Re-render once a minute so the elapsed time keeps moving while
  // the user is on the screen. We deliberately use a coarse cadence
  // because the formatted output is minute-resolution anyway.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])

  const latest = useMemo(() => findLatestAssistantWithUsage(session.events), [session.events])
  const model = latest?.model
  // Sum input + cache-creation + cache-read tokens. Anthropic charges
  // these separately but every one of them still occupies a slot in
  // the prompt that Claude sees, so context-window utilisation is the
  // sum. Showing `inputTokens` alone collapsed to single-digit numbers
  // once the prompt cache warmed up.
  const contextTokens = useMemo(
    () => (latest ? computeContextTokens(latest) : null),
    [latest],
  )
  const contextWindow = useMemo(() => resolveContextWindow(model), [model])
  const contextPercent = useMemo(() => {
    if (typeof contextTokens !== 'number') return null
    return Math.min(100, Math.round((contextTokens / contextWindow) * 100))
  }, [contextTokens, contextWindow])

  const elapsedMs = useMemo(() => {
    const started = Date.parse(session.startedAt)
    if (Number.isNaN(started)) return 0
    return Math.max(0, now - started)
  }, [session.startedAt, now])

  const handleToggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      persistCollapsed(next)
      return next
    })
  }

  const notSet = t('sessionStatus.value.notSet')
  const modelLabel = model ?? notSet
  const tokenLabel =
    typeof contextTokens === 'number' && contextPercent !== null
      ? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`
      : notSet

  return (
    <div
      className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)]"
      data-testid="session-status-bar"
    >
      <button
        type="button"
        onClick={handleToggle}
        className="w-full px-3 py-1.5 flex items-center justify-between gap-3 text-[11px] text-[var(--text-dim)] hover:text-[var(--text-tertiary)] transition-colors"
        aria-expanded={!collapsed}
        aria-controls="session-status-bar-content"
        data-testid="session-status-bar-toggle"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <span className="font-medium">{t('sessionStatus.title')}</span>
        </span>
        {collapsed && (
          <span className="font-mono text-[10px] truncate" data-testid="session-status-bar-summary">
            {modelLabel} · {tokenLabel}
          </span>
        )}
      </button>
      {!collapsed && (
        <div
          id="session-status-bar-content"
          className="px-3 pb-2 grid grid-cols-3 gap-3 text-[11px]"
        >
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              {t('sessionStatus.label.model')}
            </span>
            <span
              className="font-mono text-[var(--text-tertiary)] truncate"
              title={modelLabel}
              data-testid="session-status-model"
            >
              {modelLabel}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              {t('sessionStatus.label.context')}
            </span>
            <span
              className="font-mono text-[var(--text-tertiary)] truncate"
              title={tokenLabel}
              data-testid="session-status-context"
            >
              {tokenLabel}
            </span>
            {contextPercent !== null && (
              <div
                className="mt-1 h-1 rounded-full bg-[var(--bg-elevated)] overflow-hidden"
                aria-hidden
              >
                <div
                  className="h-full bg-[var(--accent-bg)]"
                  style={{ width: `${contextPercent}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              {t('sessionStatus.label.elapsed')}
            </span>
            <span
              className="font-mono text-[var(--text-tertiary)]"
              data-testid="session-status-elapsed"
            >
              {formatElapsed(elapsedMs)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
