/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect, useState } from 'react'
import { t } from '../i18n'

/**
 * Slash-command warning modal (Q12 / SS-6).
 *
 * Shown the first time a user is about to send a Claude Code TUI
 * command (lines like `/context`, `/help`, `/model`, `/exit`) through
 * KB. These commands are intercepted by the Claude Code TUI before
 * they reach the model, so they never appear in the JSONL transcript
 * KB renders — meaning the user sees no response in the KB UI even
 * though the command did execute inside the tmux pane.
 *
 * The modal does NOT block the message — the user can still send and
 * inspect the response by attaching to tmux directly. A persistent
 * "Don't show this again" checkbox writes a flag to localStorage so
 * the dialog only fires once unless the user clears the storage.
 *
 * Implements spec Q12 §6.10 "Plan A" (warn-and-allow) verbatim.
 */
export interface SlashCommandWarningModalProps {
  /** Pending message awaiting confirmation. The dialog is hidden when null. */
  message: string | null
  /** Called when the user confirms (and optionally suppresses future warnings). */
  onConfirm: (suppressFuture: boolean) => void
  /** Called when the user cancels (Esc / overlay click / cancel button). */
  onCancel: () => void
}

export function SlashCommandWarningModal({
  message,
  onConfirm,
  onCancel,
}: SlashCommandWarningModalProps) {
  const [suppress, setSuppress] = useState(false)

  // Reset the checkbox each time a new message is queued so the
  // user's previous tick does not silently apply to the next dialog.
  useEffect(() => {
    setSuppress(false)
  }, [message])

  // Esc to cancel.
  useEffect(() => {
    if (message === null) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [message, onCancel])

  if (message === null) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="slash-command-warning-modal"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal body */}
      <div
        className="relative w-full max-w-lg mx-0 md:mx-4 bg-[var(--bg-base)] md:rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slash-command-warning-title"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-[var(--border)]">
          <span className="text-2xl leading-none" aria-hidden>
            ⚠️
          </span>
          <h2
            id="slash-command-warning-title"
            className="text-lg font-semibold text-[var(--text-secondary)]"
          >
            {t('slashCommandWarning.title')}
          </h2>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-3">
          <p className="text-sm text-[var(--text-tertiary)] leading-relaxed">
            {t('slashCommandWarning.body')}
          </p>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
            <code
              className="text-xs font-mono text-[var(--text-tertiary)] break-all"
              data-testid="slash-command-warning-message"
            >
              {message}
            </code>
          </div>
          <p className="text-xs text-[var(--text-dim)] leading-relaxed">
            {t('slashCommandWarning.hint')}
          </p>

          {/* Suppression checkbox */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-dim)] hover:text-[var(--text-tertiary)] transition-colors select-none">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
              className="h-4 w-4 rounded border-[var(--border)] bg-[var(--bg-surface)] accent-[var(--accent-bg)]"
              data-testid="slash-command-warning-suppress"
            />
            <span>{t('slashCommandWarning.suppress')}</span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-surface)] flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-transparent text-[var(--text-tertiary)] border border-[var(--border)] hover:bg-white/5 transition-colors"
            data-testid="slash-command-warning-cancel"
          >
            {t('slashCommandWarning.cancel')}
          </button>
          <button
            onClick={() => onConfirm(suppress)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 transition-opacity"
            data-testid="slash-command-warning-confirm"
          >
            {t('slashCommandWarning.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
