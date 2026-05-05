/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState } from 'react'
import type { MessageContent } from '../types'

interface ToolCallCardProps {
  content: MessageContent
}

const TOOL_ICONS: Record<string, string> = {
  Write: '\u{1F4DD}',
  Edit: '\u{1F4DD}',
  Read: '\u{1F4D6}',
  Bash: '\u{1F4BB}',
  Glob: '\u{1F50D}',
  Grep: '\u{1F50D}',
  WebSearch: '\u{1F310}',
  WebFetch: '\u{1F310}',
  Agent: '\u{1F916}',
  ToolSearch: '\u{1F50D}'
}

export function ToolCallCard({ content }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[content.toolName || ''] || '\u{1F527}'
  const displayPath = content.filePath?.replace(/^\/home\/[^/]+\//, '~/')

  return (
    <div className="my-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-mono text-blue-300">{content.toolName}</span>
        {displayPath && <span className="text-xs text-[var(--text-dim)] truncate">{displayPath}</span>}
        <span className={`ml-auto text-xs text-[var(--text-dim)] transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>

      {expanded && content.toolInput && (
        <div className="px-3 pb-2 border-t border-[var(--border)]">
          <pre className="text-xs text-[var(--text-muted)] overflow-x-auto mt-2 max-h-60 overflow-y-auto">
            {JSON.stringify(content.toolInput, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
