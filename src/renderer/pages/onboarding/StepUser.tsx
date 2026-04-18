import { useState, useRef } from 'react'
import { t } from '../../i18n'

interface StepUserProps {
  displayName: string
  onDisplayNameChange: (name: string) => void
  userAvatar: File | null
  onUserAvatarChange: (file: File | null) => void
  onNext: () => void
  onBack: () => void
}

const MAX_DISPLAY_NAME_LENGTH = 30
const MAX_AVATAR_SIZE = 2 * 1024 * 1024 // 2MB

export function StepUser({
  displayName,
  onDisplayNameChange,
  userAvatar,
  onUserAvatarChange,
  onNext,
  onBack,
}: StepUserProps) {
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isValid = displayName.trim().length > 0 && displayName.length <= MAX_DISPLAY_NAME_LENGTH

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setAvatarError(null)

    if (file) {
      if (file.size > MAX_AVATAR_SIZE) {
        setAvatarError(t('onboarding.user.avatarSizeError'))
        // Reset input
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
      onUserAvatarChange(file)
      const reader = new FileReader()
      reader.onload = (ev) => {
        setAvatarPreview(ev.target?.result as string)
      }
      reader.readAsDataURL(file)
    } else {
      onUserAvatarChange(null)
      setAvatarPreview(null)
    }
  }

  const getValidationMessage = (): string | null => {
    if (displayName.length === 0) return null // Don't show error when empty
    if (displayName.trim().length === 0) return t('onboarding.user.displayNameRequired')
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) return t('onboarding.user.displayNameMaxLength')
    return null
  }

  const validationMessage = getValidationMessage()

  return (
    <div data-testid="onboarding-step-user" className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-[var(--text-primary)] text-center">
        {t('onboarding.user.title')}
      </h2>

      {/* Display name */}
      <div className="flex flex-col gap-2">
        <label htmlFor="displayName" className="text-sm font-medium text-[var(--text-primary)]">
          {t('onboarding.user.displayName')}
        </label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder={t('onboarding.user.displayNamePlaceholder')}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        {validationMessage && (
          <p className="text-sm text-red-500">{validationMessage}</p>
        )}
      </div>

      {/* Avatar upload */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">
          {t('onboarding.user.avatar')}
        </label>
        <p className="text-xs text-[var(--text-dim)]">
          {t('onboarding.user.avatarHint')}
        </p>
        <div className="flex items-center gap-4">
          {/* Avatar preview */}
          <div className="w-16 h-16 rounded-full bg-[var(--bg-hover)] flex items-center justify-center overflow-hidden border border-[var(--border)]">
            {avatarPreview ? (
              <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" />
            ) : (
              <svg className="w-8 h-8 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            className="text-sm text-[var(--text-primary)] file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--bg-surface)] file:text-[var(--text-primary)] file:cursor-pointer hover:file:bg-[var(--bg-hover)]"
          />
        </div>
        {avatarError && (
          <p className="text-sm text-red-500">{avatarError}</p>
        )}
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
