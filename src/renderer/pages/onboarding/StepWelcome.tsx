import { t, setLocale } from '../../i18n'
import type { Locale } from '../../i18n'

interface StepWelcomeProps {
  locale: Locale
  onLocaleChange: (locale: Locale) => void
  onNext: () => void
}

export function StepWelcome({ locale, onLocaleChange, onNext }: StepWelcomeProps) {
  const handleLocaleChange = (newLocale: Locale) => {
    setLocale(newLocale)
    onLocaleChange(newLocale)
  }

  return (
    <div data-testid="onboarding-step-welcome" className="flex flex-col items-center gap-8">
      {/* Kobi avatar */}
      <img
        src="/avatars/default/kovito-concierge.svg"
        alt="Kobi"
        className="w-24 h-24"
      />

      {/* Title */}
      <div className="text-center">
        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
          {t('onboarding.welcome.title')}
        </h1>
        <p className="text-[var(--text-dim)]">
          {t('onboarding.welcome.subtitle')}
        </p>
      </div>

      {/* Language selector */}
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-[var(--text-dim)]">
          {t('onboarding.welcome.language')}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handleLocaleChange('ja')}
            className={`px-6 py-2 rounded-lg border transition-colors ${
              locale === 'ja'
                ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            日本語
          </button>
          <button
            type="button"
            onClick={() => handleLocaleChange('en')}
            className={`px-6 py-2 rounded-lg border transition-colors ${
              locale === 'en'
                ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            English
          </button>
        </div>
      </div>

      {/* Start button */}
      <button
        type="button"
        onClick={onNext}
        className="px-8 py-3 bg-[var(--accent)] text-white rounded-lg hover:opacity-90 text-lg font-medium"
      >
        {t('onboarding.welcome.start')}
      </button>
    </div>
  )
}
