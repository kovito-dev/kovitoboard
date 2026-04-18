import { t } from '../../i18n'

interface StepCompleteProps {
  conciergeAdded: boolean
  onComplete: () => void
}

export function StepComplete({ conciergeAdded, onComplete }: StepCompleteProps) {
  return (
    <div data-testid="onboarding-step-complete" className="flex flex-col items-center gap-8">
      {/* Success icon */}
      <div className="w-20 h-20 rounded-full bg-[var(--accent)] flex items-center justify-center">
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

      {/* Action button */}
      <button
        type="button"
        onClick={onComplete}
        className="px-8 py-3 bg-[var(--accent)] text-white rounded-lg hover:opacity-90 text-lg font-medium"
      >
        {conciergeAdded
          ? t('onboarding.complete.talkToKobi')
          : t('onboarding.complete.goToDashboard')}
      </button>
    </div>
  )
}
