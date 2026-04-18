import { useState, useRef, useCallback } from 'react'

/** Attached file information */
interface AttachedFile {
  /** File path on the server */
  filePath: string
  /** File name for display */
  fileName: string
  /** File size in bytes */
  size: number
  /** Content-Type */
  contentType: string
  /** Object URL for thumbnail preview (for images) */
  previewUrl?: string
}

interface MessageInputProps {
  /** Send handler. Returns a Promise to signal completion/error */
  onSend: (message: string) => Promise<void>
  /** Whether to disable input */
  disabled?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Whether sending is in progress */
  isSending?: boolean
  /** Callback on send failure (for rolling back optimistic messages, etc.) */
  onSendError?: (error: Error) => void
}

/** Format file size for display */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Check if the content type is an image */
function isImageType(contentType: string): boolean {
  return contentType.startsWith('image/')
}

export function MessageInput({ onSend, disabled, placeholder, isSending, onSendError }: MessageInputProps) {
  const [text, setText] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Upload file to the server */
  const uploadFile = useCallback(async (file: File | Blob, originalName?: string): Promise<AttachedFile | null> => {
    setIsUploading(true)
    setUploadError(null)
    try {
      const buffer = await file.arrayBuffer()
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...(originalName ? { 'X-Original-Filename': originalName } : {}),
        },
        body: buffer,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        setUploadError(err.error || `Upload failed (${res.status})`)
        return null
      }

      const data = await res.json()

      // Create preview URL for images
      let previewUrl: string | undefined
      if (isImageType(file.type)) {
        previewUrl = URL.createObjectURL(file instanceof File ? file : new Blob([buffer], { type: file.type }))
      }

      return {
        filePath: data.filePath,
        fileName: originalName || data.fileName,
        size: data.size,
        contentType: data.contentType,
        previewUrl,
      }
    } catch {
      setUploadError('Upload failed')
      return null
    } finally {
      setIsUploading(false)
    }
  }, [])

  /** Handle uploading multiple files */
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    for (const file of fileArray) {
      const attached = await uploadFile(file, file.name)
      if (attached) {
        setAttachedFiles((prev) => [...prev, attached])
      }
    }
  }, [uploadFile])

  /** Remove an attached file */
  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const file = prev[index]
      // Clean up preview URL
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl)
      }
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  /** Send handler */
  const handleSend = useCallback(async () => {
    const trimmedText = text.trim()
    if ((!trimmedText && attachedFiles.length === 0) || disabled || isSending) return

    // Append attached file paths to the message
    let fullMessage = trimmedText
    if (attachedFiles.length > 0) {
      const fileLines = attachedFiles.map((f) => f.filePath).join('\n')
      fullMessage = trimmedText
        ? `${trimmedText}\n\n添付ファイル:\n${fileLines}`
        : `添付ファイル:\n${fileLines}`
    }

    setSendError(null)
    try {
      await onSend(fullMessage)
      setText('')
      // Clean up preview URLs
      for (const f of attachedFiles) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      }
      setAttachedFiles([])
      setUploadError(null)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } catch (err) {
      // Send failed: show error, keep input content (so user can retry)
      const errorMsg = err instanceof Error ? err.message : 'Failed to send'
      console.error('[MessageInput] Send error:', errorMsg)
      setSendError(errorMsg)
      // Notify the caller of the error (for rolling back optimistic messages)
      if (onSendError) {
        onSendError(err instanceof Error ? err : new Error(errorMsg))
      }
    }
  }, [text, attachedFiles, disabled, isSending, onSend, onSendError])

  /** Keyboard handling */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  /** Clipboard paste */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Detect files (images, etc.) from the clipboard
    const fileItems: DataTransferItem[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        fileItems.push(items[i])
      }
    }

    if (fileItems.length === 0) return // Let text paste use default behavior

    e.preventDefault() // Prevent text paste when files are present

    for (const item of fileItems) {
      const file = item.getAsFile()
      if (file) {
        // Generate a file name for screenshots (which often lack one)
        const name = file.name && file.name !== 'image.png'
          ? file.name
          : `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
        const attached = await uploadFile(file, name)
        if (attached) {
          setAttachedFiles((prev) => [...prev, attached])
        }
      }
    }
  }, [uploadFile])

  /** Drag & drop */
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      await handleFiles(files)
    }
  }, [handleFiles])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  /** Auto-adjust textarea height */
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const isDisabled = disabled || isSending
  const canSend = (text.trim().length > 0 || attachedFiles.length > 0) && !isDisabled && !isUploading

  return (
    <div
      className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-surface)] px-2 md:px-4 py-2 md:py-3"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Attached file preview */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 max-w-4xl mx-auto mb-2">
          {attachedFiles.map((file, index) => (
            <div
              key={`${file.filePath}-${index}`}
              className="relative group flex items-center gap-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg px-2.5 py-1.5"
            >
              {/* Thumbnail or icon */}
              {file.previewUrl ? (
                <img
                  src={file.previewUrl}
                  alt={file.fileName}
                  className="w-8 h-8 object-cover rounded"
                />
              ) : (
                <div className="w-8 h-8 flex items-center justify-center bg-[var(--bg-hover)] rounded text-[var(--text-dim)]">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
              )}

              {/* File info */}
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--text-tertiary)] truncate max-w-[150px]">{file.fileName}</div>
                <div className="text-[10px] text-[var(--text-faint)]">{formatFileSize(file.size)}</div>
              </div>

              {/* Remove button */}
              <button
                onClick={() => removeAttachedFile(index)}
                className="shrink-0 ml-1 text-[var(--text-faint)] hover:text-red-400 transition-colors"
                title="Remove attachment"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload error display */}
      {uploadError && (
        <div className="max-w-4xl mx-auto mb-2">
          <div className="text-[11px] text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-1.5">
            {uploadError}
          </div>
        </div>
      )}

      {/* Send error display */}
      {sendError && (
        <div className="max-w-4xl mx-auto mb-2">
          <div className="flex items-center justify-between text-[11px] text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-1.5">
            <span>送信失敗: {sendError}</span>
            <button
              onClick={() => setSendError(null)}
              className="ml-2 text-red-500 hover:text-red-300 transition-colors"
              title="Dismiss error"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 md:gap-3 max-w-4xl mx-auto">
        {/* File attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled || isUploading}
          className={`
            shrink-0 w-10 h-10 rounded-xl flex items-center justify-center
            transition-colors
            ${isDisabled || isUploading
              ? 'bg-[var(--bg-elevated)] text-[var(--text-faint)] cursor-not-allowed'
              : 'bg-[var(--bg-elevated)] text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] hover:bg-[var(--bg-hover)]'
            }
          `}
          title="Attach file"
        >
          {isUploading ? (
            <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          )}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleFiles(e.target.files)
              e.target.value = '' // Reset to allow re-selecting the same file
            }
          }}
        />

        {/* Text input */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isDisabled}
            placeholder={placeholder || 'メッセージを入力... (Ctrl+Enter で送信, 画像ペースト可)'}
            rows={1}
            className={`
              w-full resize-none rounded-xl px-4 py-3 pr-12
              bg-[var(--bg-elevated)] border border-[var(--border)]
              text-sm text-[var(--text-secondary)] placeholder-gray-600
              focus:outline-none focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent-ring)]
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors
            `}
            style={{ maxHeight: '200px' }}
          />
        </div>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`
            shrink-0 w-10 h-10 rounded-xl flex items-center justify-center
            transition-all duration-200
            ${canSend
              ? 'bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent-shadow)]'
              : 'bg-[var(--bg-elevated)] text-[var(--text-faint)] cursor-not-allowed'
            }
          `}
          title="Send (Ctrl+Enter)"
        >
          {isSending ? (
            <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>

      {/* Hints */}
      <div className="flex items-center justify-between max-w-4xl mx-auto mt-1 md:mt-1.5 px-1">
        <span className="text-[10px] text-[var(--text-faint)] hidden sm:inline">
          Ctrl+Enter で送信 · 📎 ファイル添付 · Ctrl+V で画像ペースト
        </span>
        <span className="text-[10px] text-[var(--text-faint)] sm:hidden">
          Ctrl+Enter で送信
        </span>
        {isSending && (
          <span className="text-[10px] text-[var(--accent-text-vivid)] animate-pulse">
            Claude が応答中...
          </span>
        )}
      </div>
    </div>
  )
}
