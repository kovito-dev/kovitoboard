import { useState, useRef, useCallback } from 'react'

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

    // クライアント側バリデーション
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('対応形式: PNG, JPG, WEBP, SVG')
      return
    }
    if (file.size > MAX_SIZE) {
      setError('ファイルサイズは 2MB 以下にしてください')
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
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setIsUploading(false)
      // input をリセット（同じファイルを再度選択可能にする）
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
      setError(err instanceof Error ? err.message : '削除に失敗しました')
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
          {isUploading ? 'アップロード中...' : '画像を変更'}
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
          title="カスタム画像を削除"
        >
          削除
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      <p className="text-[10px] text-[var(--text-faint)]">
        PNG, JPG, WEBP, SVG（2MB以下）
      </p>
    </div>
  )
}
