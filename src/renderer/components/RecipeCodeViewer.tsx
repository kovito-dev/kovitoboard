/**
 * Recipe code viewer — displays artifact code with syntax highlighting
 * and security finding annotations.
 */
import { useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { ArtifactWithContent, Finding } from '../../shared/recipe-types'

interface RecipeCodeViewerProps {
  artifacts: ArtifactWithContent[]
  findings: Finding[]
  /** When true, user must expand and view all files before proceeding */
  requireReview?: boolean
  onReviewComplete?: () => void
}

const SEVERITY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-500/20', text: 'text-red-400', label: 'Critical' },
  high: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'High' },
  medium: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: 'Medium' },
  info: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Info' },
}

export function RecipeCodeViewer({
  artifacts,
  findings,
  requireReview,
  onReviewComplete,
}: RecipeCodeViewerProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set())

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        // Mark as reviewed when expanded
        if (requireReview) {
          setReviewedFiles((prevReviewed) => {
            const nextReviewed = new Set(prevReviewed)
            nextReviewed.add(path)
            // Check if all files are reviewed
            if (nextReviewed.size === artifacts.length && onReviewComplete) {
              setTimeout(onReviewComplete, 0)
            }
            return nextReviewed
          })
        }
      }
      return next
    })
  }

  const expandAll = () => {
    const allPaths = new Set(artifacts.map((a) => a.path))
    setExpandedFiles(allPaths)
    if (requireReview) {
      setReviewedFiles(allPaths)
      if (onReviewComplete) setTimeout(onReviewComplete, 0)
    }
  }

  const getFileFindings = (path: string) => findings.filter((f) => f.file === path)
  const getLangId = (path: string) => {
    if (path.endsWith('.tsx')) return 'tsx'
    if (path.endsWith('.ts')) return 'typescript'
    if (path.endsWith('.css')) return 'css'
    if (path.endsWith('.json')) return 'json'
    return ''
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-dim)]">
          {artifacts.length} file(s)
          {requireReview && ` — ${reviewedFiles.size}/${artifacts.length} reviewed`}
        </span>
        <button
          onClick={expandAll}
          className="text-xs text-[var(--accent-text)] hover:underline"
        >
          すべて展開
        </button>
      </div>

      {artifacts.map((artifact) => {
        const isExpanded = expandedFiles.has(artifact.path)
        const fileFindings = getFileFindings(artifact.path)
        const lineCount = artifact.content.split('\n').length
        const lang = getLangId(artifact.path)

        return (
          <div
            key={artifact.path}
            className="border border-[var(--border)] rounded-lg overflow-hidden"
          >
            {/* File header */}
            <button
              onClick={() => toggleFile(artifact.path)}
              className="w-full flex items-center justify-between px-3 py-2 bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-dim)]">
                  {isExpanded ? '▼' : '▶'}
                </span>
                <span className="text-sm font-mono text-[var(--text-primary)]">
                  {artifact.path}
                </span>
                <span className="text-xs text-[var(--text-dim)]">
                  ({lineCount} lines)
                </span>
              </div>
              {fileFindings.length > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
                  {fileFindings.length} finding(s)
                </span>
              )}
            </button>

            {/* Findings */}
            {isExpanded && fileFindings.length > 0 && (
              <div className="border-t border-[var(--border)] px-3 py-2 space-y-1">
                {fileFindings.map((finding, i) => {
                  const colors = SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.info
                  return (
                    <div key={i} className={`flex items-start gap-2 px-2 py-1 rounded ${colors.bg}`}>
                      <span className={`text-xs font-bold shrink-0 ${colors.text}`}>
                        {colors.label}
                      </span>
                      <span className="text-xs text-[var(--text-secondary)]">
                        {finding.line && `L${finding.line}: `}
                        {finding.description}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Code content */}
            {isExpanded && (
              <div className="border-t border-[var(--border)] overflow-x-auto text-sm">
                <Markdown rehypePlugins={[rehypeHighlight]}>
                  {'```' + lang + '\n' + artifact.content + '\n```'}
                </Markdown>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
