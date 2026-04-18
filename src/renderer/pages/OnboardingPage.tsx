import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { t, setLocale } from '../i18n'
import type { Locale } from '../i18n'
import type { KovitoboardSetting } from '../../shared/setting-types'
import { StepWelcome } from './onboarding/StepWelcome'
import { StepUser } from './onboarding/StepUser'
import { StepProject } from './onboarding/StepProject'
import { StepConcierge } from './onboarding/StepConcierge'
import { StepComplete } from './onboarding/StepComplete'

const TOTAL_STEPS = 5

export function OnboardingPage() {
  const navigate = useNavigate()

  // Wizard state
  const [step, setStep] = useState(1)
  const [locale, setLocaleState] = useState<Locale>(
    navigator.language.startsWith('ja') ? 'ja' : 'en'
  )
  const [displayName, setDisplayName] = useState('')
  const [userAvatar, setUserAvatar] = useState<File | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [conciergeAdded, setConciergeAdded] = useState(false)
  const [projectRoot, setProjectRoot] = useState('')

  // Initialize locale on mount and fetch projectRoot
  useEffect(() => {
    setLocale(locale)
    fetch('/api/config/project-root')
      .then(r => r.json())
      .then(d => setProjectRoot(d.projectRoot || ''))
      .catch(() => setProjectRoot(''))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLocaleChange = useCallback((newLocale: Locale) => {
    setLocale(newLocale)
    setLocaleState(newLocale)
  }, [])

  const handleConciergeNext = useCallback((added: boolean) => {
    setConciergeAdded(added)
    setStep(5)
  }, [])

  const handleComplete = useCallback(async () => {
    // Save setting via API
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName, avatar: null },
      project: { name: projectName, description: projectDescription, path: projectRoot },
      locale,
      onboarding: { completedAt: new Date().toISOString(), wizardVersion: '0.1.0' },
    }

    try {
      await fetch('/api/config/setting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setting),
      })

      // Start a session with Kobi if concierge was added
      if (conciergeAdded) {
        await fetch('/api/sessions/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'kovito-concierge',
            initialPrompt: 'onboarding:first-time',
          }),
        })
      }
    } catch {
      // Best-effort; navigate to dashboard regardless
    }

    navigate('/')
  }, [displayName, projectName, projectDescription, projectRoot, locale, conciergeAdded, navigate])

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <StepWelcome
            locale={locale}
            onLocaleChange={handleLocaleChange}
            onNext={() => setStep(2)}
          />
        )
      case 2:
        return (
          <StepUser
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            userAvatar={userAvatar}
            onUserAvatarChange={setUserAvatar}
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
          />
        )
      case 3:
        return (
          <StepProject
            projectName={projectName}
            onProjectNameChange={setProjectName}
            projectDescription={projectDescription}
            onProjectDescriptionChange={setProjectDescription}
            projectRoot={projectRoot}
            onNext={() => setStep(4)}
            onBack={() => setStep(2)}
          />
        )
      case 4:
        return (
          <StepConcierge
            locale={locale}
            onNext={handleConciergeNext}
            onBack={() => setStep(3)}
          />
        )
      case 5:
        return (
          <StepComplete
            conciergeAdded={conciergeAdded}
            onComplete={handleComplete}
          />
        )
      default:
        return null
    }
  }

  return (
    <div
      data-testid="onboarding-wizard"
      className="h-screen bg-[var(--bg-base)] flex flex-col items-center justify-center p-4"
    >
      <div className="w-full max-w-lg">
        {/* Step progress */}
        <div className="text-center mb-8">
          <span className="text-sm text-[var(--text-dim)]">
            {t('onboarding.step', { current: step, total: TOTAL_STEPS })}
          </span>
          {/* Progress bar */}
          <div className="mt-2 h-1 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
              style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
            />
          </div>
        </div>

        {/* Step content */}
        <div className="bg-[var(--bg-surface)] rounded-2xl p-8 border border-[var(--border)]">
          {renderStep()}
        </div>
      </div>
    </div>
  )
}
