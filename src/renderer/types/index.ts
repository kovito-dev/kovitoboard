// Renderer 側で使う型定義（サーバーの types.ts と同じ構造を手動同期）

export interface ParsedEvent {
  id: string
  sessionId: string
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'progress'
  timestamp: string
  content: MessageContent
  metadata: EventMetadata
}

export interface MessageContent {
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  filePath?: string
  thinkingText?: string
}

export interface EventMetadata {
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  model?: string
  uuid?: string
  parentUuid?: string | null
  cwd?: string
  gitBranch?: string
  /** assistant メッセージの終了理由（"end_turn" で応答完了） */
  stopReason?: string
}

export interface Session {
  id: string
  projectPath: string
  projectName: string
  filePath: string
  status: 'active' | 'thinking' | 'waiting' | 'ready' | 'idle'
  agentId?: string
  events: ParsedEvent[]
  lastEventAt: string
  startedAt: string
  stats: SessionStats
}

export interface SessionStats {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
}

export interface SessionSummary {
  id: string
  projectName: string
  projectPath: string
  status: string
  agentId?: string
  lastEventAt: string
  startedAt: string
  stats: SessionStats
  lastMessage?: string
}

export interface ViewerConfig {
  claudeDir: string
  agents: Record<string, AgentConfig>
  user: AgentConfig
  ui: {
    theme: string
    maxPreviewHeight: number
    autoScroll: boolean
  }
  project?: {
    name: string
    description: string
    concept: string
  }
}

export interface AgentConfig {
  name: string
  avatar?: string
  color: string
  summary?: string
}

export interface AgentInfo {
  id: string
  employeeId?: string
  displayName: string
  description: string
  role: string
  model: string
  color: string
  avatar?: string
  origin: string
  command: string
  activeSessionCount: number
  totalSessionCount: number
  summary?: string
}

// tmux ウィンドウ情報
export interface TmuxWindow {
  index: number
  name: string
  active: boolean
}

// tmux ステータス
export interface TmuxStatus {
  hasSession: boolean
  sessionName: string
  windows: TmuxWindow[]
  /** エージェントID → tmux ウィンドウ名 */
  agentWindowMap: Record<string, string>
}

// NOTE (v0.1.0): タスク管理機能は v0.1.0 スコープ外のため、Task 関連の型定義は削除済み。
// v0.1.1 以降で Claude Code 標準のタスク管理機能（TaskCreate 系）をベースに再導入予定。

// メッセージ送信レスポンス
export interface SendMessageResponse {
  success: boolean
  processId: string
  error?: string
}

// 新規セッション開始レスポンス
export interface NewSessionResponse {
  success: boolean
  processId: string
  error?: string
}
