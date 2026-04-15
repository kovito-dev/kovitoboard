/**
 * Recipe history — display list of applied recipes.
 */
import { useState, useEffect } from 'react'
import type { RecipeHistoryEntry } from '../../shared/recipe-types'

export function RecipeHistory() {
  const [history, setHistory] = useState<RecipeHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/recipes/history')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        setHistory(data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-[var(--text-dim)] text-sm">履歴を読み込み中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
        履歴の読み込みに失敗しました: {error}
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-[var(--text-dim)] text-sm">
          まだレシピを適用していません。
        </p>
        <p className="text-[var(--text-dim)] text-xs mt-1">
          「読み込み」タブからレシピを適用すると、ここに履歴が表示されます。
        </p>
      </div>
    )
  }

  // Show most recent first
  const sorted = [...history].reverse()

  return (
    <div className="space-y-3">
      {sorted.map((entry) => (
        <div
          key={entry.id}
          className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4"
        >
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {entry.name} <span className="text-[var(--text-dim)] font-normal">v{entry.version}</span>
            </h3>
            <span className="text-xs text-[var(--text-dim)]">
              {new Date(entry.appliedAt).toLocaleString('ja-JP')}
            </span>
          </div>
          {entry.author && (
            <p className="text-xs text-[var(--text-dim)] mb-1">Author: {entry.author}</p>
          )}
          <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
            <span>{entry.artifacts.length} ファイル</span>
            {entry.menu.length > 0 && <span>{entry.menu.length} メニュー</span>}
            <span className="text-[var(--text-dim)]">ID: {entry.id}</span>
          </div>
          <p className="text-xs text-[var(--text-dim)] mt-1 truncate">
            Source: {entry.source}
          </p>
        </div>
      ))}
    </div>
  )
}
