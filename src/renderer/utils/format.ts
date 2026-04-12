/**
 * 共通フォーマットユーティリティ
 * セッション・エージェント画面で共通利用する表示ヘルパー
 */

/** ステータスに対応する表示設定（ドットカラー + ラベル） */
export const STATUS_INDICATORS: Record<string, { dot: string; label: string }> = {
  active: { dot: 'bg-green-400', label: 'Active' },
  thinking: { dot: 'bg-blue-400 animate-pulse', label: 'Thinking' },
  waiting: { dot: 'bg-yellow-400', label: 'Waiting' },
  ready: { dot: 'bg-green-400', label: 'Ready' },
  idle: { dot: 'bg-gray-500', label: 'Idle' },
}

/** タイムスタンプを相対時間に変換（「3分前」「2時間前」等） */
export function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '今'
  if (mins < 60) return `${mins}分前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  return `${days}日前`
}

/** トークン数を短縮表示（1234 → "1.2K", 1234567 → "1.2M"） */
export function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** モデル名を短縮表示（"claude-opus-4-..." → "Opus"） */
export function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

/** タスクの担当者表示名（nameMap で ID→表示名の変換が可能） */
export function getAssigneeLabel(assignee: string | null, nameMap?: Record<string, string>): string {
  if (!assignee) return '未割当'
  if (nameMap && nameMap[assignee]) return nameMap[assignee]
  return assignee
}

// --- クリップボードコピー用 Markdown 変換 ---

import type { ParsedEvent } from '../types'

/** タイムスタンプを HH:MM 形式に変換 */
function formatTimeShort(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** ロール名を日本語に変換 */
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

/** 1つのイベントをMarkdown文字列に変換 */
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

/** 複数イベントをMarkdownに結合 */
export function eventsToMarkdown(
  events: ParsedEvent[],
  getSpeakerName?: (event: ParsedEvent) => string
): string {
  return events
    .map((e) => eventToMarkdown(e, getSpeakerName?.(e)))
    .join('\n\n---\n\n')
}

/** クリップボードにテキストをコピー（成功したら true） */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// --- セッション引き継ぎ用メッセージ生成 ---

/** 最大文字数（トークン節約のため） */
const CONTINUE_SESSION_MAX_CHARS = 8000

/**
 * セッションの会話内容から引き継ぎメッセージを生成する
 * user/assistant メッセージのみ抽出し、新しいやりとりを優先して含める
 */
export function buildContinueSessionMessage(
  sessionId: string,
  events: ParsedEvent[],
): string {
  // user/assistant メッセージのみ抽出（テキストがあるもの）
  const conversations = events.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && e.content.text?.trim()
  )

  if (conversations.length === 0) {
    return `前のセッション（${sessionId.slice(0, 8)}）を引き継いで作業を続けてください。`
  }

  // 新しいやりとりを優先して含める（古いものから削る）
  const parts: string[] = []
  let totalChars = 0

  // 逆順（新しい順）で追加し、文字数上限に達したら打ち切る
  for (let i = conversations.length - 1; i >= 0; i--) {
    const e = conversations[i]
    const role = e.type === 'user' ? 'ユーザー' : 'アシスタント'
    const text = e.content.text!
    // 個々のメッセージは500文字で切り詰め
    const truncated = text.length > 500 ? text.slice(0, 500) + '...(省略)' : text
    const part = `## ${role}\n${truncated}`

    if (totalChars + part.length > CONTINUE_SESSION_MAX_CHARS) break
    parts.unshift(part) // 先頭に追加（時系列順を維持）
    totalChars += part.length
  }

  const omitNote = parts.length < conversations.length
    ? `\n（※ 古いやりとり ${conversations.length - Math.floor(parts.length)} 件は省略されています）\n`
    : ''

  return [
    `前のセッション（${sessionId.slice(0, 8)}）の内容を引き継いで作業を続けてください。`,
    '',
    '<previous-session>',
    omitNote,
    ...parts,
    '',
    '</previous-session>',
    '',
    '上記の文脈を踏まえて、続きの作業をお願いします。',
  ].join('\n')
}
