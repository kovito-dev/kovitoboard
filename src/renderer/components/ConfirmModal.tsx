/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Reusable confirmation modal.
 *
 * Follows the existing modal pattern (fixed overlay, ESC key dismiss).
 */
import { useEffect, type ReactNode } from 'react'
import { t } from '../i18n'

interface ConfirmModalProps {
  isOpen: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  /** Use 'danger' for destructive actions (red confirm button) */
  variant?: 'default' | 'danger'
  /** Disable confirm button (e.g., during loading) */
  loading?: boolean
}

export function ConfirmModal({
  isOpen,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  variant = 'default',
  loading = false,
}: ConfirmModalProps) {
  // ESC key handler
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const confirmBg =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-700 text-white'
      : 'bg-[var(--accent-bg)] hover:opacity-90 text-[var(--accent-text)]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        className="relative w-full max-w-md mx-4 bg-[var(--bg-base)] rounded-2xl border border-[var(--border)] shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-secondary)]">
            {title}
          </h2>
        </div>

        {/* Body */}
        <div className="px-6 py-4 text-sm text-[var(--text-muted)]">
          {body}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors disabled:opacity-50"
          >
            {cancelLabel ?? t('admin.restart.confirm.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${confirmBg}`}
          >
            {loading ? '...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
