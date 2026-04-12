// JSONL から読み取ったイベントの共通フィールド
export interface RawEvent {
  type: string
  sessionId?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  userType?: string
  isSidechain?: boolean
  message?: RawMessage
  data?: Record<string, unknown>
  toolUseID?: string
  // file-history-snapshot
  snapshot?: Record<string, unknown>
  isSnapshotUpdate?: boolean
  messageId?: string
  // agent-setting
  agentSetting?: string
}

export interface RawMessage {
  role: 'user' | 'assistant'
  content: string | RawContentBlock[]
  model?: string
  id?: string
  type?: string
  stop_reason?: string
  usage?: TokenUsage
}

export interface RawContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | RawContentBlock[]
}

export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// パース済みイベント
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

// セッション
export interface Session {
  id: string
  projectPath: string
  projectName: string
  filePath: string
  status: 'active' | 'thinking' | 'waiting' | 'ready' | 'idle'
  /** エージェントID（agent-setting イベントから取得） */
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
  /** エージェントID */
  agentId?: string
  lastEventAt: string
  startedAt: string
  stats: SessionStats
  lastMessage?: string
}

// 設定
export interface ViewerConfig {
  claudeDir: string
  watcher: {
    usePolling: boolean
    pollInterval: number
  }
  agents: Record<string, AgentConfig>
  user: AgentConfig
  ui: {
    theme: string
    maxPreviewHeight: number
    autoScroll: boolean
  }
  window: {
    width: number
    height: number
    minWidth: number
    minHeight: number
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

// エージェント情報（定義ファイル + セッション紐づけ）
export interface AgentInfo {
  /** エージェントID（ファイル名から拡張子を除いたもの） */
  id: string
  /** 社員番号（フロントマターの employee_id） */
  employeeId?: string
  /** 表示名（日本語名） */
  displayName: string
  /** 説明 */
  description: string
  /** ロール（見出しから抽出） */
  role: string
  /** 使用モデル */
  model: string
  /** テーマカラー */
  color: string
  /** アバター画像ファイル名 */
  avatar?: string
  /** 星座・星名の由来 */
  origin: string
  /** 起動コマンド */
  command: string
  /** アクティブセッション数 */
  activeSessionCount: number
  /** 総セッション数 */
  totalSessionCount: number
  /** サマリー（viewer.config.json から） */
  summary?: string
}

// セッション-エージェント紐づけ記録
export interface SessionAgentRecord {
  sessionId: string
  agentType: string
  cwd: string
  startedAt: string
}

// Claude CLI プロセス管理
export interface ClaudeProcess {
  /** セッションID（既存セッション再開時はそのID、新規は起動後に判明） */
  sessionId: string | null
  /** エージェントID（新規セッション時） */
  agentId?: string
  /** プロセスの状態 */
  status: 'starting' | 'running' | 'completed' | 'error'
  /** 起動時刻 */
  startedAt: string
  /** エラーメッセージ */
  error?: string
}

// メッセージ送信リクエスト
export interface SendMessageRequest {
  message: string
}

// 新規セッション開始リクエスト
export interface NewSessionRequest {
  agentId?: string
  message: string
  cwd?: string
}

// 新規セッション開始レスポンス
export interface NewSessionResponse {
  success: boolean
  processId: string
  error?: string
}

// tmux 送信リクエスト
export interface TmuxSendRequest {
  /** 送信先ウィンドウ名（エージェントID） */
  windowName: string
  /** 送信メッセージ */
  message: string
}

// tmux エージェント起動リクエスト
export interface TmuxStartAgentRequest {
  /** エージェントID */
  agentId: string
  /** ウィンドウ名（省略時は agentId） */
  windowName?: string
  /** 作業ディレクトリ */
  cwd?: string
}

// NOTE (v0.1.0): タスク管理機能は v0.1.0 スコープ外のため、Task 関連の型定義は削除済み。
// v0.1.1 以降で Claude Code 標準のタスク管理機能（TaskCreate 系）をベースに再導入予定。
