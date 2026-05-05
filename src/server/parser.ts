/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { RawEvent, RawContentBlock, ParsedEvent, MessageContent, EventMetadata } from './types'

let eventCounter = 0

function nextId(): string {
  return `evt_${++eventCounter}`
}

/**
 * Detect Claude Code's "[Request interrupted ...]" sentinel that follows
 * a tool rejection or an `Esc` press during a running tool call. The
 * exact wording is fixed by Claude Code (English, 2.1.x family); we
 * match on a lenient regex so future minor wording shifts still trip
 * the flag.
 */
const REQUEST_INTERRUPTED_RE = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/

/**
 * Detect Claude Code's tool-rejection sentinel that lands inside a
 * `tool_result` block when the user declines a permission prompt. The
 * sentinel is a fixed English paragraph; we look for a stable opening
 * phrase rather than full-string equality so any minor copy edits in
 * future Claude Code releases keep firing the flag.
 */
const TOOL_REJECTED_RE = /^The user doesn't want to proceed with this tool use\b/

function extractMetadata(raw: RawEvent): EventMetadata {
  const meta: EventMetadata = {
    uuid: raw.uuid,
    parentUuid: raw.parentUuid,
    cwd: raw.cwd,
    gitBranch: raw.gitBranch
  }

  if (raw.message?.usage) {
    meta.inputTokens = raw.message.usage.input_tokens
    meta.outputTokens = raw.message.usage.output_tokens
    meta.cacheCreationTokens = raw.message.usage.cache_creation_input_tokens
    meta.cacheReadTokens = raw.message.usage.cache_read_input_tokens
  }
  if (raw.message?.model) {
    meta.model = raw.message.model
  }
  if (raw.message?.stop_reason) {
    meta.stopReason = raw.message.stop_reason
  }

  return meta
}

function extractTextFromContent(content: string | RawContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n')
}

export function parseLine(line: string, sessionId: string): ParsedEvent[] {
  let raw: RawEvent
  try {
    raw = JSON.parse(line)
  } catch {
    return []
  }

  const timestamp = raw.timestamp || new Date().toISOString()
  const events: ParsedEvent[] = []

  switch (raw.type) {
    case 'user': {
      if (!raw.message) break
      const content = raw.message.content
      const text = typeof content === 'string' ? content : extractTextFromContent(content)

      // Extract tool_result blocks
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const output =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text || '')
                      .join('\n')
                  : ''
            const metadata: EventMetadata = { ...extractMetadata(raw), uuid: undefined }
            // Tag rejected tool calls so the renderer can localize the
            // English sentinel and SessionManager can avoid sticking the
            // session in `waiting`. The match is intentionally narrow
            // (anchored opening phrase) so genuine tool output that
            // happens to mention the same words is not flagged.
            if (output && TOOL_REJECTED_RE.test(output)) {
              metadata.interrupted = 'tool-rejected'
            }
            events.push({
              id: nextId(),
              sessionId,
              type: 'tool_result',
              timestamp,
              content: { toolOutput: output },
              metadata,
            })
          }
        }
      }

      if (text) {
        const metadata = extractMetadata(raw)
        // Detect Claude Code's "[Request interrupted ...]" sentinel.
        // SessionManager checks this flag to skip the `waiting`
        // transition (Claude Code never emits a follow-up assistant
        // message after the interrupt, so without the skip the typing
        // indicator would never dismiss).
        if (REQUEST_INTERRUPTED_RE.test(text)) {
          metadata.interrupted = 'user-interrupt'
        }
        events.push({
          id: nextId(),
          sessionId,
          type: 'user',
          timestamp,
          content: { text },
          metadata,
        })
      }
      break
    }

    case 'assistant': {
      if (!raw.message) break
      const content = raw.message.content
      const metadata = extractMetadata(raw)

      if (typeof content === 'string') {
        events.push({
          id: nextId(),
          sessionId,
          type: 'assistant',
          timestamp,
          content: { text: content },
          metadata
        })
        break
      }

      if (!Array.isArray(content)) break

      // Aggregate text blocks
      const textParts: string[] = []
      const thinkingParts: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'thinking' && block.thinking) {
          thinkingParts.push(block.thinking)
        } else if (block.type === 'tool_use') {
          // Flush accumulated text first
          if (textParts.length > 0) {
            events.push({
              id: nextId(),
              sessionId,
              type: 'assistant',
              timestamp,
              content: {
                text: textParts.join('\n'),
                thinkingText: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined
              },
              metadata
            })
            textParts.length = 0
            thinkingParts.length = 0
          }

          const mc: MessageContent = {
            toolName: block.name,
            toolInput: block.input
          }
          // Extract file path from Write/Edit
          if (block.input && ('file_path' in block.input || 'path' in block.input)) {
            mc.filePath = (block.input.file_path || block.input.path) as string
          }

          events.push({
            id: nextId(),
            sessionId,
            type: 'tool_use',
            timestamp,
            content: mc,
            metadata: { ...metadata, uuid: undefined }
          })
        }
      }

      // Remaining text
      if (textParts.length > 0 || (thinkingParts.length > 0 && events.length === 0)) {
        events.push({
          id: nextId(),
          sessionId,
          type: 'assistant',
          timestamp,
          content: {
            text: textParts.join('\n') || undefined,
            thinkingText: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined
          },
          metadata
        })
      }
      break
    }

    case 'system': {
      events.push({
        id: nextId(),
        sessionId,
        type: 'system',
        timestamp,
        content: { text: raw.message ? extractTextFromContent(raw.message.content) : '' },
        metadata: extractMetadata(raw)
      })
      break
    }

    case 'progress': {
      // hook_progress etc. — can be skipped in UI but retained for now
      const data = raw.data as Record<string, unknown> | undefined
      if (data?.type === 'hook_progress') {
        // Do not display hook progress
        break
      }
      events.push({
        id: nextId(),
        sessionId,
        type: 'progress',
        timestamp,
        content: { text: data?.statusMessage as string || '' },
        metadata: extractMetadata(raw)
      })
      break
    }

    // file-history-snapshot, last-prompt do not need to be displayed
    default:
      break
  }

  return events
}
