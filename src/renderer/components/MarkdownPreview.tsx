/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useMemo, type ReactNode, type AnchorHTMLAttributes } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { FILE_PATH_REGEX, hasPreviewableExtension } from '../utils/path'

/** Convert file paths in text nodes to clickable links */
function renderTextWithFileLinks(
  text: string,
  onFilePathClick?: (path: string) => void,
): ReactNode[] {
  if (!onFilePathClick) return [text]

  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset global regex
  const regex = new RegExp(FILE_PATH_REGEX.source, 'g')
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1] || match[0]
    const matchStart = match.index + (match[0].length - filePath.length)
    const matchEnd = matchStart + filePath.length

    if (!hasPreviewableExtension(filePath)) continue

    // Text before the match
    if (matchStart > lastIndex) {
      parts.push(text.slice(lastIndex, matchStart))
    }

    // Clickable file path link
    parts.push(
      <button
        key={`fp-${matchStart}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onFilePathClick(filePath)
        }}
        className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/40 hover:decoration-blue-300/60 cursor-pointer transition-colors"
        title={`Preview: ${filePath}`}
      >
        {filePath}
      </button>,
    )
    lastIndex = matchEnd
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

interface MarkdownPreviewProps {
  content: string
  /** compact: for chat (density-focused), document: for document viewing (readability-focused) */
  variant?: 'compact' | 'document'
  /** Whether to convert single newlines to <br> (default: false) */
  breaks?: boolean
  /** Callback when a file path is clicked */
  onFilePathClick?: (path: string) => void
}

export function MarkdownPreview({ content, variant = 'compact', breaks = false, onFilePathClick }: MarkdownPreviewProps) {
  const className = variant === 'document'
    ? 'markdown-body markdown-body--document text-sm leading-relaxed max-w-3xl'
    : 'markdown-body text-sm leading-relaxed'

  // Custom react-markdown components: open external links in a new
  // tab and (optionally) detect file paths in text nodes.
  //
  // The `a` override is unconditional — external links should always
  // open in a new tab regardless of whether file path detection is
  // wired up. Internal anchors (`#section`, relative paths, mailto:,
  // etc.) keep react-markdown's default behaviour.
  const components = useMemo(() => {
    const ExternalAwareLink = ({
      href,
      children,
      ...rest
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) => {
      const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href)
      if (isExternal) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {children}
          </a>
        )
      }
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      )
    }

    if (!onFilePathClick) {
      return { a: ExternalAwareLink }
    }
    return {
      a: ExternalAwareLink,
      // Render text inside <p> with file path detection
      p: ({ children }: { children?: ReactNode }) => {
        return <p>{processChildren(children, onFilePathClick)}</p>
      },
      // <li> tag
      li: ({ children }: { children?: ReactNode }) => {
        return <li>{processChildren(children, onFilePathClick)}</li>
      },
      // <td> tag
      td: ({ children }: { children?: ReactNode }) => {
        return <td>{processChildren(children, onFilePathClick)}</td>
      },
      // Make file paths in inline code clickable
      code: ({ children, className }: { children?: ReactNode; className?: string }) => {
        // Code blocks (with language class) are returned as-is
        if (className) return <code className={className}>{children}</code>
        // If inline code content is a file path, make it a link
        if (typeof children === 'string') {
          const parts = renderTextWithFileLinks(children, onFilePathClick)
          if (parts.length === 1 && typeof parts[0] === 'string') {
            return <code>{children}</code>
          }
          return <code>{parts}</code>
        }
        return <code>{children}</code>
      },
    }
  }, [onFilePathClick])

  return (
    <div className={className}>
      <Markdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
}

/** Apply file path detection to string nodes within children */
function processChildren(
  children: ReactNode,
  onFilePathClick: (path: string) => void,
): ReactNode {
  if (typeof children === 'string') {
    return renderTextWithFileLinks(children, onFilePathClick)
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        const parts = renderTextWithFileLinks(child, onFilePathClick)
        return parts.length === 1 && typeof parts[0] === 'string'
          ? parts[0]
          : <span key={i}>{parts}</span>
      }
      return child
    })
  }
  return children
}
