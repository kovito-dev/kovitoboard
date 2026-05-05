/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe import flow — source input → parse → inspect → code review → apply.
 */
import { useState, useCallback, useRef } from 'react'
import { RecipeCodeViewer } from './RecipeCodeViewer'
import { getRecipeDescription, getRecipeName } from '../utils/recipe-display'
import type {
  ParsedRecipe,
  InspectionResult,
  InspectionVerdict,
  RecipeUploadFile,
} from '../../shared/recipe-types'
import { t } from '../i18n'

/**
 * Mirror the server-side caps in `recipe-upload-routes.ts` so the
 * renderer can refuse oversized payloads before round-tripping. Keep
 * these in sync; the server validates again as the source of truth.
 */
const MAX_FILE_SIZE = 1 * 1024 * 1024
const MAX_TOTAL_SIZE = 5 * 1024 * 1024
const MAX_FILE_COUNT = 50
const ALLOWED_EXTENSIONS = [
  '.tsx',
  '.ts',
  '.css',
  '.json',
  '.md',
  '.markdown',
  '.yaml',
  '.yml',
] as const

type ImportState = 'idle' | 'parsing' | 'inspected' | 'applying' | 'applied' | 'error'

// Built at module evaluation. The locale is restored from
// localStorage by `i18n/readPersistedLocale()` (OSS fallback: en).
const VERDICT_STYLES: Record<InspectionVerdict, { bg: string; text: string; label: string }> = {
  blocked: { bg: 'bg-red-500/20', text: 'text-red-400', label: t('recipe.import.verdict.blocked') },
  warning: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: t('recipe.import.verdict.warning') },
  caution: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: t('recipe.import.verdict.caution') },
  safe: { bg: 'bg-green-500/20', text: 'text-green-400', label: t('recipe.import.verdict.safe') },
}

export function RecipeImport() {
  const [source, setSource] = useState('')
  const [state, setState] = useState<ImportState>('idle')
  const [recipe, setRecipe] = useState<ParsedRecipe | null>(null)
  const [inspection, setInspection] = useState<InspectionResult | null>(null)
  const [codeReviewed, setCodeReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [appliedId, setAppliedId] = useState<string | null>(null)

  // Refs let us trigger the hidden file inputs from button clicks
  // without inheriting the file dialog's default styling.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  const handleParse = useCallback(async () => {
    if (!source.trim()) return
    setState('parsing')
    setError(null)

    try {
      const res = await fetch('/api/recipes/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: source.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Parse failed')
      }
      setRecipe(data.recipe)
      setInspection(data.inspection)
      setCodeReviewed(false)
      setState('inspected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Parse failed')
      setState('error')
    }
  }, [source])

  /**
   * RC-3: ship the user's picked file(s) as a JSON payload to
   * /api/recipes/parse-upload. We avoid multipart upload to keep
   * the server free of a binary parser dependency — recipe artifacts
   * are UTF-8 text by spec, so this round-trip is lossless.
   *
   * Mode 'file' means a lone `.md` recipe; mode 'dir' means the
   * user picked a directory via webkitdirectory and every file
   * inside is part of the recipe.
   */
  const uploadFiles = useCallback(async (fileList: FileList, mode: 'file' | 'dir') => {
    setState('parsing')
    setError(null)

    try {
      const candidates = Array.from(fileList)
      if (candidates.length === 0) {
        throw new Error(t('recipe.import.upload.noFiles'))
      }
      if (candidates.length > MAX_FILE_COUNT) {
        throw new Error(t('recipe.import.upload.tooManyFiles', { max: String(MAX_FILE_COUNT) }))
      }

      // Build the relative-path keyed payload. webkitRelativePath is
      // populated whenever webkitdirectory is set on the input, but
      // even Chromium occasionally reports an empty string for the
      // root file — fall back to `file.name` so the request still
      // names something. Single-file mode skips this entirely and
      // uses the file name verbatim.
      const files: RecipeUploadFile[] = []
      let total = 0
      for (const file of candidates) {
        let relPath: string
        if (mode === 'dir') {
          const wp = (file as File & { webkitRelativePath?: string }).webkitRelativePath
          relPath = wp && wp.length > 0 ? wp : file.name
          // Strip the top-level directory name the browser prepends
          // (e.g. `my-recipe/recipe.yaml` → `recipe.yaml`) so the
          // server receives the recipe-relative path the parser
          // expects to find next to recipe.yaml.
          const slash = relPath.indexOf('/')
          if (slash > 0) relPath = relPath.slice(slash + 1)
        } else {
          relPath = file.name
        }
        if (file.size > MAX_FILE_SIZE) {
          throw new Error(t('recipe.import.upload.fileTooLarge', { name: relPath }))
        }
        total += file.size
        if (total > MAX_TOTAL_SIZE) {
          throw new Error(t('recipe.import.upload.totalTooLarge'))
        }
        const lower = relPath.toLowerCase()
        if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
          // Skip silently — directory recipes routinely contain
          // README assets the parser would refuse anyway. Only
          // raise when the user selected a single file with the
          // wrong extension, otherwise we'd block legitimate
          // directory uploads on auxiliary resources.
          if (mode === 'file') {
            throw new Error(t('recipe.import.upload.unsupportedExtension', { name: relPath }))
          }
          continue
        }
        const content = await file.text()
        files.push({ relPath, content })
      }

      if (files.length === 0) {
        throw new Error(t('recipe.import.upload.noSupportedFiles'))
      }

      const res = await fetch('/api/recipes/parse-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Parse failed')
      }
      setRecipe(data.recipe)
      setInspection(data.inspection)
      setCodeReviewed(false)
      setState('inspected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Parse failed')
      setState('error')
    }
  }, [])

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      uploadFiles(files, 'file')
      // Reset so the user can re-pick the same file after an error.
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [uploadFiles],
  )

  const handleDirSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      uploadFiles(files, 'dir')
      if (dirInputRef.current) dirInputRef.current.value = ''
    },
    [uploadFiles],
  )

  const handleApply = useCallback(async () => {
    if (!recipe || !inspection) return
    setState('applying')
    setError(null)

    try {
      const res = await fetch('/api/recipes/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe, inspection }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Apply failed')
      }
      setAppliedId(data.historyId)
      setState('applied')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed')
      setState('error')
    }
  }, [recipe, inspection])

  const handleReset = () => {
    setState('idle')
    setRecipe(null)
    setInspection(null)
    setCodeReviewed(false)
    setError(null)
    setAppliedId(null)
  }

  const canApply =
    inspection &&
    inspection.verdict !== 'blocked' &&
    (inspection.verdict === 'safe' || inspection.verdict === 'caution' || codeReviewed)

  return (
    <div className="space-y-4">
      {/* Source input */}
      {(state === 'idle' || state === 'error') && (
        <div className="space-y-4">
          {/* RC-3: file-picker source. Sits above the path-input
              variant because the dialog is the friendlier default
              for casual users — pasting an absolute path is now an
              advanced affordance. */}
          <div className="space-y-2">
            <label className="block text-sm text-[var(--text-secondary)]">
              {t('recipe.import.upload.label')}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="recipe-import-pick-file"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
              >
                {t('recipe.import.upload.button.file')}
              </button>
              <button
                type="button"
                data-testid="recipe-import-pick-dir"
                onClick={() => dirInputRef.current?.click()}
                className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
              >
                {t('recipe.import.upload.button.dir')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="recipe-import-file-input"
            />
            {/* webkitdirectory is non-standard but supported across
                Chromium / WebKit / Firefox for our use case. The
                React typings still refuse the attribute, so we set
                it via the underlying DOM ref using a typed callback. */}
            <input
              ref={(el) => {
                dirInputRef.current = el
                if (el) {
                  el.setAttribute('webkitdirectory', '')
                  el.setAttribute('directory', '')
                }
              }}
              type="file"
              multiple
              onChange={handleDirSelect}
              className="hidden"
              data-testid="recipe-import-dir-input"
            />
            <p className="text-xs text-[var(--text-dim)]">
              {t('recipe.import.upload.hint')}
            </p>
          </div>

          {/* Legacy absolute-path entry kept for power users / CI
              flows. RC-3 explicitly elects to keep this around so
              the path-based scenarios in the L1 suite and external
              tooling continue to work without change. */}
          <details className="group">
            <summary className="text-xs text-[var(--text-dim)] cursor-pointer select-none hover:text-[var(--text-secondary)]">
              {t('recipe.import.advanced.toggle')}
            </summary>
            <div className="mt-2 space-y-2">
              <label className="block text-sm text-[var(--text-secondary)]">
                {t('recipe.import.field.path')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  data-testid="recipe-import-source-input"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                  placeholder="/path/to/recipe/ or /path/to/recipe.md"
                  className="flex-1 px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
                />
                <button
                  data-testid="recipe-import-parse"
                  onClick={handleParse}
                  disabled={!source.trim()}
                  className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
                >
                  {t('recipe.import.button.parse')}
                </button>
              </div>
              <p className="text-xs text-[var(--text-dim)]">
                {t('recipe.import.field.pathHint')}
              </p>
            </div>
          </details>

          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Parsing */}
      {state === 'parsing' && (
        <div className="flex items-center justify-center py-8">
          <div className="text-[var(--text-dim)] text-sm">{t('recipe.import.status.parsing')}</div>
        </div>
      )}

      {/* Inspection result */}
      {(state === 'inspected' || state === 'applying') && recipe && inspection && (
        <div className="space-y-4">
          {/* Metadata */}
          <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[var(--text-primary)]">
                {getRecipeName(recipe.metadata)} v{recipe.metadata.version}
              </h3>
              {(() => {
                const vs = VERDICT_STYLES[inspection.verdict]
                return (
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${vs.bg} ${vs.text}`}>
                    {vs.label}
                  </span>
                )
              })()}
            </div>
            {recipe.metadata.author && (
              <p className="text-xs text-[var(--text-dim)]">
                Author: {recipe.metadata.author}
              </p>
            )}
            <p className="text-sm text-[var(--text-secondary)]">
              {getRecipeDescription(recipe.metadata)}
            </p>
            <p className="text-xs text-[var(--text-dim)]">
              Source: {recipe.sourcePath} ({recipe.sourceFormat})
            </p>
            {inspection.remoteCheckSkipped && (
              <p className="text-xs text-yellow-400">
                ⚠ {inspection.note}
              </p>
            )}
          </div>

          {/* Findings summary */}
          {inspection.findings.length > 0 && (
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
                {t('recipe.import.findings.title', { count: String(inspection.findings.length) })}
              </h4>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {inspection.findings.map((f, i) => (
                  <div key={i} className="text-xs text-[var(--text-secondary)]">
                    <span className={`font-bold ${
                      f.severity === 'critical' ? 'text-red-400' :
                      f.severity === 'high' ? 'text-orange-400' :
                      f.severity === 'medium' ? 'text-yellow-400' : 'text-blue-400'
                    }`}>
                      [{f.severity}]
                    </span>{' '}
                    {f.file}{f.line ? `:${f.line}` : ''} — {f.description}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Code viewer */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              {t('recipe.import.code.title')}
            </h4>
            <RecipeCodeViewer
              artifacts={recipe.artifacts}
              findings={inspection.findings}
              requireReview={inspection.verdict === 'warning'}
              onReviewComplete={() => setCodeReviewed(true)}
            />
          </div>

          {/* Menu entries */}
          {recipe.menu.length > 0 && (
            <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                {t('recipe.import.menu.title')}
              </h4>
              {recipe.menu.map((m) => (
                <div key={m.id} className="text-xs text-[var(--text-secondary)]">
                  📌 {m.label} (icon: {m.icon})
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:bg-[var(--bg-elevated)] transition-colors"
            >
              {t('common.cancel')}
            </button>
            {inspection.verdict !== 'blocked' && (
              <button
                onClick={handleApply}
                disabled={!canApply || state === 'applying'}
                className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
              >
                {state === 'applying' ? t('recipe.import.status.applying') : t('recipe.import.button.apply')}
              </button>
            )}
            {inspection.verdict === 'warning' && !codeReviewed && (
              <span className="text-xs text-orange-400">
                {t('recipe.import.hint.reviewRequired')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Applied */}
      {state === 'applied' && (
        <div className="space-y-3">
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
            <h3 className="text-sm font-bold text-green-400 mb-1">
              {t('recipe.import.applied.title')}
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              {t('recipe.import.applied.description', { id: appliedId ?? '' })}
            </p>
          </div>
          <button
            onClick={handleReset}
            className="px-4 py-2 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:bg-[var(--bg-elevated)] transition-colors"
          >
            {t('recipe.import.button.importAnother')}
          </button>
        </div>
      )}
    </div>
  )
}
