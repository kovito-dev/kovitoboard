/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { t } from '../../i18n'

interface StepCompleteProps {
  conciergeAdded: boolean
  isCompleting: boolean
  onComplete: () => void
  /**
   * When true, the wizard records `claudeMdGuidance.disabled = true`
   * in `setting.json` and the server skips the CLAUDE.md guidance
   * injection on onboarding completion. Spec
   * `claude-md-guidance-injection.md` v1.2 §7.2.
   */
  skipClaudeMdGuidance: boolean
  /** Toggle handler for the opt-out checkbox. */
  onSkipClaudeMdGuidanceChange: (next: boolean) => void
}

export function StepComplete({
  conciergeAdded,
  isCompleting,
  onComplete,
  skipClaudeMdGuidance,
  onSkipClaudeMdGuidanceChange,
}: StepCompleteProps) {
  const label = isCompleting
    ? t('onboarding.complete.preparing')
    : conciergeAdded
      ? t('onboarding.complete.talkToKobi')
      : t('onboarding.complete.goToAgents')

  return (
    <div data-testid="onboarding-step-complete" className="flex flex-col items-center gap-8">
      {/* Success icon */}
      <div className="w-20 h-20 rounded-full bg-[var(--onboarding-accent)] flex items-center justify-center">
        <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      {/* Title */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
          {t('onboarding.complete.title')}
        </h2>
        <p className="text-[var(--text-dim)]">
          {t('onboarding.complete.description')}
        </p>
      </div>

      {/* CLAUDE.md guidance opt-out (spec
          claude-md-guidance-injection.md v1.2 §7.2). Default OFF: KB
          injects a minimal `KovitoBoard (KB)` block into
          `<projectRoot>/CLAUDE.md` so every Claude Code agent picks
          up the agent-ref entry point. Users who manage CLAUDE.md
          themselves can opt out here, and the choice is recorded in
          `setting.json` as `claudeMdGuidance.disabled = true`. */}
      <label
        data-testid="onboarding-skip-claude-md-guidance"
        className="flex items-start gap-3 text-sm text-[var(--text-dim)] cursor-pointer select-none"
      >
        <input
          type="checkbox"
          className="mt-1"
          checked={skipClaudeMdGuidance}
          onChange={(e) => onSkipClaudeMdGuidanceChange(e.target.checked)}
          disabled={isCompleting}
        />
        <span className="text-left">
          {t('onboarding.complete.skipClaudeMdGuidance')}
          <br />
          <span className="text-xs opacity-80">
            {t('onboarding.complete.skipClaudeMdGuidanceHint')}
          </span>
        </span>
      </label>

      {/* Action button */}
      <button
        type="button"
        onClick={onComplete}
        disabled={isCompleting}
        aria-busy={isCompleting}
        className="px-8 py-3 bg-[var(--onboarding-accent)] text-white rounded-lg hover:bg-[var(--onboarding-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed text-lg font-medium inline-flex items-center gap-2 transition-colors"
      >
        {isCompleting && (
          <svg
            className="w-5 h-5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        )}
        {label}
      </button>
    </div>
  )
}
