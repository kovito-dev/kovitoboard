/**
 * Recipe export — scan app/ directory and export as recipe.
 */
import { useState, useEffect, useCallback } from 'react'
import type { AppScanResult, RecipeMetadata } from '../../shared/recipe-types'

type ExportState = 'scanning' | 'ready' | 'exporting' | 'done' | 'error'

export function RecipeExport() {
  const [state, setState] = useState<ExportState>('scanning')
  const [scan, setScan] = useState<AppScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Form fields
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [author, setAuthor] = useState('')
  const [format, setFormat] = useState<'directory' | 'markdown'>('directory')
  const [outputPath, setOutputPath] = useState('')
  const [resultPath, setResultPath] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/recipes/app-scan')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: AppScanResult) => {
        setScan(data)
        setState('ready')
      })
      .catch((err) => {
        setError(err.message)
        setState('error')
      })
  }, [])

  const handleExport = useCallback(async () => {
    if (!name.trim() || !description.trim() || !outputPath.trim()) return
    setState('exporting')
    setError(null)

    const metadata: RecipeMetadata = {
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
        body: JSON.stringify({ metadata, format, outputPath: outputPath.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Export failed')
      }
      setResultPath(data.outputPath)
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
      setState('error')
    }
  }, [name, description, version, author, format, outputPath])

  if (state === 'scanning') {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-[var(--text-dim)] text-sm">app/ をスキャン中...</div>
      </div>
    )
  }

  if (state === 'error' && !scan) {
    return (
      <div className="space-y-3">
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {error}
        </div>
      </div>
    )
  }

  if (scan && scan.artifacts.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-[var(--text-dim)] text-sm">
          app/ ディレクトリにエクスポート可能なファイルがありません。
        </p>
        <p className="text-[var(--text-dim)] text-xs mt-1">
          app/ にページやスタイルを追加してからエクスポートしてください。
        </p>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="space-y-3">
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
          <h3 className="text-sm font-bold text-green-400 mb-1">
            エクスポート完了
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">
            出力先: {resultPath}
          </p>
        </div>
        <button
          onClick={() => {
            setState('ready')
            setResultPath(null)
          }}
          className="px-4 py-2 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:bg-[var(--bg-elevated)] transition-colors"
        >
          再度エクスポート
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Scan result */}
      {scan && (
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-3">
          <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
            app/ の内容
          </h4>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {scan.artifacts.map((a) => (
              <div key={a.path} className="flex items-center justify-between text-xs">
                <span className="font-mono text-[var(--text-secondary)]">{a.path}</span>
                <span className="text-[var(--text-dim)]">
                  {a.type} / {(a.sizeBytes / 1024).toFixed(1)} KB
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-[var(--text-dim)]">
            合計: {scan.artifacts.length} ファイル / {(scan.totalSize / 1024).toFixed(1)} KB
            {scan.menu.length > 0 && ` / ${scan.menu.length} メニュー`}
          </div>
        </div>
      )}

      {/* Metadata form */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1">
            レシピ名 <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Dashboard"
            className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1">
            説明 <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ダッシュボードページを追加するレシピ"
            className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-[var(--text-secondary)] mb-1">バージョン</label>
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-[var(--text-secondary)] mb-1">作成者</label>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="your-name"
              className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
            />
          </div>
        </div>

        {/* Format selection */}
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1">出力形式</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] cursor-pointer">
              <input
                type="radio"
                checked={format === 'directory'}
                onChange={() => setFormat('directory')}
                className="accent-[var(--accent-text)]"
              />
              ディレクトリ
            </label>
            <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] cursor-pointer">
              <input
                type="radio"
                checked={format === 'markdown'}
                onChange={() => setFormat('markdown')}
                className="accent-[var(--accent-text)]"
              />
              Markdown (.md)
            </label>
          </div>
        </div>

        {/* Output path */}
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1">
            出力先パス <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
            placeholder={format === 'directory' ? '/path/to/output-dir/' : '/path/to/recipe.md'}
            className="w-full px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
          />
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          onClick={handleExport}
          disabled={!name.trim() || !description.trim() || !outputPath.trim() || state === 'exporting'}
          className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
        >
          {state === 'exporting' ? 'エクスポート中...' : 'エクスポート'}
        </button>
      </div>
    </div>
  )
}
