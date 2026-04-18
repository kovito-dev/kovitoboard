/**
 * Agent attribute editing page
 *
 * Editing UI for structured fields (display name, personality, tone sample, extra instructions).
 * Fetches current values via GET /api/agents/:id/sections
 * and persists changes via PUT /api/agents/:id.
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { StructuredFieldEditor, type SectionData } from '../components/StructuredFieldEditor'

/** Response type for GET /api/agents/:id/sections */
interface SectionsResponse {
  hasMarkers: boolean
  displayName?: string
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

  // Fetch current values of structured fields
  useEffect(() => {
    if (!id) return

    setIsLoading(true)
    setLoadError(null)

    fetch(`/api/agents/${id}/sections`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        return res.json() as Promise<SectionsResponse>
      })
      .then(setSections)
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to fetch section data')
      })
      .finally(() => setIsLoading(false))
  }, [id])

  // Save
  const handleSave = useCallback(async (data: SectionData) => {
    if (!id) return

    setIsSaving(true)
    setSaveError(null)

    try {
      // Build the request body for changed fields
      const body: Record<string, unknown> = {}

      // Always send displayName (empty string means removal from frontmatter)
      body.displayName = data.displayName

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
          エージェント詳細に戻る
        </button>
        <h2 className="text-lg font-semibold text-[var(--text-secondary)]">
          エージェントを編集
        </h2>
        <p className="text-sm text-[var(--text-dim)] mt-1">
          <code className="text-xs bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">{id}</code> の属性を編集します
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm text-[var(--text-dim)]">読み込み中...</div>
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

          <StructuredFieldEditor
            initial={{
              displayName: sections.displayName ?? '',
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
