import { useState, useEffect } from 'react'

/**
 * Example extension page.
 *
 * - Must use `export default` (required by React.lazy)
 * - Use CSS variables (e.g., var(--text-primary)) for theme compatibility
 * - Tailwind CSS classes are available
 */
export default function ExamplePage() {
  const [apiData, setApiData] = useState<{ message: string; timestamp: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ext/example')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(setApiData)
      .catch((err) => setError(err.message))
  }, [])

  return (
    <div className="flex-1 p-6">
      <h1 className="text-xl font-bold text-[var(--text-primary)] mb-4">
        サンプルページ
      </h1>
      <p className="text-[var(--text-secondary)] mb-6">
        このページは <code className="text-[var(--accent-text)]">app/</code> ディレクトリの拡張例です。
        <code className="text-[var(--accent-text)]">src/</code> を変更せずにカスタムページを追加できます。
      </p>

      <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
          API レスポンス (/api/ext/example)
        </h2>
        {error && (
          <p className="text-red-400 text-sm">Error: {error}</p>
        )}
        {apiData && (
          <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">
            {JSON.stringify(apiData, null, 2)}
          </pre>
        )}
        {!apiData && !error && (
          <p className="text-[var(--text-dim)] text-sm">読み込み中...</p>
        )}
      </div>
    </div>
  )
}
