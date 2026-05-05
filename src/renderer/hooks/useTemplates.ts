/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * React hook to fetch the list of templates
 */

import { useState, useEffect, useCallback } from 'react'

/** Template summary (same structure as server-side AgentTemplateSummary) */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  model: string
}

interface UseTemplatesResult {
  templates: TemplateSummary[]
  isLoading: boolean
  error: string | null
  reload: () => void
}

export function useTemplates(): UseTemplatesResult {
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/templates/agents')
      if (!res.ok) {
        throw new Error(`Failed to fetch templates (${res.status})`)
      }
      const data = (await res.json()) as TemplateSummary[]
      setTemplates(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch templates')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTemplates()
  }, [fetchTemplates])

  return { templates, isLoading, error, reload: fetchTemplates }
}
