import type { RawEvent, RawContentBlock, ParsedEvent, MessageContent, EventMetadata } from './types'

let eventCounter = 0

function nextId(): string {
  return `evt_${++eventCounter}`
}

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

      // tool_result ブロックを抽出
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
            events.push({
              id: nextId(),
              sessionId,
              type: 'tool_result',
              timestamp,
              content: { toolOutput: output },
              metadata: { ...extractMetadata(raw), uuid: undefined }
            })
          }
        }
      }

      if (text) {
        events.push({
          id: nextId(),
          sessionId,
          type: 'user',
          timestamp,
          content: { text },
          metadata: extractMetadata(raw)
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

      // テキストブロックをまとめる
      const textParts: string[] = []
      const thinkingParts: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'thinking' && block.thinking) {
          thinkingParts.push(block.thinking)
        } else if (block.type === 'tool_use') {
          // テキストがたまっていたら先に出す
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
          // Write/Edit からファイルパスを抽出
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

      // 残りのテキスト
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
      // hook_progress 等 — UIではスキップ可能だが一応保持
      const data = raw.data as Record<string, unknown> | undefined
      if (data?.type === 'hook_progress') {
        // フック進行状況は表示しない
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

    // file-history-snapshot, last-prompt は表示不要
    default:
      break
  }

  return events
}
