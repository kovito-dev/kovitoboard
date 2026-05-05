/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useRef, useCallback } from 'react'
import { t } from '../i18n'

interface UserAvatarUploadProps {
  /**
   * Fires after a successful upload or delete so the parent can
   * re-fetch `/api/settings/basic` (and ideally `/api/config`) to
   * surface the new avatar across every chat bubble.
   */
  onChanged: () => void
}

/** Architect §6.9 caps the user avatar at 1MB (agents allow 2MB). */
const MAX_SIZE = 1 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']

/**
 * Q11 / SM-4 user avatar upload widget. Mirrors the agent variant
 * (AgentAvatarUpload) but talks to /api/settings/user/avatar and
 * uses the smaller 1MB cap that the spec calls out for the
 * operator's own image. We intentionally do not preview anything
 * here — the parent (SettingsBasic) renders the live <AgentAvatar>
 * preview using the value loaded from /api/settings/basic, so this
 * component stays focused on the input + delete affordances.
 */
export function UserAvatarUpload({ onChanged }: UserAvatarUploadProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      setError(null)

      if (!ALLOWED_TYPES.includes(file.type)) {
        setError(t('user.avatar.error.format'))
        return
      }
      if (file.size > MAX_SIZE) {
        setError(t('user.avatar.error.size'))
        return
      }

      setIsUploading(true)
      try {
        const buffer = await file.arrayBuffer()
        const res = await fetch('/api/settings/user/avatar', {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: buffer,
        })

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error || `Upload failed (${res.status})`)
        }

        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : t('user.avatar.error.uploadFailed'))
      } finally {
        setIsUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [onChanged],
  )

  const handleDelete = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/settings/user/avatar', { method: 'DELETE' })
      // 404 means "no upload yet" — already in the desired state, so
      // surface success for the user. The PUT/DELETE pair returns
      // 200 only when something was on disk.
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || `Delete failed (${res.status})`)
      }
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('user.avatar.error.deleteFailed'))
    }
  }, [onChanged])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label
          className={`
            cursor-pointer px-3 py-1.5 text-xs font-medium rounded-md transition-colors
            ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}
            bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border)]
          `}
          data-testid="user-avatar-upload-label"
        >
          {isUploading
            ? t('user.avatar.status.uploading')
            : t('user.avatar.button.change')}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleFileSelect}
            disabled={isUploading}
            className="hidden"
            data-testid="user-avatar-upload-input"
          />
        </label>
        <button
          type="button"
          onClick={handleDelete}
          className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors text-red-400 hover:text-red-300 hover:bg-red-500/10"
          title={t('user.avatar.button.remove')}
          data-testid="user-avatar-delete"
        >
          {t('common.delete')}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-[10px] text-[var(--text-faint)]">{t('user.avatar.hint')}</p>
    </div>
  )
}
