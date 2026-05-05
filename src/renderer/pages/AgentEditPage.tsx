/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent attribute editing page
 *
 * Editing UI for structured fields (display name, personality, tone sample, extra instructions).
 * Fetches current values via GET /api/agents/:id/sections
 * and persists changes via PUT /api/agents/:id.
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { t } from '../i18n'
import { StructuredFieldEditor, type SectionData } from '../components/StructuredFieldEditor'

/** Response type for GET /api/agents/:id/sections */
interface SectionsResponse {
  hasMarkers: boolean
  displayName?: string
  description?: string
  model?: string
  themeColor?: string
  personality?: string
  toneSample?: string
  extraInstructions?: string
}

export function AgentEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [sections, setSections] = useState<SectionsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Q2 / AD-2: track the inject-markers operation separately from the
  // initial load so the banner can show a localised "saving..."
  // affordance without blocking the rest of the editor.
  const [isInjectingMarkers, setIsInjectingMarkers] = useState(false)
  const [injectError, setInjectError] = useState<string | null>(null)

  const loadSections = useCallback(async () => {
    if (!id) return
    setIsLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/agents/${id}/sections`)
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      const data = (await res.json()) as SectionsResponse
      setSections(data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to fetch section data')
    } finally {
      setIsLoading(false)
    }
  }, [id])

  // Fetch current values of structured fields on mount.
  useEffect(() => {
    void loadSections()
  }, [loadSections])

  // Q2 / AD-2: invoke the inject-markers route, then reload so the
  // editor switches into the structured-edit branch immediately.
  const handleInjectMarkers = useCallback(async () => {
    if (!id) return
    setIsInjectingMarkers(true)
    setInjectError(null)
    try {
      const res = await fetch(`/api/agents/${id}/inject-markers`, { method: 'POST' })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? `Failed (${res.status})`)
      }
      await loadSections()
    } catch (err) {
      setInjectError(err instanceof Error ? err.message : 'Failed to inject markers')
    } finally {
      setIsInjectingMarkers(false)
    }
  }, [id, loadSections])

  // Save
  const handleSave = useCallback(async (data: SectionData) => {
    if (!id) return

    setIsSaving(true)
    setSaveError(null)

    try {
      // Build the request body for changed fields
      const body: Record<string, unknown> = {}

      // Always send the four frontmatter fields. Empty string clears
      // the value, undefined leaves it untouched (we never send
      // undefined here — the form always supplies a string).
      body.displayName = data.displayName
      body.description = data.description
      body.model = data.model
      body.themeColor = data.themeColor

      // Update sections (only when markers exist in the agent file)
      if (sections?.hasMarkers) {
        body.sections = {
          personality: data.personality,
          toneSample: data.toneSample,
          extraInstructions: data.extraInstructions,
        }
      }

      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const resData = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(resData.error || `Save failed (${res.status})`)
      }

      // Success — navigate back to agent detail
      navigate(`/agents/${id}`)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }, [id, sections, navigate])

  const handleCancel = useCallback(() => {
    navigate(`/agents/${id}`)
  }, [id, navigate])

  if (!id) {
    return <Navigate to="/agents" replace />
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={handleCancel}
          className="flex items-center gap-1 text-sm text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors mb-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {t('agent.edit.button.backToDetail')}
        </button>
        <h2 className="text-lg font-semibold text-[var(--text-secondary)]">
          {t('agent.edit.title')}
        </h2>
        <p className="text-sm text-[var(--text-dim)] mt-1">
          {t('agent.edit.description', { id })}
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm text-[var(--text-dim)]">{t('common.loading')}</div>
        </div>
      )}

      {/* Error */}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm text-red-400">{loadError}</p>
        </div>
      )}

      {/* Editor */}
      {sections && !isLoading && (
        <div className="max-w-2xl">
          {saveError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-400">{saveError}</p>
            </div>
          )}

          {/* Q2 / AD-2: when markers are absent the structured editor
              is otherwise read-only. Surface a banner with an "add
              markers" CTA above it so the user can opt-in without
              having to hand-edit the raw markdown file. */}
          {!sections.hasMarkers && (
            <div
              className="mb-4 rounded-lg border p-4 text-sm flex flex-col gap-2"
              style={{
                background: 'var(--warning-bg)',
                borderColor: 'var(--warning-border)',
                color: 'var(--warning-text)',
              }}
              data-testid="inject-markers-banner"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
                <div>
                  <div className="font-semibold mb-0.5">{t('agent.edit.inject.title')}</div>
                  <div className="text-xs opacity-90">{t('agent.edit.inject.description')}</div>
                </div>
              </div>
              {injectError && (
                <p className="text-xs text-red-400">{injectError}</p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleInjectMarkers()}
                  disabled={isInjectingMarkers}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                  data-testid="inject-markers-button"
                >
                  {isInjectingMarkers
                    ? t('agent.edit.inject.button.injecting')
                    : t('agent.edit.inject.button.add')}
                </button>
              </div>
            </div>
          )}

          <StructuredFieldEditor
            initial={{
              displayName: sections.displayName ?? '',
              description: sections.description ?? '',
              model: sections.model ?? 'default',
              themeColor: sections.themeColor ?? '',
              personality: sections.personality ?? '',
              toneSample: sections.toneSample ?? '',
              extraInstructions: sections.extraInstructions ?? '',
            }}
            hasMarkers={sections.hasMarkers}
            isSaving={isSaving}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
      )}
    </div>
  )
}
