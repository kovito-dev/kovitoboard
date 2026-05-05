/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { t } from '../i18n'
import { MarkdownPreview } from './MarkdownPreview'

interface FilePreviewProps {
  /** File path to preview */
  filePath: string
  /** Callback to close the panel */
  onClose: () => void
}

/** Determine if the file has an image extension */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']

function isImageFile(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Get display label from file extension */
function getFileTypeLabel(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const labels: Record<string, string> = {
    md: 'Markdown',
    ts: 'TypeScript',
    tsx: 'TSX',
    js: 'JavaScript',
    jsx: 'JSX',
    py: 'Python',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    html: 'HTML',
    css: 'CSS',
    sh: 'Shell',
    png: 'PNG',
    jpg: 'JPEG',
    jpeg: 'JPEG',
    gif: 'GIF',
    svg: 'SVG',
    webp: 'WebP',
  }
  return labels[ext] || ext.toUpperCase()
}

/** Extract the file name from a path */
function getFileName(path: string): string {
  return path.split('/').pop() || path
}

const MIN_WIDTH = 300
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 420

export function FilePreview({ filePath, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string>('')
  const [language, setLanguage] = useState<string>('text')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

  // Resize handling via drag
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      // Dragging left = widening (inverted because this is a right panel)
      const delta = dragStartX.current - e.clientX
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidth.current + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    // Prevent text selection during drag
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartWidth.current = width
    setIsDragging(true)
  }, [width])

  const fetchContent = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/artifact?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) {
        setError(t('file.preview.error.read'))
        return
      }
      const data = await res.json()
      setContent(data.content)
      setLanguage(data.language)
    } catch {
      setError(t('file.preview.error.fetch'))
    } finally {
      setIsLoading(false)
    }
  }, [filePath])

  useEffect(() => {
    // Display images directly in the browser instead of fetching via API
    if (isImageFile(filePath)) {
      setIsLoading(false)
      return
    }
    fetchContent()
  }, [filePath, fetchContent])

  const isImage = isImageFile(filePath)

  return (
    <div
      className="shrink-0 flex flex-col border-l border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden relative"
      style={{ width: `${width}px` }}
    >
      {/* Drag handle (left edge) */}
      <div
        onMouseDown={handleDragStart}
        className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors ${
          isDragging ? 'bg-[var(--accent)]/60' : 'hover:bg-[var(--accent)]/40'
        }`}
      />
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-base)]">
        <div className="flex items-center gap-2 min-w-0">
          {/* File type badge */}
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] font-mono">
            {getFileTypeLabel(filePath)}
          </span>
          {/* File name */}
          <span className="text-xs text-[var(--text-tertiary)] truncate" title={filePath}>
            {getFileName(filePath)}
          </span>
        </div>
        {/* Q7 / AS-5: header actions. "Open in browser" hands off to
            the platform default for the file (or to the URL itself
            when the path was already absolute). The close button stays
            at the very right so the visual order matches every other
            modal in the app. */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => {
              const target = filePath.startsWith('http://') || filePath.startsWith('https://')
                ? filePath
                : filePath.startsWith('/')
                  ? `file://${filePath}`
                  : `/api/files/raw?path=${encodeURIComponent(filePath)}`
              window.open(target, '_blank', 'noopener,noreferrer')
            }}
            className="text-[10px] px-2 py-0.5 rounded text-[var(--text-dim)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)] transition-colors"
            title={t('filePreview.openInBrowser')}
            data-testid="file-preview-open-in-browser"
          >
            {t('filePreview.openInBrowser')}
          </button>
          <button
            onClick={onClose}
            className="text-[var(--text-dim)] hover:text-[var(--text-tertiary)] transition-colors p-1"
            title={t('tooltip.filePreview.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* File path (full path display) */}
      <div className="shrink-0 px-3 py-1.5 border-b border-[var(--border)]">
        <span className="text-[10px] text-[var(--text-faint)] font-mono break-all">{filePath}</span>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-sm text-[var(--text-dim)] animate-pulse">{t('common.loading')}</div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : isImage ? (
          <div className="flex flex-col items-center gap-3">
            <img
              src={`/api/artifact/raw?path=${encodeURIComponent(filePath)}`}
              alt={getFileName(filePath)}
              className="max-w-full rounded-lg border border-[var(--border)]"
            />
          </div>
        ) : language === 'markdown' ? (
          <MarkdownPreview content={content} variant="document" />
        ) : (
          <pre className="text-xs text-[var(--text-tertiary)] font-mono whitespace-pre-wrap leading-relaxed">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  )
}
