/**
 * テンプレート一覧を取得する React Hook
 */

import { useState, useEffect, useCallback } from 'react'

/** テンプレートサマリー（サーバー側 AgentTemplateSummary と同一構造） */
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
      setError(err instanceof Error ? err.message : 'テンプレートの取得に失敗しました')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTemplates()
  }, [fetchTemplates])

  return { templates, isLoading, error, reload: fetchTemplates }
}
