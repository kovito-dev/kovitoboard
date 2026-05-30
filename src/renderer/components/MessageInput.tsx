/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { createLogger } from '../lib/logger'
import { kbFetch } from '../lib/kbFetch'

const log = createLogger('MessageInput')

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
  /**
   * Q6 / SS-5: when true, the agent is currently producing a response
   * (Claude Code is in `thinking` / `waiting` state). The send button
   * morphs into a Stop button regardless of draft contents, and Esc
   * inside the textarea triggers `onInterrupt` instead of being a
   * no-op. Independent of `isSending` (which only tracks the local
   * optimistic-send transition).
   */
  isAgentBusy?: boolean
  /**
   * Q6 / SS-5: invoked when the user clicks the Stop button or
   * presses Esc while `isAgentBusy` is true. Implementations are
   * expected to dispatch a Ctrl-C to the agent's tmux pane.
   */
  onInterrupt?: () => void
  /**
   * Controlled text value. The parent owns the state so it can be scoped
   * per session — see `useIPC.getDraft`/`setDraft`.
   */
  value: string
  /** Called whenever the textarea content changes (including after send). */
  onChange: (value: string) => void
  /**
   * Compact layout for narrow surfaces such as AmbientSidebar.
   * Hides the bottom hint row, tightens vertical padding, and removes
   * the centered max-width wrapper that the chat surface uses.
   */
  compact?: boolean
  /**
   * Show a top-edge drag handle that lets the user resize the textarea
   * vertically. The persisted height is keyed by `storageKey` if given.
   */
  resizable?: boolean
  /**
   * localStorage suffix for persisting the manual textarea height.
   * Without this, the resized height lives only in component state and
   * is lost on remount.
   */
  storageKey?: string
  /**
   * Show a "capture screen" button next to the file-attach button. Uses
   * `navigator.mediaDevices.getDisplayMedia` to grab a single frame from
   * the user-selected screen / window / tab and pushes it through the
   * existing /api/upload pipeline. Hidden automatically when the browser
   * does not expose getDisplayMedia.
   */
  screenshotEnabled?: boolean
  /**
   * Initial textarea height (in pixels) when nothing is persisted under
   * `storageKey`. Caps to the resize min/max bounds. Useful for narrow
   * surfaces like the AmbientSidebar that want a tighter default than
   * the chat surface (80px).
   */
  initialHeight?: number
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

/** Resize bounds for the manual height drag handle. */
const RESIZE_MIN_PX = 60
const RESIZE_MAX_PX = 400
/** Default height when no manual override is in effect. */
const RESIZE_DEFAULT_PX = 80

/**
 * Read a previously persisted manual textarea height. Defensive against
 * SSR / privacy-mode environments where localStorage may throw.
 */
function loadStoredHeight(storageKey: string | undefined, fallback: number): number {
  const clampedFallback = Math.min(RESIZE_MAX_PX, Math.max(RESIZE_MIN_PX, fallback))
  if (!storageKey) return clampedFallback
  try {
    const raw = window.localStorage.getItem(`kb.messageInput.height.${storageKey}`)
    if (!raw) return clampedFallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return clampedFallback
    return Math.min(RESIZE_MAX_PX, Math.max(RESIZE_MIN_PX, n))
  } catch {
    return clampedFallback
  }
}

function persistStoredHeight(storageKey: string | undefined, height: number): void {
  if (!storageKey) return
  try {
    window.localStorage.setItem(
      `kb.messageInput.height.${storageKey}`,
      String(Math.round(height)),
    )
  } catch {
    // Ignore persistence failures (privacy mode, quota, etc.)
  }
}

/**
 * Capture a single frame from a user-selected screen / window / tab via
 * `getDisplayMedia` and return it as a PNG blob. Returns null when the
 * user cancels the picker or when the browser does not expose the API.
 *
 * Throws on unexpected failures so callers can surface an error message
 * to the user.
 */
async function captureScreenshotBlob(): Promise<Blob | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    })
  } catch (err) {
    // User cancelled the picker — treat as a no-op.
    const name = (err as Error)?.name
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return null
    }
    throw err
  }

  try {
    // Pump the MediaStream through a hidden <video> so we can read a
    // single frame. The element is never attached to the DOM.
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Screenshot video element failed to load'))
    })
    await video.play()

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Screenshot canvas 2D context unavailable')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    })
  } finally {
    // Always stop the capture so the browser drops the screen-share
    // indicator immediately, even if blob conversion failed.
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* noop */ }
    }
  }
}

export function MessageInput({
  onSend,
  disabled,
  placeholder,
  isSending,
  onSendError,
  isAgentBusy = false,
  onInterrupt,
  value,
  onChange,
  compact = false,
  resizable = false,
  storageKey,
  screenshotEnabled = false,
  initialHeight,
}: MessageInputProps) {
  const text = value
  const setText = onChange
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // --- Manual textarea height (resizable mode) ---
  // Tracks the user's preferred minimum height. The textarea may grow
  // beyond this value via auto-grow, but never shrinks below it.
  const [manualHeightPx, setManualHeightPx] = useState<number>(() => {
    const fallback = initialHeight ?? RESIZE_DEFAULT_PX
    return resizable ? loadStoredHeight(storageKey, fallback) : RESIZE_DEFAULT_PX
  })
  const [isResizingHeight, setIsResizingHeight] = useState(false)

  // Persist the manual height once the drag settles (skip during the
  // active drag to avoid hammering localStorage on every pointer move).
  useEffect(() => {
    if (!resizable || isResizingHeight) return
    persistStoredHeight(storageKey, manualHeightPx)
  }, [resizable, isResizingHeight, manualHeightPx, storageKey])

  // While dragging vertically: lock body selection and force a global
  // row-resize cursor for continuous feedback even when the pointer
  // strays outside the handle's hit area. Mirrors AmbientSidebar's
  // width resize pattern.
  useEffect(() => {
    if (!isResizingHeight) return
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
    }
  }, [isResizingHeight])

  /**
   * Compute the effective textarea height: the larger of the manual
   * minimum and the natural content height (capped by RESIZE_MAX_PX).
   * Called both from `handleInput` (typing) and from the manual resize
   * handler so both pathways converge on the same formula.
   */
  const applyTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const minHeight = resizable ? manualHeightPx : 0
    const maxHeight = resizable ? Math.max(manualHeightPx, RESIZE_MAX_PX) : 200
    el.style.height = 'auto'
    // `scrollHeight` reports the content box + padding but excludes the
    // border. Under `box-sizing: border-box` the CSS `height` we assign
    // *includes* the border, so writing `height = scrollHeight` leaves
    // the content area 1px short on each edge — a permanent 2px overflow
    // that forces the vertical scrollbar to stay visible even when the
    // text fits. Add the border back so the box exactly contains its
    // content and overflow-y:auto stays hidden.
    const borderHeight = el.offsetHeight - el.clientHeight
    const natural = Math.min(el.scrollHeight + borderHeight, maxHeight)
    el.style.height = Math.max(minHeight, natural) + 'px'
  }, [manualHeightPx, resizable])

  // Reapply height whenever the manual minimum changes so the textarea
  // expands/shrinks in lockstep with the drag. The first pass also seeds
  // the initial mount height. Deferred to the next animation frame so it
  // runs after the surrounding layout has flushed (also matches the
  // `handleInput` path and adds at most one imperceptible frame).
  useEffect(() => {
    const id = requestAnimationFrame(applyTextareaHeight)
    return () => cancelAnimationFrame(id)
  }, [applyTextareaHeight])

  // Recompute height whenever the textarea's *width* changes. The height
  // is derived from `scrollHeight`, which depends on how the placeholder
  // (and any typed text) wraps — and that in turn depends on the current
  // width. The Ambient sidebar mounts this input while its open/close
  // width transition (`transition-[width] duration-200`) is still
  // running, so the textarea is briefly only a couple dozen px wide. At
  // that width the placeholder wraps into ~17 lines and `scrollHeight`
  // balloons to ~272px; the value got latched as the textarea height and
  // the input occupied roughly half the sidebar until the first drag
  // forced a re-measure.
  // A ResizeObserver re-runs the height formula once the transition (or a
  // window resize / sidebar drag-resize) settles the real width, so the
  // empty input collapses back to `manualHeightPx`.
  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      applyTextareaHeight()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [applyTextareaHeight])

  /** Upload file to the server */
  const uploadFile = useCallback(async (file: File | Blob, originalName?: string): Promise<AttachedFile | null> => {
    setIsUploading(true)
    setUploadError(null)
    try {
      const buffer = await file.arrayBuffer()
      const res = await kbFetch('/api/upload', {
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
      const attachLabel = t('chat.input.attachedFiles')
      fullMessage = trimmedText
        ? `${trimmedText}\n\n${attachLabel}:\n${fileLines}`
        : `${attachLabel}:\n${fileLines}`
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
      // Reset textarea height: when resizable, snap back to the manual
      // floor; otherwise let the auto-grow path collapse to one row.
      if (textareaRef.current) {
        textareaRef.current.style.height = resizable ? `${manualHeightPx}px` : 'auto'
      }
    } catch (err) {
      // Send failed: show error, keep input content (so user can retry)
      const errorMsg = err instanceof Error ? err.message : t('chat.input.sendFallback')
      log.error(
        { err, errorMsg, messageLength: text.length, fileCount: attachedFiles.length },
        'Send error',
      )
      setSendError(errorMsg)
      // Notify the caller of the error (for rolling back optimistic messages)
      if (onSendError) {
        onSendError(err instanceof Error ? err : new Error(errorMsg))
      }
    }
  }, [text, attachedFiles, disabled, isSending, onSend, onSendError, resizable, manualHeightPx, setText])

  /** Keyboard handling */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSend()
      return
    }
    // Q6 / SS-5: while the agent is producing a response, Esc inside
    // the composer dispatches the same Ctrl-C as the Stop button.
    if (e.key === 'Escape' && isAgentBusy && onInterrupt) {
      e.preventDefault()
      onInterrupt()
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

  /** Auto-adjust textarea height on input. */
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    // Defer height computation to the shared helper so manual + auto
    // sizing converge on a single formula.
    requestAnimationFrame(applyTextareaHeight)
  }, [setText, applyTextareaHeight])

  /** Pointer-driven resize of the textarea height (resizable mode). */
  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizable) return
    event.preventDefault()
    setIsResizingHeight(true)

    const startY = event.clientY
    const startHeight = manualHeightPx

    const onMove = (e: PointerEvent) => {
      // Dragging up (decreasing clientY) grows the textarea.
      const delta = startY - e.clientY
      const next = Math.min(RESIZE_MAX_PX, Math.max(RESIZE_MIN_PX, startHeight + delta))
      setManualHeightPx(next)
    }
    const onUp = () => {
      setIsResizingHeight(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [resizable, manualHeightPx])

  /** Capture a screenshot via getDisplayMedia and attach it. */
  const handleScreenshot = useCallback(async () => {
    if (isCapturing) return
    setIsCapturing(true)
    try {
      const blob = await captureScreenshotBlob()
      if (!blob) return // user cancelled the picker
      const fileName = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
      const attached = await uploadFile(blob, fileName)
      if (attached) {
        setAttachedFiles((prev) => [...prev, attached])
      }
    } catch (err) {
      log.error({ err }, 'Screenshot capture failed')
      setUploadError(t('chat.input.screenshot.error'))
    } finally {
      setIsCapturing(false)
    }
  }, [isCapturing, uploadFile])

  const isDisabled = disabled || isSending
  const canSend = (text.trim().length > 0 || attachedFiles.length > 0) && !isDisabled && !isUploading
  // Hide the screenshot button entirely on browsers that lack the API.
  const canCaptureScreen =
    screenshotEnabled &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia

  // --- Compact-aware class fragments ---
  // Pulled up so the JSX stays readable and the difference between the
  // two layouts is obvious.
  const containerClass = compact
    ? 'shrink-0 border-t border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5'
    : 'shrink-0 border-t border-[var(--border)] bg-[var(--bg-surface)] px-2 md:px-4 py-2 md:py-3'
  const innerWrapperClass = compact
    ? 'flex items-end gap-1.5 max-w-full'
    : 'flex items-end gap-2 md:gap-3 max-w-4xl mx-auto'
  const previewWrapperClass = compact
    ? 'flex flex-wrap gap-1.5 max-w-full mb-1.5'
    : 'flex flex-wrap gap-2 max-w-4xl mx-auto mb-2'
  const errorWrapperClass = compact
    ? 'max-w-full mb-1.5'
    : 'max-w-4xl mx-auto mb-2'
  const buttonSizeClass = compact ? 'w-8 h-8' : 'w-10 h-10'
  // Non-compact textarea is `block` + `py-[9px]` so the input row's
  // `items-end` alignment lines the attach/send buttons up with the
  // textarea exactly. Two box quirks made the buttons look "sunk" before:
  //   1. A `<textarea>` defaults to inline-level, so its `flex-1 relative`
  //      wrapper reserved ~7px of inline line-box descender below it; the
  //      buttons bottom-aligned to the wrapper (not the textarea) and hung
  //      ~7px under the textarea's bottom edge. `block` collapses the
  //      wrapper to the textarea's own height.
  //   2. With `py-3` the single-line textarea was 46px tall vs the 40px
  //      (`w-10 h-10`) buttons, leaving a 6px top-edge offset under
  //      `items-end`. `py-[9px]` (9+9 padding + 20px line + 2px border)
  //      makes the resting single-line height exactly 40px, so top and
  //      bottom line up; auto-grow still lets the buttons follow the
  //      bottom edge on multi-line input.
  const textareaClass = compact
    ? `
        w-full resize-none overflow-y-auto rounded-lg px-2.5 py-2 pr-3
        bg-[var(--bg-base)] border border-[var(--border)]
        text-xs text-[var(--text-secondary)] placeholder-gray-600
        focus:outline-none focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent-ring)]
        disabled:opacity-50 disabled:cursor-not-allowed
        transition-colors
      `
    : `
        block w-full resize-none overflow-y-auto rounded-xl px-4 py-[9px] pr-12
        bg-[var(--bg-elevated)] border border-[var(--border)]
        text-sm text-[var(--text-secondary)] placeholder-gray-600
        focus:outline-none focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent-ring)]
        disabled:opacity-50 disabled:cursor-not-allowed
        transition-colors
      `

  return (
    <div
      className={containerClass}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Vertical resize handle (resizable mode only) */}
      {resizable && (
        <div
          data-testid="message-input-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('chat.input.resize.handle')}
          onPointerDown={handleResizePointerDown}
          className="
            -mt-1 mb-1 h-1 w-full
            cursor-row-resize
            hover:bg-[var(--accent-border)]/40
            active:bg-[var(--accent-border)]/60
            transition-colors
          "
        />
      )}

      {/* Attached file preview */}
      {attachedFiles.length > 0 && (
        <div className={previewWrapperClass}>
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
                title={t('tooltip.input.removeAttachment')}
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
        <div className={errorWrapperClass}>
          <div className="text-[11px] text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-1.5">
            {uploadError}
          </div>
        </div>
      )}

      {/* Send error display */}
      {sendError && (
        <div className={errorWrapperClass}>
          <div className="flex items-center justify-between text-[11px] text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-1.5">
            <span>{t('chat.input.sendError')}: {sendError}</span>
            <button
              onClick={() => setSendError(null)}
              className="ml-2 text-red-500 hover:text-red-300 transition-colors"
              title={t('tooltip.input.dismissError')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className={innerWrapperClass}>
        {/* File attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled || isUploading}
          className={`
            shrink-0 ${buttonSizeClass} rounded-xl flex items-center justify-center
            transition-colors
            ${isDisabled || isUploading
              ? 'bg-[var(--bg-elevated)] text-[var(--text-faint)] cursor-not-allowed'
              : 'bg-[var(--bg-elevated)] text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] hover:bg-[var(--bg-hover)]'
            }
          `}
          title={t('tooltip.input.attachFile')}
        >
          {isUploading ? (
            <svg className={`animate-spin ${compact ? 'w-4 h-4' : 'w-5 h-5'}`} viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg width={compact ? '14' : '18'} height={compact ? '14' : '18'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

        {/* Screenshot capture button */}
        {canCaptureScreen && (
          <button
            data-testid="message-input-screenshot"
            onClick={handleScreenshot}
            disabled={isDisabled || isUploading || isCapturing}
            className={`
              shrink-0 ${buttonSizeClass} rounded-xl flex items-center justify-center
              transition-colors
              ${isDisabled || isUploading || isCapturing
                ? 'bg-[var(--bg-elevated)] text-[var(--text-faint)] cursor-not-allowed'
                : 'bg-[var(--bg-elevated)] text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] hover:bg-[var(--bg-hover)]'
              }
            `}
            title={t('chat.input.screenshot.tooltip')}
            aria-label={t('chat.input.screenshot.button')}
          >
            {isCapturing ? (
              <svg className={`animate-spin ${compact ? 'w-4 h-4' : 'w-5 h-5'}`} viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg width={compact ? '14' : '18'} height={compact ? '14' : '18'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            )}
          </button>
        )}

        {/* Text input */}
        <div className="flex-1 relative">
          <textarea
            data-testid="message-input-textarea"
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isDisabled}
            placeholder={placeholder || t('chat.input.placeholder')}
            rows={1}
            className={textareaClass}
            style={{
              ...(resizable
                ? { minHeight: `${manualHeightPx}px`, maxHeight: `${Math.max(manualHeightPx, RESIZE_MAX_PX)}px` }
                : { maxHeight: '200px' }),
            }}
          />
        </div>

        {/* Send / Stop button. Q6 / SS-5 morphs the send affordance
            into a Stop button while the agent is producing a response;
            clicking dispatches Ctrl-C via `onInterrupt`. */}
        {isAgentBusy && onInterrupt ? (
          <button
            data-testid="message-input-stop"
            onClick={onInterrupt}
            className={`
              shrink-0 ${buttonSizeClass} rounded-xl flex items-center justify-center
              transition-all duration-200
              bg-[var(--danger-bg,#dc2626)] hover:bg-[var(--danger-bg-hover,#b91c1c)]
              text-white shadow-lg
            `}
            title={t('tooltip.input.stop')}
            aria-label={t('tooltip.input.stop')}
          >
            <svg
              width={compact ? '14' : '18'}
              height={compact ? '14' : '18'}
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            data-testid="message-input-send"
            onClick={handleSend}
            disabled={!canSend}
            className={`
              shrink-0 ${buttonSizeClass} rounded-xl flex items-center justify-center
              transition-all duration-200
              ${canSend
                ? 'bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent-shadow)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-faint)] cursor-not-allowed'
              }
            `}
            title={t('tooltip.input.send')}
          >
            {isSending ? (
              <svg className={`animate-spin ${compact ? 'w-4 h-4' : 'w-5 h-5'}`} viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg width={compact ? '14' : '18'} height={compact ? '14' : '18'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Hints (hidden in compact mode — host surfaces should provide
          their own contextual hint if any) */}
      {!compact && (
        <div className="flex items-center justify-between max-w-4xl mx-auto mt-1 md:mt-1.5 px-1">
          <span className="text-[10px] text-[var(--text-faint)] hidden sm:inline">
            {t('chat.input.hint.full')}
          </span>
          <span className="text-[10px] text-[var(--text-faint)] sm:hidden">
            {t('chat.input.hint.short')}
          </span>
          {isSending && (
            <span className="text-[10px] text-[var(--accent-text-vivid)] animate-pulse">
              {t('chat.input.status.responding')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
