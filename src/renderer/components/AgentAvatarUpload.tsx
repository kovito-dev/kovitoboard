/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useRef, useCallback } from 'react'
import { t } from '../i18n'

interface AgentAvatarUploadProps {
  agentId: string
  onUploadComplete: () => void
}

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']

export function AgentAvatarUpload({ agentId, onUploadComplete }: AgentAvatarUploadProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)

    // Client-side validation
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(t('agent.avatar.error.format'))
      return
    }
    if (file.size > MAX_SIZE) {
      setError(t('agent.avatar.error.size'))
      return
    }

    setIsUploading(true)
    try {
      const buffer = await file.arrayBuffer()
      const res = await fetch(`/api/agents/${agentId}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: buffer,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `Upload failed (${res.status})`)
      }

      onUploadComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agent.avatar.error.uploadFailed'))
    } finally {
      setIsUploading(false)
      // Reset input (allow re-selecting the same file)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [agentId, onUploadComplete])

  const handleDeleteAvatar = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/avatar`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `Delete failed (${res.status})`)
      }
      onUploadComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agent.avatar.error.deleteFailed'))
    }
  }, [agentId, onUploadComplete])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label
          className={`
            cursor-pointer px-3 py-1.5 text-xs font-medium rounded-md transition-colors
            ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}
            bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border)]
          `}
        >
          {isUploading ? t('agent.avatar.status.uploading') : t('agent.avatar.button.change')}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleFileSelect}
            disabled={isUploading}
            className="hidden"
          />
        </label>
        <button
          onClick={handleDeleteAvatar}
          className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors text-red-400 hover:text-red-300 hover:bg-red-500/10"
          title={t('agent.avatar.button.remove')}
        >
          {t('common.delete')}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      <p className="text-[10px] text-[var(--text-faint)]">
        {t('agent.avatar.hint')}
      </p>
    </div>
  )
}
