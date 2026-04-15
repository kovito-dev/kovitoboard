/**
 * Recipe import flow — source input → parse → inspect → code review → apply.
 */
import { useState, useCallback } from 'react'
import { RecipeCodeViewer } from './RecipeCodeViewer'
import type {
  ParsedRecipe,
  InspectionResult,
  InspectionVerdict,
} from '../../shared/recipe-types'

type ImportState = 'idle' | 'parsing' | 'inspected' | 'applying' | 'applied' | 'error'

const VERDICT_STYLES: Record<InspectionVerdict, { bg: string; text: string; label: string }> = {
  blocked: { bg: 'bg-red-500/20', text: 'text-red-400', label: 'ブロック' },
  warning: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: '警告' },
  caution: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: '注意' },
  safe: { bg: 'bg-green-500/20', text: 'text-green-400', label: '安全' },
}

export function RecipeImport() {
  const [source, setSource] = useState('')
  const [state, setState] = useState<ImportState>('idle')
  const [recipe, setRecipe] = useState<ParsedRecipe | null>(null)
  const [inspection, setInspection] = useState<InspectionResult | null>(null)
  const [codeReviewed, setCodeReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [appliedId, setAppliedId] = useState<string | null>(null)

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
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">
              レシピのパス
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                placeholder="/path/to/recipe/ or /path/to/recipe.md"
                className="flex-1 px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
              />
              <button
                onClick={handleParse}
                disabled={!source.trim()}
                className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
              >
                解析
              </button>
            </div>
          </div>
          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}
          <p className="text-xs text-[var(--text-dim)]">
            ローカルのレシピディレクトリまたは .md ファイルのパスを入力してください。
          </p>
        </div>
      )}

      {/* Parsing */}
      {state === 'parsing' && (
        <div className="flex items-center justify-center py-8">
          <div className="text-[var(--text-dim)] text-sm">レシピを解析中...</div>
        </div>
      )}

      {/* Inspection result */}
      {(state === 'inspected' || state === 'applying') && recipe && inspection && (
        <div className="space-y-4">
          {/* Metadata */}
          <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[var(--text-primary)]">
                {recipe.metadata.name} v{recipe.metadata.version}
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
              {recipe.metadata.description}
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
                検査結果 ({inspection.findings.length} 件)
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
              成果物コード
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
                メニュー追加
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
              キャンセル
            </button>
            {inspection.verdict !== 'blocked' && (
              <button
                onClick={handleApply}
                disabled={!canApply || state === 'applying'}
                className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
              >
                {state === 'applying' ? '適用中...' : '適用'}
              </button>
            )}
            {inspection.verdict === 'warning' && !codeReviewed && (
              <span className="text-xs text-orange-400">
                ※ 全コードを確認後に適用可能になります
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
              レシピを適用しました
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              ID: {appliedId} — エージェントがファイルを作成しています。
              セッション画面で進捗を確認できます。
            </p>
          </div>
          <button
            onClick={handleReset}
            className="px-4 py-2 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:bg-[var(--bg-elevated)] transition-colors"
          >
            別のレシピを読み込む
          </button>
        </div>
      )}
    </div>
  )
}
