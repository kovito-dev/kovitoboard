/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * AppCreateModal — entry point for the v0.1.0 "Create new app" flow
 * (spec docs/specs/v0.1.0-app-creation-flow.md, EU9). Lets the user
 * pick a target agent and describe the app they want in free-form
 * text. The submit path is handled by the parent (`onCreate`), which
 * builds the prompt, calls `startNewSession`, and navigates.
 *
 * UI references:
 * - Modal chrome / Escape handling: `RecipeInstallModal.tsx`
 * - Agent picker styling: `AmbientSidebar.tsx` AgentPicker
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import type { AgentInfo } from '../types'
import { AgentAvatar } from './AgentAvatar'

const PURPOSE_MAX = 2000
const OPTIONAL_TEXTAREA_MAX = 500
const FREQUENCY_MAX = 200

/**
 * Submission payload emitted to `onCreate`. The parent is responsible
 * for converting it into a prompt and POSTing the new session.
 */
export interface AppCreateSubmission {
  agentId: string
  purpose: string
  input?: string
  output?: string
  frequency?: string
}

interface AppCreateModalProps {
  isOpen: boolean
  agents: AgentInfo[]
  /** Default-selected agent id. Falls back to the first agent in
   *  `agents` when not present. */
  defaultAgentId?: string
  theme?: 'dark' | 'light'
  onCancel: () => void
  /** Submit handler. Resolves on success (parent navigates away).
   *  Rejects on failure — the modal stays open, surfaces the error
   *  inline, and the user can retry. */
  onCreate: (submission: AppCreateSubmission) => Promise<void>
}

export function AppCreateModal({
  isOpen,
  agents,
  defaultAgentId = 'kovito-developer',
  theme = 'dark',
  onCancel,
  onCreate,
}: AppCreateModalProps) {
  // Default selection: prefer `defaultAgentId`, otherwise the first
  // agent in the list. We recompute when `agents` changes so the
  // default tracks the live agent set.
  const initialAgentId = useMemo(() => {
    if (agents.length === 0) return null
    const preferred = agents.find((a) => a.id === defaultAgentId)
    return (preferred ?? agents[0]).id
  }, [agents, defaultAgentId])

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId)
  const [purpose, setPurpose] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [frequency, setFrequency] = useState('')
  const [showOptional, setShowOptional] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const purposeTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Reset the form whenever the modal opens fresh. Keeping the
  // optional fields collapsed by default matches spec §4.3.
  useEffect(() => {
    if (!isOpen) return
    setSelectedAgentId(initialAgentId)
    setPurpose('')
    setInput('')
    setOutput('')
    setFrequency('')
    setShowOptional(false)
    setIsSubmitting(false)
    setError(null)
    // Defer focus so the textarea exists in the DOM. We don't autofocus
    // when there are no agents — the parent will call onCancel anyway.
    if (initialAgentId) {
      requestAnimationFrame(() => {
        purposeTextareaRef.current?.focus()
      })
    }
  }, [isOpen, initialAgentId])

  // Esc closes (when not submitting). Mirrors RecipeInstallModal.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape' && !isSubmitting) {
        onCancel()
      }
    },
    [isOpen, isSubmitting, onCancel],
  )
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const purposeTrimmed = purpose.trim()
  const purposeOverLimit = purpose.length > PURPOSE_MAX
  const inputOverLimit = input.length > OPTIONAL_TEXTAREA_MAX
  const outputOverLimit = output.length > OPTIONAL_TEXTAREA_MAX
  const frequencyOverLimit = frequency.length > FREQUENCY_MAX
  const anyOverLimit = purposeOverLimit || inputOverLimit || outputOverLimit || frequencyOverLimit

  const canSubmit =
    !isSubmitting &&
    selectedAgentId !== null &&
    purposeTrimmed.length > 0 &&
    !anyOverLimit

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || selectedAgentId === null) return
    setError(null)
    setIsSubmitting(true)
    try {
      await onCreate({
        agentId: selectedAgentId,
        purpose: purposeTrimmed,
        input: input.trim() || undefined,
        output: output.trim() || undefined,
        frequency: frequency.trim() || undefined,
      })
      // Parent navigates on success; nothing else to do here. We
      // intentionally leave `isSubmitting=true` so a stale render
      // can't double-submit before the unmount.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(t('appCreate.error.sessionCreationFailed').replace('{error}', message))
      setIsSubmitting(false)
    }
  }, [canSubmit, selectedAgentId, purposeTrimmed, input, output, frequency, onCreate])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="app-create-modal-root"
    >
      {/* Overlay (click to cancel; ignored while submitting) */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isSubmitting ? undefined : onCancel}
      />

      {/* Modal body */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-create-modal-title"
        data-testid="app-create-modal"
        className="
          relative w-full max-w-xl mx-4
          bg-[var(--bg-base)] rounded-2xl
          border border-[var(--border)] shadow-2xl
          flex flex-col overflow-hidden max-h-[90vh]
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <h2
            id="app-create-modal-title"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            {t('appCreate.modal.title')}
          </h2>
          <button
            type="button"
            data-testid="app-create-modal-close"
            onClick={onCancel}
            disabled={isSubmitting}
            className="
              p-1 rounded text-[var(--text-dim)]
              hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]
              disabled:opacity-50 disabled:cursor-not-allowed
            "
            aria-label={t('appCreate.button.cancel')}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-sm">
          {/* Agent picker — vertical list per spec §4.2 */}
          <div className="space-y-2">
            <label className="block text-[var(--text-secondary)] font-medium">
              {t('appCreate.field.agent')}
            </label>
            <ul
              role="listbox"
              aria-label={t('appCreate.field.agent')}
              data-testid="app-create-agent-list"
              className="
                rounded-lg border border-[var(--border)]
                bg-[var(--bg-elevated)]
                max-h-44 overflow-y-auto
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
                    data-testid={`app-create-agent-option-${agent.id}`}
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
          </div>

          {/* Purpose (required) */}
          <div className="space-y-2">
            <label
              htmlFor="app-create-purpose"
              className="block text-[var(--text-secondary)] font-medium"
            >
              {t('appCreate.field.purpose')} <span className="text-red-400">*</span>
            </label>
            <textarea
              id="app-create-purpose"
              ref={purposeTextareaRef}
              data-testid="app-create-purpose"
              rows={5}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder={t('appCreate.field.purpose.placeholder')}
              disabled={isSubmitting}
              className="
                w-full rounded border border-[var(--border)]
                bg-[var(--bg-elevated)] text-[var(--text-primary)]
                px-3 py-2 leading-relaxed resize-y
                focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
                disabled:opacity-50 disabled:cursor-not-allowed
              "
            />
            <div className="flex items-start justify-between gap-3 text-[11px]">
              <p className="text-[var(--text-dim)] flex-1">
                {t('appCreate.field.purpose.example')}
              </p>
              <span
                className={`shrink-0 tabular-nums ${
                  purposeOverLimit ? 'text-red-400' : 'text-[var(--text-dim)]'
                }`}
                data-testid="app-create-purpose-counter"
              >
                {purpose.length} / {PURPOSE_MAX}
              </span>
            </div>
          </div>

          {/* Optional accordion */}
          <div className="space-y-2">
            <button
              type="button"
              data-testid="app-create-optional-toggle"
              aria-expanded={showOptional}
              onClick={() => setShowOptional((v) => !v)}
              className="
                flex items-center gap-1.5 text-[var(--text-secondary)]
                hover:text-[var(--text-primary)] transition-colors
              "
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${showOptional ? 'rotate-90' : ''}`}
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="font-medium">{t('appCreate.section.optional')}</span>
            </button>

            {showOptional && (
              <div
                data-testid="app-create-optional-section"
                className="space-y-3 pt-1"
              >
                {/* Input */}
                <div className="space-y-1">
                  <label
                    htmlFor="app-create-input"
                    className="block text-[var(--text-secondary)] text-xs"
                  >
                    {t('appCreate.field.input')}
                  </label>
                  <textarea
                    id="app-create-input"
                    data-testid="app-create-input"
                    rows={2}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={isSubmitting}
                    className="
                      w-full rounded border border-[var(--border)]
                      bg-[var(--bg-elevated)] text-[var(--text-primary)]
                      px-3 py-1.5 text-sm resize-y
                      focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
                      disabled:opacity-50 disabled:cursor-not-allowed
                    "
                  />
                  <span
                    className={`block text-[10px] tabular-nums text-right ${
                      inputOverLimit ? 'text-red-400' : 'text-[var(--text-dim)]'
                    }`}
                  >
                    {input.length} / {OPTIONAL_TEXTAREA_MAX}
                  </span>
                </div>

                {/* Output */}
                <div className="space-y-1">
                  <label
                    htmlFor="app-create-output"
                    className="block text-[var(--text-secondary)] text-xs"
                  >
                    {t('appCreate.field.output')}
                  </label>
                  <textarea
                    id="app-create-output"
                    data-testid="app-create-output"
                    rows={2}
                    value={output}
                    onChange={(e) => setOutput(e.target.value)}
                    disabled={isSubmitting}
                    className="
                      w-full rounded border border-[var(--border)]
                      bg-[var(--bg-elevated)] text-[var(--text-primary)]
                      px-3 py-1.5 text-sm resize-y
                      focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
                      disabled:opacity-50 disabled:cursor-not-allowed
                    "
                  />
                  <span
                    className={`block text-[10px] tabular-nums text-right ${
                      outputOverLimit ? 'text-red-400' : 'text-[var(--text-dim)]'
                    }`}
                  >
                    {output.length} / {OPTIONAL_TEXTAREA_MAX}
                  </span>
                </div>

                {/* Frequency */}
                <div className="space-y-1">
                  <label
                    htmlFor="app-create-frequency"
                    className="block text-[var(--text-secondary)] text-xs"
                  >
                    {t('appCreate.field.frequency')}
                  </label>
                  <input
                    id="app-create-frequency"
                    data-testid="app-create-frequency"
                    type="text"
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                    disabled={isSubmitting}
                    className="
                      w-full rounded border border-[var(--border)]
                      bg-[var(--bg-elevated)] text-[var(--text-primary)]
                      px-3 py-1.5 text-sm
                      focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)]/40
                      disabled:opacity-50 disabled:cursor-not-allowed
                    "
                  />
                  <span
                    className={`block text-[10px] tabular-nums text-right ${
                      frequencyOverLimit ? 'text-red-400' : 'text-[var(--text-dim)]'
                    }`}
                  >
                    {frequency.length} / {FREQUENCY_MAX}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Inline error (session creation failure) */}
          {error && (
            <div
              data-testid="app-create-error"
              className="
                rounded border border-red-500/40 bg-red-500/10
                px-3 py-2 text-sm text-red-400
              "
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button
            type="button"
            data-testid="app-create-cancel"
            onClick={onCancel}
            disabled={isSubmitting}
            className="
              px-3 py-1.5 text-sm rounded
              text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            {t('appCreate.button.cancel')}
          </button>
          <button
            type="button"
            data-testid="app-create-submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="
              px-3 py-1.5 text-sm rounded font-medium
              bg-[var(--accent-bg)] text-[var(--accent-text)]
              hover:opacity-90 transition-opacity
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            {t('appCreate.button.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
