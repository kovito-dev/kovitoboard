/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Common formatting utilities.
 * Display helpers shared across the session and agent views.
 */

/** Display settings for each status (dot color + label) */
export const STATUS_INDICATORS: Record<string, { dot: string; label: string }> = {
  active: { dot: 'bg-green-400', label: 'Active' },
  thinking: { dot: 'bg-blue-400 animate-pulse', label: 'Thinking' },
  waiting: { dot: 'bg-yellow-400', label: 'Waiting' },
  ready: { dot: 'bg-green-400', label: 'Ready' },
  idle: { dot: 'bg-gray-500', label: 'Idle' },
}

/** Convert a timestamp to a relative time string (e.g. "3m ago", "2h ago") */
export function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Format token count in compact form (1234 -> "1.2K", 1234567 -> "1.2M") */
export function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** Shorten a model name for display (e.g. "claude-opus-4-..." -> "Opus") */
export function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

/** Display name for a task assignee (nameMap can map ID -> display name) */
export function getAssigneeLabel(assignee: string | null, nameMap?: Record<string, string>): string {
  if (!assignee) return 'Unassigned'
  if (nameMap && nameMap[assignee]) return nameMap[assignee]
  return assignee
}

// --- Markdown conversion for clipboard copy ---

import type { ParsedEvent } from '../types'
import { wrapWithSentinel } from '../../shared/kb-authored-sentinel'

/** Convert a timestamp to HH:MM format */
function formatTimeShort(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Convert event type to a human-readable role label */
function roleLabel(type: ParsedEvent['type']): string {
  switch (type) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool_use': return 'Tool Use'
    case 'tool_result': return 'Tool Result'
    case 'system': return 'System'
    default: return type
  }
}

/** Convert a single event to a Markdown string */
export function eventToMarkdown(event: ParsedEvent, speakerName?: string): string {
  const time = formatTimeShort(event.timestamp)
  const name = speakerName || roleLabel(event.type)
  const header = `**${name}** (${time})`

  if (event.type === 'tool_use') {
    const toolName = event.content.toolName || 'unknown'
    const input = event.content.toolInput
      ? '\n```json\n' + JSON.stringify(event.content.toolInput, null, 2) + '\n```'
      : ''
    return `${header}\n\n🔧 **${toolName}**${input}`
  }

  if (event.type === 'tool_result') {
    const output = event.content.toolOutput || ''
    return `${header}\n\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``
  }

  if (event.type === 'system') {
    return `> _${event.content.text || ''}_`
  }

  return `${header}\n\n${event.content.text || ''}`
}

/** Join multiple events into a single Markdown string */
export function eventsToMarkdown(
  events: ParsedEvent[],
  getSpeakerName?: (event: ParsedEvent) => string
): string {
  return events
    .map((e) => eventToMarkdown(e, getSpeakerName?.(e)))
    .join('\n\n---\n\n')
}

/** Copy text to clipboard (returns true on success) */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// --- Session continuation message generation ---

/** Maximum character count (to conserve tokens) */
const CONTINUE_SESSION_MAX_CHARS = 8000

/**
 * Generate a continuation message from a session's conversation history.
 * Extracts only user/assistant messages, prioritizing the most recent exchanges.
 */
export function buildContinueSessionMessage(
  sessionId: string,
  events: ParsedEvent[],
): string {
  // Extract only user/assistant messages that have text
  const conversations = events.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && e.content.text?.trim()
  )

  // SS-3 / Q4 dual-write: the legacy `Please continue working from
  // the previous session (xxxxxxxx).` opening line stays intact for
  // older renderers / replayed JSONL while the whole body is
  // wrapped in a sentinel block carrying the short session id as
  // `label`. The sentinel-aware parser uses the label directly for
  // the chip header, bypassing the regex on the opening sentence.
  const shortId = sessionId.slice(0, 8)

  if (conversations.length === 0) {
    return wrapWithSentinel(
      'continue-session',
      `Please continue working from the previous session (${shortId}).`,
      { label: shortId },
    )
  }

  // Prioritize recent exchanges (trim older ones first)
  const parts: string[] = []
  let totalChars = 0

  // Add in reverse order (newest first), stopping when the character limit is reached
  for (let i = conversations.length - 1; i >= 0; i--) {
    const e = conversations[i]
    const role = e.type === 'user' ? 'User' : 'Assistant'
    const text = e.content.text!
    // Truncate individual messages to 500 characters
    const truncated = text.length > 500 ? text.slice(0, 500) + '...(truncated)' : text
    const part = `## ${role}\n${truncated}`

    if (totalChars + part.length > CONTINUE_SESSION_MAX_CHARS) break
    parts.unshift(part) // Prepend to maintain chronological order
    totalChars += part.length
  }

  const omitNote = parts.length < conversations.length
    ? `\n(Note: ${conversations.length - Math.floor(parts.length)} older exchange(s) omitted)\n`
    : ''

  const body = [
    `Please continue working from the previous session (${shortId}).`,
    '',
    '<previous-session>',
    omitNote,
    ...parts,
    '',
    '</previous-session>',
    '',
    'Based on the context above, please continue with the remaining work.',
  ].join('\n')

  return wrapWithSentinel('continue-session', body, { label: shortId })
}
