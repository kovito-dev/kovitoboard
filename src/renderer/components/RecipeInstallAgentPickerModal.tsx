/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent picker modal shown after the recipe install warning is
 * dismissed (or skipped for pure-declarative recipes). The user
 * picks the agent that will walk them through the 7-step install
 * playbook embedded in the v2.0 install prompt.
 *
 * Spec: docs/specs/v0.1.0-recipe-install-handover.md F1 / §3.1.
 *
 * UI references:
 *  - Modal chrome / Escape: `AppCreateModal.tsx`, `RecipeInstallModal.tsx`
 *  - Agent list styling: `AppCreateModal.tsx` agent list (this file
 *    intentionally duplicates the styling rather than abstracting it
 *    out — the two flows differ in submit semantics and inputs, and
 *    a shared component would only obscure that).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from '../i18n'
import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface RecipeInstallAgentPickerModalProps {
  recipeName: string
  agents: AgentInfo[]
  /** Default-selected agent id. Falls back to `kovito-developer`,
   *  then to the first agent in the list. */
  defaultAgentId?: string
  isInstalling: boolean
  /** Inline error to display (e.g. install POST failure). */
  error?: string | null
  theme?: 'dark' | 'light'
  onCancel: () => void
  /** Submit handler. Resolves on success (parent navigates away).
   *  Rejects on failure — the modal stays open and surfaces the
   *  error inline so the user can retry. */
  onConfirm: (agentId: string) => Promise<void> | void
}

export function RecipeInstallAgentPickerModal({
  recipeName,
  agents,
  defaultAgentId = 'kovito-developer',
  isInstalling,
  error,
  theme = 'dark',
  onCancel,
  onConfirm,
}: RecipeInstallAgentPickerModalProps) {
  const initialAgentId = useMemo(() => {
    if (agents.length === 0) return null
    const preferred = agents.find((a) => a.id === defaultAgentId)
    return (preferred ?? agents[0]).id
  }, [agents, defaultAgentId])

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId)

  useEffect(() => {
    setSelectedAgentId(initialAgentId)
  }, [initialAgentId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isInstalling) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isInstalling, onCancel])

  const handleSubmit = useCallback(async () => {
    if (selectedAgentId === null || isInstalling) return
    await onConfirm(selectedAgentId)
  }, [selectedAgentId, isInstalling, onConfirm])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="recipe-install-agent-picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-install-picker-title"
    >
      <div
        className="
          relative bg-[var(--bg-base)] border border-[var(--border)]
          rounded-lg shadow-2xl
          w-full max-w-md max-h-[85vh] flex flex-col
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <h3
            id="recipe-install-picker-title"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            {t('recipe.install.picker.title')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={isInstalling}
            data-testid="recipe-install-picker-close"
            aria-label={t('recipe.install.picker.cancel')}
            className="text-[var(--text-dim)] hover:text-[var(--text-secondary)] disabled:opacity-40 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          <p className="text-[var(--text-secondary)]">
            {t('recipe.install.picker.body', { name: recipeName })}
          </p>

          {agents.length === 0 ? (
            <div
              data-testid="recipe-install-picker-no-agents"
              role="alert"
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
            >
              {t('recipe.install.picker.noAgents')}
            </div>
          ) : (
            <ul
              role="listbox"
              aria-label={t('recipe.install.picker.title')}
              data-testid="recipe-install-picker-list"
              className="
                rounded-lg border border-[var(--border)]
                bg-[var(--bg-elevated)]
                max-h-60 overflow-y-auto
                divide-y divide-[var(--border)]
              "
            >
              {agents.map((agent) => {
                const isSelected = agent.id === selectedAgentId
                return (
                  <li
                    key={agent.id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    data-testid={`recipe-install-picker-option-${agent.id}`}
                    onClick={() => setSelectedAgentId(agent.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedAgentId(agent.id)
                      }
                    }}
                    className={`
                      flex items-center gap-2 px-3 py-2 cursor-pointer
                      hover:bg-[var(--bg-hover)] transition-colors
                      ${isSelected ? 'bg-[var(--accent-bg)]/30 text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}
                    `}
                  >
                    <AgentAvatar
                      name={agent.displayName}
                      color={agent.color}
                      avatar={agent.avatar}
                      agentId={agent.id}
                      size={20}
                      theme={theme}
                    />
                    <span className="flex-1 truncate">{agent.displayName}</span>
                    {isSelected && (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-[var(--accent-text)]"
                        aria-hidden="true"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {error && (
            <div
              data-testid="recipe-install-picker-error"
              role="alert"
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button
            type="button"
            data-testid="recipe-install-picker-cancel"
            onClick={onCancel}
            disabled={isInstalling}
            className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-colors"
          >
            {t('recipe.install.picker.cancel')}
          </button>
          <button
            type="button"
            data-testid="recipe-install-picker-confirm"
            onClick={handleSubmit}
            disabled={selectedAgentId === null || isInstalling || agents.length === 0}
            className="px-3 py-1.5 text-sm bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg hover:opacity-80 disabled:opacity-40 transition-opacity font-medium"
          >
            {isInstalling
              ? t('recipe.sample.status.installing')
              : t('recipe.install.picker.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
