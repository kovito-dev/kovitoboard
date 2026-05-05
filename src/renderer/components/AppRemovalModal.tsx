/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * AppRemovalModal — 2-stage modal that drives the v0.1.0 app
 * removal flow.
 *
 *   Stage 1 ("confirm")   : explain what will be removed, ask the
 *                            user to proceed.
 *   Stage 2 ("pickAgent") : agent picker. On submit, invokes the
 *                            parent's `onConfirm(agentId)` so the
 *                            parent can POST `/api/apps/<appId>/request-removal`
 *                            and navigate.
 *
 * Spec: docs/specs/v0.1.0-app-removal-flow.md §4 / F3 / F4.
 *
 * UI references:
 *   - Modal chrome / Escape: `RecipeInstallAgentPickerModal.tsx`.
 *   - Agent list styling: `AppCreateModal.tsx` agent list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from '../i18n'
import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'

type Stage = 'confirm' | 'pickAgent'

interface AppRemovalModalProps {
  /** KB-local app identifier. Used in the bullet text. */
  appId: string
  /** Display name for the heading. */
  displayName: string
  agents: AgentInfo[]
  /** Default-selected agent id. */
  defaultAgentId?: string
  isSubmitting: boolean
  /** Inline error to display (e.g. removal POST failure). */
  error?: string | null
  theme?: 'dark' | 'light'
  onCancel: () => void
  /** Submit handler. Resolves on success (parent navigates away). */
  onConfirm: (agentId: string) => Promise<void> | void
}

export function AppRemovalModal({
  appId,
  displayName,
  agents,
  defaultAgentId = 'kovito-developer',
  isSubmitting,
  error,
  theme = 'dark',
  onCancel,
  onConfirm,
}: AppRemovalModalProps) {
  const [stage, setStage] = useState<Stage>('confirm')

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
      if (e.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSubmitting, onCancel])

  const handleProceed = useCallback(() => {
    if (agents.length === 0) return
    setStage('pickAgent')
  }, [agents.length])

  const handleSubmit = useCallback(async () => {
    if (selectedAgentId === null || isSubmitting) return
    await onConfirm(selectedAgentId)
  }, [selectedAgentId, isSubmitting, onConfirm])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="app-removal-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-removal-modal-title"
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
            id="app-removal-modal-title"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            {stage === 'confirm'
              ? t('appRemoval.modal.title', { name: displayName })
              : t('appRemoval.picker.title')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            data-testid="app-removal-modal-close"
            aria-label={t('appRemoval.modal.close')}
            className="text-[var(--text-dim)] hover:text-[var(--text-secondary)] disabled:opacity-40 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          {stage === 'confirm' ? (
            <>
              <p className="text-[var(--text-primary)]">
                {t('appRemoval.modal.body', { name: displayName })}
              </p>
              <ul
                className="list-disc list-inside text-[var(--text-secondary)] space-y-1 pl-2"
                data-testid="app-removal-bullets"
              >
                <li>{t('appRemoval.modal.bullet.menu')}</li>
                <li>{t('appRemoval.modal.bullet.code', { appId })}</li>
                <li>{t('appRemoval.modal.bullet.data', { appId })}</li>
              </ul>
              <p className="text-[var(--text-secondary)]">
                {t('appRemoval.modal.agentNote')}
              </p>
              {agents.length === 0 && (
                <div
                  data-testid="app-removal-no-agents"
                  role="alert"
                  className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                >
                  {t('appRemoval.error.noAgents')}
                </div>
              )}
            </>
          ) : (
            <>
              {agents.length === 0 ? (
                <div
                  data-testid="app-removal-picker-no-agents"
                  role="alert"
                  className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                >
                  {t('appRemoval.error.noAgents')}
                </div>
              ) : (
                <ul
                  role="listbox"
                  aria-label={t('appRemoval.picker.title')}
                  data-testid="app-removal-picker-list"
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
                        data-testid={`app-removal-picker-option-${agent.id}`}
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
                  data-testid="app-removal-picker-error"
                  role="alert"
                  className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          {stage === 'confirm' ? (
            <>
              <button
                type="button"
                data-testid="app-removal-modal-cancel"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"
              >
                {t('appRemoval.modal.button.cancel')}
              </button>
              <button
                type="button"
                data-testid="app-removal-modal-proceed"
                onClick={handleProceed}
                disabled={agents.length === 0}
                className="px-3 py-1.5 text-sm bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg hover:opacity-80 disabled:opacity-40 transition-opacity font-medium"
              >
                {t('appRemoval.modal.button.proceed')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="app-removal-picker-cancel"
                onClick={onCancel}
                disabled={isSubmitting}
                className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-colors"
              >
                {t('appRemoval.picker.button.cancel')}
              </button>
              <button
                type="button"
                data-testid="app-removal-picker-confirm"
                onClick={handleSubmit}
                disabled={selectedAgentId === null || isSubmitting || agents.length === 0}
                className="px-3 py-1.5 text-sm bg-red-500/80 text-white rounded-lg hover:bg-red-500 disabled:opacity-40 transition-colors font-medium"
              >
                {t('appRemoval.picker.button.confirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
