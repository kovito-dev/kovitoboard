/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * RecipeExportModal — modal-form replacement for the legacy
 * `RecipesPage` "export" tab.
 *
 * Triggered by the AppActionsPopover "Export recipe" action so the
 * exported recipe is always scoped to the focused app (DEC-024 #5 /
 * spec §F5). The modal:
 *
 *   1. Calls `GET /api/recipes/app-scan?appId=<appId>` to preview the
 *      contents that will ship in the recipe
 *   2. Collects metadata (recipeId / name / description / version /
 *      author) from the user
 *   3. Posts to `/api/recipes/export` with the appId + metadata; the
 *      server replies with a Markdown body and a
 *      `Content-Disposition: attachment` header so the browser saves
 *      the file via its built-in download flow
 *   4. Surfaces an inline confirmation with an "Export again" button
 *      so the user can iterate without re-opening the modal
 *
 * `recipeId` is required (DEC-024 D-8) and intentionally not seeded
 * from the manifest — most apps the user exports are user-authored
 * (no manifest), and pre-filling from a manifest would suggest a
 * derived identity that does not apply.
 *
 * Follow-up (post-rework, 2026-05-04): the directory format and the
 * explicit `outputPath` field were removed. The server never writes
 * to the host filesystem during export, so there is no `output path`
 * for the user to pick — the browser's normal "Save as" /
 * "Downloads folder" flow handles persistence.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppScanResult, RecipeMetadata } from '../../shared/recipe-types'
import { t } from '../i18n'

const RECIPE_ID_RE = /^[A-Za-z0-9_\-./@]+$/

type ModalState = 'scanning' | 'ready' | 'exporting' | 'done' | 'error'

interface RecipeExportModalProps {
  /** Target appId (resolved by the caller from the active route). */
  appId: string
  /** Friendly name shown in the modal header. */
  displayName: string
  /** Called when the user closes the modal (Esc / cancel / overlay click). */
  onClose: () => void
}

export function RecipeExportModal({ appId, displayName, onClose }: RecipeExportModalProps) {
  const [state, setState] = useState<ModalState>('scanning')
  const [scan, setScan] = useState<AppScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null)

  // Form fields. Empty initial values for required text inputs so the
  // user is forced to make explicit choices rather than accepting a
  // defaulted recipeId / name they did not intend.
  const [recipeId, setRecipeId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [author, setAuthor] = useState('')

  const recipeIdInputRef = useRef<HTMLInputElement>(null)

  // Initial scan. Re-run whenever the modal is reopened against a
  // different appId; that doubles as a defense against the user
  // somehow keeping a stale modal alive across app switches.
  useEffect(() => {
    if (!appId) {
      setError(t('recipe.export.error.appIdMissing'))
      setState('error')
      return
    }
    setState('scanning')
    setError(null)
    fetch(`/api/recipes/app-scan?appId=${encodeURIComponent(appId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: AppScanResult) => {
        setScan(data)
        setState('ready')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'scan failed')
        setState('error')
      })
  }, [appId])

  // Esc closes the modal — match AppRemovalModal's behaviour so the two
  // popover-spawned modals feel consistent.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Auto-focus the recipeId input once the form is rendered.
  useEffect(() => {
    if (state !== 'ready') return
    const id = requestAnimationFrame(() => {
      recipeIdInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [state])

  const validate = useCallback((): string | null => {
    if (!recipeId.trim()) return t('recipe.export.error.recipeIdRequired')
    if (recipeId.length > 256 || !RECIPE_ID_RE.test(recipeId)) {
      return t('recipe.export.error.recipeIdFormat')
    }
    if (!name.trim() || !description.trim()) return null // required field empty — disable submit instead of toasting
    return null
  }, [recipeId, name, description])

  const submitDisabled =
    !recipeId.trim() ||
    !name.trim() ||
    !description.trim() ||
    state === 'exporting' ||
    state === 'scanning'

  const handleExport = useCallback(async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setState('exporting')
    setError(null)

    const metadata: RecipeMetadata = {
      recipeId: recipeId.trim(),
      name: name.trim(),
      description: description.trim(),
      version: version.trim() || '1.0.0',
      author: author.trim() || undefined,
      kovitoboard: '>=0.1.0',
    }

    try {
      const res = await fetch('/api/recipes/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, metadata }),
      })
      if (!res.ok) {
        // Error path returns JSON `{ error, ... }`; success returns binary.
        const data = await res.json().catch(() => ({}))
        // The custom-BE refusal carries a structured shape with
        // `error: 'CustomBeNotExportable'` + `files` + `guidance`.
        // Surface a localized summary instead of the bare error code
        // so the user understands why the export was refused.
        if (data?.error === 'CustomBeNotExportable') {
          const sample = Array.isArray(data?.files) ? data.files : []
          const totalCount =
            typeof data?.filesCount === 'number' && data.filesCount > 0
              ? data.filesCount
              : sample.length
          const approximate = data?.filesCountApproximate === true
          // Show only the bounded sample in the modal; if the
          // actual count exceeds it, append a tail so the user
          // knows the list was truncated. When the scanner stopped
          // early it reports a lower-bound count, so the tail
          // becomes "...and N+ more" instead of "...and N more".
          const remaining = totalCount - sample.length
          const filesText =
            remaining > 0
              ? `${sample.join(', ')}, ...and ${remaining}${approximate ? '+' : ''} more`
              : sample.join(', ')
          throw new Error(
            t('recipe.export.error.customBeNotExportable', {
              appId,
              files: filesText,
            }),
          )
        }
        throw new Error(
          typeof data?.error === 'string' && data.error.length > 0
            ? data.error
            : `HTTP ${res.status}`,
        )
      }
      const blob = await res.blob()
      const filename = parseFilenameFromContentDisposition(
        res.headers.get('Content-Disposition'),
      ) ?? `${recipeId.trim()}.md`
      triggerBrowserDownload(blob, filename)
      setDownloadedFilename(filename)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
      setState('error')
    }
  }, [appId, recipeId, name, description, version, author, validate])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      data-testid="recipe-export-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-export-modal-title"
    >
      <div
        className="
          relative bg-[var(--bg-base)] border border-[var(--border)]
          rounded-lg shadow-2xl
          w-full max-w-lg max-h-[90vh] flex flex-col
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <h3
            id="recipe-export-modal-title"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            {t('recipe.export.modal.title')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            data-testid="recipe-export-modal-close"
            aria-label={t('recipe.export.modal.close')}
            className="text-[var(--text-dim)] hover:text-[var(--text-secondary)] text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          <p className="text-[var(--text-secondary)]">
            {t('recipe.export.modal.subtitle', { displayName })}
          </p>

          {state === 'scanning' && (
            <div className="text-[var(--text-dim)] text-sm py-2">
              {t('recipe.export.status.scanning')}
            </div>
          )}

          {state === 'error' && !scan && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}

          {scan && scan.artifacts.length === 0 && state !== 'done' && (
            <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-300">
              {t('recipe.export.empty')}
              <div className="mt-1 text-xs text-[var(--text-dim)]">{t('recipe.export.emptyHint')}</div>
            </div>
          )}

          {state === 'done' && (
            <div className="space-y-3">
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                <h4 className="text-sm font-bold text-green-400 mb-1">
                  {t('recipe.export.done.title')}
                </h4>
                <p className="text-xs text-[var(--text-secondary)] break-all">
                  {t('recipe.export.done.downloadStarted', {
                    filename: downloadedFilename ?? '',
                  })}
                </p>
                <p className="text-xs text-[var(--text-dim)] mt-1">
                  {t('recipe.export.done.downloadHint')}
                </p>
              </div>
            </div>
          )}

          {scan && scan.artifacts.length > 0 && state !== 'done' && (
            <>
              {/* Scan preview */}
              <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-3">
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
                  {t('recipe.export.scanResult.title')}
                </h4>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {scan.artifacts.map((a) => (
                    <div key={a.path} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-[var(--text-secondary)] truncate">{a.path}</span>
                      <span className="text-[var(--text-dim)] shrink-0 ml-2">
                        {a.type} / {(a.sizeBytes / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-[var(--text-dim)]">
                  {t('recipe.export.scanResult.total', {
                    fileCount: String(scan.artifacts.length),
                    size: (scan.totalSize / 1024).toFixed(1),
                  })}
                  {scan.menu.length > 0 &&
                    ` / ${t('recipe.export.scanResult.menuCount', { count: String(scan.menu.length) })}`}
                </div>
              </div>

              {/* recipeId */}
              <FormField label={t('recipe.export.field.recipeId')} required>
                <input
                  ref={recipeIdInputRef}
                  type="text"
                  value={recipeId}
                  onChange={(e) => setRecipeId(e.target.value)}
                  placeholder={t('recipe.export.field.recipeIdPlaceholder')}
                  data-testid="recipe-export-recipeId-input"
                  className="
                    w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
                    text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)]
                    focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]
                  "
                />
                <FieldHint>{t('recipe.export.hint.recipeId')}</FieldHint>
              </FormField>

              {/* name */}
              <FormField label={t('recipe.export.field.name')} required>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Custom Page"
                  data-testid="recipe-export-name-input"
                  className="
                    w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
                    text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)]
                    focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]
                  "
                />
              </FormField>

              {/* description */}
              <FormField label={t('recipe.export.field.description')} required>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('recipe.export.field.descriptionPlaceholder')}
                  data-testid="recipe-export-description-input"
                  className="
                    w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
                    text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)]
                    focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]
                  "
                />
              </FormField>

              {/* version + author */}
              <div className="flex gap-3">
                <FormField label={t('recipe.export.field.version')} className="flex-1">
                  <input
                    type="text"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    data-testid="recipe-export-version-input"
                    className="
                      w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
                      text-sm text-[var(--text-primary)]
                      focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]
                    "
                  />
                </FormField>
                <FormField label={t('recipe.export.field.author')} className="flex-1">
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="your-name"
                    data-testid="recipe-export-author-input"
                    className="
                      w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
                      text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)]
                      focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]
                    "
                  />
                </FormField>
              </div>

              {error && (
                <div
                  data-testid="recipe-export-error"
                  className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400"
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {state === 'done' ? (
          // Once the file is downloaded the only useful next step is
          // to dismiss the dialog. Re-running the export from this
          // surface added confusion (re-running validate, possibly
          // overwriting a freshly downloaded file with the same
          // name); the user can re-open the modal if a fresh
          // export is needed.
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onClose}
              data-testid="recipe-export-modal-close"
              className="px-3 py-1.5 text-sm bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg font-medium hover:opacity-80 transition-opacity"
            >
              {t('common.close')}
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onClose}
              data-testid="recipe-export-modal-cancel"
              className="px-3 py-1.5 text-sm text-[var(--text-secondary)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"
            >
              {t('recipe.export.modal.cancel')}
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={submitDisabled}
              data-testid="recipe-export-submit"
              className="
                px-3 py-1.5 text-sm bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg font-medium
                hover:opacity-80 disabled:opacity-40 transition-opacity
              "
            >
              {state === 'exporting' ? t('recipe.export.status.exporting') : t('recipe.export.button.export')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Trigger a browser download for `blob` using the saved filename.
 *
 * The DOM dance (`createObjectURL` → temporary `<a>` → `click()` →
 * `revokeObjectURL`) is the standard way to drive a download from a
 * binary `fetch` response: there is no programmatic API that takes a
 * Blob and a filename directly. The temporary anchor stays in the DOM
 * for one frame so click dispatch is reliable across browsers.
 */
function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Give the browser a tick to start the download before invalidating
  // the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Best-effort filename extraction from a `Content-Disposition` header.
 * Returns null when the header is absent or the filename token is
 * missing. The server emits ASCII-only filenames (recipeId is
 * sanitised to `[A-Za-z0-9._-]`), so we can keep the parser simple
 * and skip RFC 5987 `filename*=UTF-8''` decoding.
 */
function parseFilenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null
  const match = /filename="([^"]+)"/.exec(value) ?? /filename=([^;]+)/.exec(value)
  return match ? match[1].trim() : null
}

interface FormFieldProps {
  label: string
  required?: boolean
  className?: string
  children: React.ReactNode
}
function FormField({ label, required, className = '', children }: FormFieldProps) {
  return (
    <div className={className}>
      <label className="block text-xs text-[var(--text-secondary)] mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] text-[var(--text-dim)] mt-1">{children}</div>
}
