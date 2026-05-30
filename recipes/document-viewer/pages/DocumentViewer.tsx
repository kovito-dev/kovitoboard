/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Document Viewer — lists and displays Markdown and HTML files in the project.
 *
 * Customization hint: change EXTENSIONS to add more file types.
 * e.g. ['.md', '.ts'] to also show TypeScript files.
 *
 * Security note: HTML files are rendered inside a sandboxed
 * `<iframe sandbox srcdoc>` — a separate, opaque-origin browsing
 * context. Bundled sample recipes run as `code-trusted (bundled)`,
 * but the *content* they read (arbitrary project HTML) is untrusted.
 * Rendering it in the host realm would let an inline `style` such as
 * `position:fixed;width:100vw;height:100vh` paint a full-screen
 * overlay over the host chrome / trust-prompt UI (a viewport hijack
 * that needs no script). The sandbox iframe is the PRIMARY defense:
 * with neither `allow-same-origin` nor `allow-scripts`, the frame
 * gets an opaque origin (no access to the host DOM / `window.kb`) and
 * runs no JS, so viewport-affecting styles are structurally confined
 * to the iframe's own box. DOMPurify is kept as DEFENSE-IN-DEPTH (a
 * secondary layer that degrades gracefully if a sandbox flag is ever
 * misconfigured) — it is NOT the thing that stops the viewport
 * hijack. See docs security-threat-model S10 / §7.10.
 */
import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import DOMPurify from 'dompurify'
import '../styles/highlight-atom-one-dark.css'
import '../styles/document-viewer.css'

// ★ Customization point: add extensions here (e.g. '.ts', '.json')
const EXTENSIONS = ['.md', '.html', '.htm']

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

// --- File-tree model ----------------------------------------------------

type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; file: FileEntry; fileIndex: number }

/**
 * Build a hierarchical tree from a flat list of file entries.
 *
 * Splits each `file.path` on `/`, creating intermediate directory
 * nodes as needed. Directories are sorted before files, then both
 * alphabetically. Each file node carries a stable `fileIndex` (its
 * position in the sorted flat list) so existing
 * `data-testid="docviewer-file-${index}"` selectors keep working.
 *
 * Paths are split on both `/` and `\` so the tree nests correctly
 * regardless of separator: the backend's `list-files` handler derives
 * entry paths with `path.relative()`, which yields `\`-separated paths
 * on Windows. The original `file.path` is preserved on the leaf node so
 * the `read-doc` round-trip back to the backend still uses the exact
 * path the backend reported.
 *
 * Pure: depends only on its input.
 */
export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = []

  files.forEach((file, fileIndex) => {
    const segments = file.path.split(/[/\\]/).filter(Boolean)
    let level = root
    let prefix = ''

    segments.forEach((segment, i) => {
      prefix = prefix ? `${prefix}/${segment}` : segment
      const isLeaf = i === segments.length - 1

      if (isLeaf) {
        level.push({ kind: 'file', name: segment, path: file.path, file, fileIndex })
        return
      }

      let dir = level.find(
        (n): n is Extract<TreeNode, { kind: 'dir' }> => n.kind === 'dir' && n.name === segment,
      )
      if (!dir) {
        dir = { kind: 'dir', name: segment, path: prefix, children: [] }
        level.push(dir)
      }
      level = dir.children
    })
  })

  sortTree(root)
  return root
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.kind === 'dir') sortTree(node.children)
  }
}

// --- Icons (inline SVG, no external deps) -------------------------------

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {open ? (
        <path
          d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1.2 1.2h5.8a1 1 0 0 1 1 1v.5H3.2a1 1 0 0 0-.96.73L1.5 9.8V4.5Z"
          fill="#d8a657"
        />
      ) : (
        <path
          d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1.2 1.2h5.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.2Z"
          fill="#d8a657"
        />
      )}
    </svg>
  )
}

function FileIcon({ kind }: { kind: 'md' | 'html' | 'other' }) {
  const color = kind === 'html' ? '#e2725b' : kind === 'md' ? '#519aba' : 'currentColor'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M3.5 1.5h6L13 5v9a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5Z"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M3.5 1.5h6L13 5v9a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.5"
      />
      <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1" opacity="0.5" fill="none" />
      <text x="8" y="12" fontSize="4.5" fontWeight="700" textAnchor="middle" fill={color}>
        {kind === 'html' ? 'H' : kind === 'md' ? 'M' : '·'}
      </text>
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}
    >
      <path d="M3.5 2.5L6.5 5L3.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// --- Helpers ------------------------------------------------------------

export function classifyFile(name: string): 'md' | 'html' | 'other' {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md')) return 'md'
  return 'other'
}

/**
 * True when `path` should render in the sandboxed HTML iframe rather
 * than the host-realm Markdown path. This predicate is the render-time
 * dispatch invariant: `.html` / `.htm` → isolated iframe, everything
 * else (including `.md`) → ReactMarkdown in the host realm.
 */
export function isHtmlPath(path: string): boolean {
  return classifyFile(path) === 'html'
}

export default function DocumentViewer() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [isListLoading, setIsListLoading] = useState(false)
  const [isReadLoading, setIsReadLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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
      // Expand all directories by default so files are visible at a glance.
      setExpanded(collectDirPaths(buildTree(filtered)))
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

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Render relative-path links as plain text (no navigation). Only
  // absolute URLs (http/https/mailto/tel) and same-page anchors (#)
  // get a real <a> tag, opened in a new tab.
  const mdComponents = {
    a({ href, children }: { href?: string; children?: ReactNode }) {
      const isRelative = !href || !/^(https?:\/\/|mailto:|tel:|#)/.test(href)
      if (isRelative) {
        return <span>{children}</span>
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    },
  }

  // `buildTree` is pure over `files`; memoize so the tree is built once
  // per file-list change instead of on every render.
  const tree = useMemo(() => buildTree(files), [files])

  // Sanitize the HTML body (the iframe's defense-in-depth secondary
  // layer) once per content change, so unrelated re-renders — tree
  // expand/collapse, loading/error toggles — don't re-run DOMPurify on
  // a potentially large document.
  const sanitizedHtml = useMemo(
    () => (content !== null && selectedPath && isHtmlPath(selectedPath) ? DOMPurify.sanitize(content) : null),
    [content, selectedPath],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="docviewer">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold text-[var(--text-primary)]">
            Document Viewer
          </h1>
          <p className="text-xs text-[var(--text-dim)] mt-0.5">
            A viewer for Markdown and HTML files. To add or change features, ask the agent from the side panel on the right.
          </p>
        </div>
        <button
          onClick={fetchList}
          disabled={isListLoading}
          data-testid="docviewer-reload"
          className="px-3 py-1.5 text-xs border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-colors"
        >
          {isListLoading ? 'Loading...' : 'Reload'}
        </button>
      </div>

      {/*
       * Main content: 2-pane layout.
       *
       * Inline styles (instead of Tailwind utility classes) are used
       * for the flex containers below because the Tailwind JIT scan
       * configured in KovitoBoard does not always include classes
       * referenced from `app/`-side recipe pages — those files live
       * outside the renderer source tree. Inline styles guarantee the
       * layout works regardless of which utility classes happen to be
       * picked up by the scan.
       *
       * The previous `flex-col md:flex-row` shape also collapsed the
       * right pane height to 0 when the left pane (with `shrink-0`)
       * consumed the full vertical space; the always-horizontal flex
       * here avoids that failure mode.
       *
       * The `dv-scroll` class on both panes adds an always-visible
       * custom scrollbar (see document-viewer.css) so hidden content
       * is discoverable on platforms with overlay scrollbars.
       */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* Left pane: file tree */}
        <div
          className="dv-scroll"
          style={{ width: '240px', flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--border)' }}
        >
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

          <div style={{ padding: '0.25rem 0' }}>
            {tree.map((node) => (
              <TreeNodeRow
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={toggleDir}
                onSelect={fetchContent}
              />
            ))}
          </div>
        </div>

        {/* Right pane: content */}
        <div
          className="dv-scroll"
          style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '1rem' }}
          data-testid="docviewer-content"
        >
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

          {content !== null && !isReadLoading && !readError && selectedPath && (
            isHtmlPath(selectedPath) ? (
              // Untrusted HTML is isolated in a sandboxed, opaque-origin
              // iframe (primary defense). `sandbox=""` enables every
              // restriction: no `allow-same-origin` (opaque origin → no
              // host DOM / window.kb access) and no `allow-scripts` (no
              // JS runs in the frame). A `position:fixed` overlay in the
              // content therefore stays inside the iframe's box and can
              // never cover the host viewport. DOMPurify still runs as a
              // secondary (defense-in-depth) layer. The frame has no
              // script to self-measure its height, so the host fixes the
              // size and the parent pane scrolls (security-threat-model
              // §7.10.4 invariant (c)).
              <iframe
                sandbox=""
                srcDoc={sanitizedHtml ?? ''}
                className="dv-html-frame"
                title="Document preview"
                data-testid="docviewer-html"
              />
            ) : (
              <div className="dv-prose">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {content}
                </ReactMarkdown>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function collectDirPaths(nodes: TreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      acc.add(node.path)
      collectDirPaths(node.children, acc)
    }
  }
  return acc
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const indent = 8 + depth * 14

  if (node.kind === 'dir') {
    const isOpen = expanded.has(node.path)
    return (
      <div>
        <button
          onClick={() => onToggle(node.path)}
          className="w-full text-left hover:bg-[var(--bg-hover)] transition-colors"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 8px',
            paddingLeft: `${indent}px`,
            color: 'var(--text-secondary)',
          }}
          aria-expanded={isOpen}
        >
          <ChevronIcon open={isOpen} />
          <FolderIcon open={isOpen} />
          <span className="text-sm truncate" title={node.path}>
            {node.name}
          </span>
        </button>
        {isOpen &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
      </div>
    )
  }

  const fileKind = classifyFile(node.name)
  const isSelected = selectedPath === node.path
  const meta = `${formatSize(node.file.size)} · ${formatDate(node.file.modifiedAt)}`
  return (
    <button
      onClick={() => onSelect(node.path)}
      data-testid={`docviewer-file-${node.fileIndex}`}
      className={`w-full text-left hover:bg-[var(--bg-hover)] transition-colors ${
        isSelected ? 'bg-[var(--bg-elevated)]' : ''
      }`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        paddingLeft: `${indent + 16}px`,
        color: 'var(--text-primary)',
      }}
      title={`${node.path}\n${meta}`}
    >
      <FileIcon kind={fileKind} />
      <span className="text-sm truncate">{node.name}</span>
    </button>
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
