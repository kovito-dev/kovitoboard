/**
 * Document Viewer — lists and displays Markdown files in the project.
 *
 * Customization hint: change EXTENSIONS to add more file types.
 * e.g. ['.md', '.ts'] to also show TypeScript files.
 */
import { useState, useEffect, useCallback } from 'react'

// ★ Customization point: add extensions here (e.g. '.ts', '.json')
const EXTENSIONS = ['.md']

type FileEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: string
}

type HandlerResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

declare global {
  interface Window {
    kb: {
      call: <T = unknown>(callId: string, input?: Record<string, unknown>) => Promise<HandlerResponse<T>>
    }
  }
}

export default function DocumentViewer() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [isListLoading, setIsListLoading] = useState(false)
  const [isReadLoading, setIsReadLoading] = useState(false)

  const fetchList = useCallback(async () => {
    setIsListLoading(true)
    setListError(null)
    try {
      const res = await window.kb.call<{ entries: FileEntry[] }>('list-docs')
      if (!res.ok) {
        setListError(res.error.message)
        setIsListLoading(false)
        return
      }
      const filtered = res.data.entries
        .filter((e) => !e.isDirectory)
        .filter((e) => EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
        .sort((a, b) => a.path.localeCompare(b.path))
      setFiles(filtered)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to list files')
    } finally {
      setIsListLoading(false)
    }
  }, [])

  const fetchContent = useCallback(async (path: string) => {
    setIsReadLoading(true)
    setReadError(null)
    setSelectedPath(path)
    try {
      const res = await window.kb.call<{ content: string; size: number }>('read-doc', { path })
      if (!res.ok) {
        setReadError(res.error.message)
        setContent(null)
        setIsReadLoading(false)
        return
      }
      setContent(res.data.content)
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'Failed to read file')
      setContent(null)
    } finally {
      setIsReadLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  return (
    <div className="flex flex-col h-full" data-testid="docviewer">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h1 className="text-lg font-bold text-[var(--text-primary)]">
          Document Viewer
        </h1>
        <button
          onClick={fetchList}
          disabled={isListLoading}
          data-testid="docviewer-reload"
          className="px-3 py-1.5 text-xs border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-colors"
        >
          {isListLoading ? 'Loading...' : 'Reload'}
        </button>
      </div>

      {/* Main content: 2-pane layout */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left pane: file list */}
        <div className="w-full md:w-72 shrink-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-y-auto">
          {listError && (
            <div className="p-3">
              <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                Failed to load file list: {listError}
              </div>
              <button
                onClick={fetchList}
                className="mt-2 px-3 py-1 text-xs border border-[var(--border)] text-[var(--text-secondary)] rounded hover:bg-[var(--bg-elevated)] transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!listError && files.length === 0 && !isListLoading && (
            <div className="p-4 text-sm text-[var(--text-dim)]">
              No {EXTENSIONS.join(', ')} files found
            </div>
          )}

          {isListLoading && files.length === 0 && (
            <div className="p-4 text-sm text-[var(--text-dim)]">Loading...</div>
          )}

          <div className="divide-y divide-[var(--border)]">
            {files.map((file, index) => (
              <button
                key={file.path}
                onClick={() => fetchContent(file.path)}
                data-testid={`docviewer-file-${index}`}
                className={`w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors ${
                  selectedPath === file.path ? 'bg-[var(--bg-elevated)]' : ''
                }`}
              >
                <div
                  className="text-sm text-[var(--text-primary)] truncate"
                  title={file.path}
                >
                  {file.path}
                </div>
                <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
                  {formatSize(file.size)} · {formatDate(file.modifiedAt)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right pane: content */}
        <div className="flex-1 overflow-y-auto p-4" data-testid="docviewer-content">
          {isReadLoading && (
            <div className="text-sm text-[var(--text-dim)]">Loading...</div>
          )}

          {readError && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              Failed to read file: {readError}
            </div>
          )}

          {!selectedPath && !isReadLoading && !readError && (
            <div className="text-sm text-[var(--text-dim)]">
              Select a file from the left panel to view
            </div>
          )}

          {content !== null && !isReadLoading && !readError && (
            <div className="max-w-3xl mx-auto">
              <pre className="whitespace-pre-wrap text-sm text-[var(--text-primary)] leading-relaxed font-mono">
                {content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
