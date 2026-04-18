import { useState, useCallback, type ReactNode } from 'react'
import type { ParsedEvent, AgentConfig } from '../types'
import { AgentAvatar } from './AgentAvatar'
import { MarkdownPreview } from './MarkdownPreview'
import { ToolCallCard } from './ToolCallCard'
import { eventToMarkdown, copyToClipboard } from '../utils/format'
import { FILE_PATH_REGEX, hasPreviewableExtension } from '../utils/path'

/**
 * Restore escaped \n \t literals to actual newlines/tabs.
 * Applied only to user messages for display (not applied to assistant messages).
 */
function restoreEscapedNewlines(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

/**
 * Component that displays user messages while preserving line breaks.
 * Markdown rendering collapses consecutive newlines, so user messages
 * are displayed as-is using whitespace-pre-wrap.
 * File paths within the text are made clickable.
 */
function UserMessageText({ text, onFilePathClick }: { text: string; onFilePathClick?: (path: string) => void }) {
  const restored = restoreEscapedNewlines(text)

  if (!onFilePathClick) {
    return <span className="whitespace-pre-wrap">{restored}</span>
  }

  // Detect file paths and make them clickable
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const regex = new RegExp(FILE_PATH_REGEX.source, 'g')

  while ((match = regex.exec(restored)) !== null) {
    const filePath = match[1] || match[0]
    const matchStart = match.index + (match[0].length - filePath.length)
    const matchEnd = matchStart + filePath.length

    if (!hasPreviewableExtension(filePath)) continue

    if (matchStart > lastIndex) {
      parts.push(restored.slice(lastIndex, matchStart))
    }
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

  if (lastIndex < restored.length) {
    parts.push(restored.slice(lastIndex))
  }

  return <span className="whitespace-pre-wrap">{parts.length > 0 ? parts : restored}</span>
}

/** Message action bar (shown on hover, positioned below the message) */
function MessageActions({ onCopy }: { onCopy: () => void }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [onCopy])

  return (
    <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] hover:bg-[var(--accent)]/10 transition-colors"
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
        <span className="text-xs">{copied ? 'コピー済み' : 'コピー'}</span>
      </button>
    </div>
  )
}

interface MessageBubbleProps {
  event: ParsedEvent
  agentConfig: AgentConfig
  userConfig: AgentConfig
  /** Callback when a file path is clicked */
  onFilePathClick?: (path: string) => void
  /** UI theme */
  theme?: 'dark' | 'light'
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Small copy button (for tool_use / tool_result, shown on hover) */
function SmallCopyButton({ onClick, size = 12 }: { onClick: () => void; size?: number }) {
  const [copied, setCopied] = useState(false)

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onClick()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [onClick])

  return (
    <button
      onClick={handleClick}
      className="text-[var(--text-dim)] hover:text-[var(--accent-text-vivid)] transition-colors opacity-0 group-hover:opacity-100"
      title="Copy"
    >
      {copied ? (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

export function MessageBubble({ event, agentConfig, userConfig, onFilePathClick, theme = 'dark' }: MessageBubbleProps) {
  const getSpeakerName = () => {
    if (event.type === 'user') return userConfig.name
    if (event.type === 'assistant') return agentConfig.name
    return undefined
  }

  const handleCopy = useCallback(() => {
    const md = eventToMarkdown(event, getSpeakerName())
    copyToClipboard(md)
  }, [event, agentConfig.name, userConfig.name])

  if (event.type === 'tool_use') {
    return (
      <div className="group relative">
        <div className="absolute right-1 top-1 z-10">
          <SmallCopyButton onClick={handleCopy} />
        </div>
        <ToolCallCard content={event.content} />
      </div>
    )
  }

  if (event.type === 'tool_result') {
    if (!event.content.toolOutput) return null
    return (
      <div className="group relative my-1 px-3 py-2 rounded-lg bg-[var(--bg-base)] border border-[var(--border)] text-xs text-[var(--text-muted)] max-h-40 overflow-y-auto">
        <div className="absolute right-1 top-1 z-10">
          <SmallCopyButton onClick={handleCopy} />
        </div>
        <pre className="whitespace-pre-wrap font-mono">{event.content.toolOutput.slice(0, 2000)}</pre>
      </div>
    )
  }

  if (event.type === 'system') {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-[var(--text-dim)] bg-[var(--bg-elevated)] px-3 py-1 rounded-full">
          {event.content.text}
        </span>
      </div>
    )
  }

  if (event.type === 'progress') return null

  const isUser = event.type === 'user'
  const config = isUser ? userConfig : agentConfig

  return (
    <div className={`group flex gap-2 md:gap-3 my-2 md:my-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className="shrink-0 hidden sm:block">
        <AgentAvatar name={config.name} color={config.color} avatar={config.avatar} theme={theme} />
      </div>
      <div className={`flex flex-col max-w-[92%] sm:max-w-[80%] md:max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium" style={{ color: config.color }}>
            {config.name}
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">{formatTime(event.timestamp)}</span>
        </div>
        <div
          className={`rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'bg-[var(--accent-bg)] border border-[var(--accent-border-subtle)] text-[var(--text-primary)]'
              : 'bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-secondary)]'
          }`}
          style={!isUser ? { borderLeftColor: config.color, borderLeftWidth: 3 } : undefined}
        >
          {event.content.text && (
            isUser
              ? <UserMessageText text={event.content.text} onFilePathClick={onFilePathClick} />
              : <MarkdownPreview content={event.content.text} onFilePathClick={onFilePathClick} />
          )}
        </div>
        {/* Action bar (below message, shown on hover) */}
        <MessageActions onCopy={handleCopy} />
      </div>
    </div>
  )
}
