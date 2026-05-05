/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState } from 'react'
import { t } from '../../i18n'
import type { Locale } from '../../i18n'

interface StepConciergeProps {
  locale: Locale
  onNext: (added: boolean) => void
  onBack: () => void
}

export function StepConcierge({ locale, onNext, onBack }: StepConciergeProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async () => {
    setIsAdding(true)
    setError(null)

    try {
      // Step 1: Create concierge agent
      const createRes = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: 'kovito-concierge',
          agentId: 'kovito-concierge',
          locale,
        }),
      })
      if (!createRes.ok) {
        throw new Error(`Agent creation failed: ${createRes.status}`)
      }

      // Step 2: Setup agent-ref symlink
      const symlinkRes = await fetch('/api/config/setup-agent-ref', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!symlinkRes.ok) {
        throw new Error(`Agent ref setup failed: ${symlinkRes.status}`)
      }

      onNext(true)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      setIsAdding(false)
    }
  }

  return (
    <div data-testid="onboarding-step-concierge" className="flex flex-col items-center gap-6">
      <h2 className="text-xl font-bold text-[var(--text-primary)] text-center">
        {t('onboarding.concierge.title')}
      </h2>

      {/* Kobi preview */}
      <img
        src="/avatars/default/kovito-concierge.svg"
        alt="Kobi"
        className="w-20 h-20"
      />

      {/* Confirm message */}
      <p className="text-[var(--text-primary)] text-center">
        {t('onboarding.concierge.confirm')}
      </p>

      {/* Benefits box (OB-3 / Q1 in v0.1.0-batch-spec-questions.md):
          surfaces what Kobi actually does so the user can make an
          informed call instead of treating "Add" / "Add later" as
          interchangeable. Replaces the previous one-line role
          description, which was too abstract to motivate the choice. */}
      <div className="w-full p-4 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg">
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-2">
          {t('onboarding.concierge.benefits.title')}
        </h3>
        <ul className="space-y-1.5 text-sm text-[var(--text-primary)]">
          {(['1', '2', '3', '4', '5'] as const).map((n) => (
            <li key={n} className="flex items-start gap-2">
              <span className="text-[var(--onboarding-accent)] mt-0.5" aria-hidden="true">✓</span>
              <span>{t(`onboarding.concierge.benefit.${n}`)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Error message */}
      {error && (
        <p className="text-sm text-red-500 text-center">{error}</p>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2 w-full">
        <button
          type="button"
          onClick={handleAdd}
          disabled={isAdding}
          className="w-full px-4 py-3 bg-[var(--onboarding-accent)] text-white rounded-lg hover:bg-[var(--onboarding-accent-hover)] disabled:opacity-50 font-medium transition-colors"
        >
          {isAdding ? t('onboarding.concierge.adding') : t('onboarding.concierge.add')}
        </button>
        <button
          type="button"
          onClick={() => onNext(false)}
          disabled={isAdding}
          className="w-full px-4 py-2 text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          {t('onboarding.concierge.skip')}
        </button>
        {/* Soft warning under the skip button. Not a hard block —
            users can still skip, but they see the cost up-front. */}
        <p className="text-xs text-[var(--text-faint)] text-center px-2">
          {t('onboarding.concierge.skipNote')}
        </p>
      </div>

      {/* Back button */}
      <div className="w-full pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isAdding}
          className="px-4 py-2 text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          {t('onboarding.back')}
        </button>
      </div>
    </div>
  )
}
