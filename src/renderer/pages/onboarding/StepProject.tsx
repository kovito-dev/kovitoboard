import { t } from '../../i18n'

interface StepProjectProps {
  projectName: string
  onProjectNameChange: (name: string) => void
  projectDescription: string
  onProjectDescriptionChange: (desc: string) => void
  projectRoot: string
  onNext: () => void
  onBack: () => void
}

const MAX_NAME_LENGTH = 50
const MAX_DESCRIPTION_LENGTH = 500

export function StepProject({
  projectName,
  onProjectNameChange,
  projectDescription,
  onProjectDescriptionChange,
  projectRoot,
  onNext,
  onBack,
}: StepProjectProps) {
  const isValid = projectName.trim().length > 0 && projectName.length <= MAX_NAME_LENGTH

  const getNameValidation = (): string | null => {
    if (projectName.length === 0) return null
    if (projectName.trim().length === 0) return t('onboarding.project.nameRequired')
    if (projectName.length > MAX_NAME_LENGTH) return t('onboarding.project.nameMaxLength')
    return null
  }

  const getDescValidation = (): string | null => {
    if (projectDescription.length > MAX_DESCRIPTION_LENGTH) return t('onboarding.project.descriptionMaxLength')
    return null
  }

  const nameError = getNameValidation()
  const descError = getDescValidation()

  return (
    <div data-testid="onboarding-step-project" className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-[var(--text-primary)] text-center">
        {t('onboarding.project.title')}
      </h2>

      {/* Project name */}
      <div className="flex flex-col gap-2">
        <label htmlFor="projectName" className="text-sm font-medium text-[var(--text-primary)]">
          {t('onboarding.project.name')}
        </label>
        <input
          id="projectName"
          type="text"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
          placeholder={t('onboarding.project.namePlaceholder')}
          maxLength={MAX_NAME_LENGTH}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        {nameError && (
          <p className="text-sm text-red-500">{nameError}</p>
        )}
      </div>

      {/* Project description */}
      <div className="flex flex-col gap-2">
        <label htmlFor="projectDescription" className="text-sm font-medium text-[var(--text-primary)]">
          {t('onboarding.project.description')}
        </label>
        <textarea
          id="projectDescription"
          value={projectDescription}
          onChange={(e) => onProjectDescriptionChange(e.target.value)}
          placeholder={t('onboarding.project.descriptionPlaceholder')}
          maxLength={MAX_DESCRIPTION_LENGTH}
          rows={4}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none"
        />
        <div className="flex justify-between">
          {descError ? (
            <p className="text-sm text-red-500">{descError}</p>
          ) : (
            <span />
          )}
          <span className="text-xs text-[var(--text-dim)]">
            {projectDescription.length} / {MAX_DESCRIPTION_LENGTH}
          </span>
        </div>
      </div>

      {/* Project root path (display only, DEC-009) */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">
          {t('onboarding.project.path')}
        </label>
        <div
          data-testid="onboarding-project-path"
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-dim)] text-[var(--text-dim)] font-mono text-sm select-all"
        >
          {projectRoot || '—'}
        </div>
        <p className="text-xs text-[var(--text-dim)]">
          {t('onboarding.project.pathNote')}
        </p>
      </div>

      {/* Navigation buttons */}
      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors"
        >
          {t('onboarding.back')}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!isValid}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:opacity-90 disabled:opacity-50"
        >
          {t('onboarding.next')}
        </button>
      </div>
    </div>
  )
}
