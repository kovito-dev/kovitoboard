/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Warning dialog shown before installing a recipe whose artifacts
 * contain patterns that escape the declarative handler model
 * (e.g. Express Router, direct fetch/axios, child_process, etc).
 *
 * Spec: docs/specs/v0.1.0-recipe-install-handover.md F6 / §3.6.
 *
 * The detection happens server-side in `recipe-inspector.analyzePureDeclarative`
 * (DEC-006 v2.0 § 6); this dialog only renders the result. When the
 * user clicks "Continue", control passes to the agent-picker modal.
 * "Cancel" aborts the install.
 */
import { useEffect } from 'react'
import { t } from '../i18n'
import type { MessageKey } from '../i18n'

interface RecipeInstallWarningDialogProps {
  recipeName: string
  /** Pattern names from `inspection.detectedNonDeclarativePatterns`. */
  detectedPatterns: string[]
  onContinue: () => void
  onCancel: () => void
}

export function RecipeInstallWarningDialog({
  recipeName,
  detectedPatterns,
  onContinue,
  onCancel,
}: RecipeInstallWarningDialogProps) {
  // Esc closes the dialog (cancel-equivalent), matching other modal
  // surfaces in the renderer (RecipeInstallModal / AppCreateModal).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="recipe-install-warning-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-install-warning-title"
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
            id="recipe-install-warning-title"
            className="text-base font-semibold text-amber-400"
          >
            ⚠️ {t('recipe.install.warning.title')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            data-testid="recipe-install-warning-close"
            aria-label={t('recipe.install.warning.cancel')}
            className="text-[var(--text-dim)] hover:text-[var(--text-secondary)] text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 text-sm">
          <p className="text-[var(--text-primary)]">
            {t('recipe.install.warning.body', { name: recipeName })}
          </p>
          <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-0.5 pl-2">
            {detectedPatterns.map((pattern) => (
              <li key={pattern} data-testid={`recipe-install-warning-pattern-${pattern}`}>
                {/* `t()` falls back to the raw key when the catalog
                 *  has no entry — that surfaces e.g.
                 *  `recipe.install.warning.pattern.<unknown>` for
                 *  patterns added in a future build the catalog has
                 *  not been updated for, which is good enough for
                 *  diagnostic UX. */}
                {t(`recipe.install.warning.pattern.${pattern}` as MessageKey)}
              </li>
            ))}
          </ul>
          <p className="text-[var(--text-secondary)]">
            {t('recipe.install.warning.note')}
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button
            type="button"
            data-testid="recipe-install-warning-cancel"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"
          >
            {t('recipe.install.warning.cancel')}
          </button>
          <button
            type="button"
            data-testid="recipe-install-warning-continue"
            onClick={onContinue}
            className="px-3 py-1.5 text-sm bg-amber-500/80 text-white rounded-lg hover:bg-amber-500 transition-colors font-medium"
          >
            {t('recipe.install.warning.continue')}
          </button>
        </div>
      </div>
    </div>
  )
}
