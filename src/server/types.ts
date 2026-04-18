// Common fields of events read from JSONL
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

// Parsed event
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
  /** Stop reason for assistant message ("end_turn" = response complete) */
  stopReason?: string
}

// Session
export interface Session {
  id: string
  projectPath: string
  projectName: string
  filePath: string
  status: 'active' | 'thinking' | 'waiting' | 'ready' | 'idle'
  /** Agent ID (obtained from agent-setting event) */
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
  /** Agent ID */
  agentId?: string
  lastEventAt: string
  startedAt: string
  stats: SessionStats
  lastMessage?: string
}

// Configuration
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

// Agent info (definition file + session association)
export interface AgentInfo {
  /** Agent ID (filename without extension) */
  id: string
  /** Employee ID (from frontmatter employee_id) */
  employeeId?: string
  /** Display name */
  displayName: string
  /** Description */
  description: string
  /** Role (extracted from heading) */
  role: string
  /** Model used */
  model: string
  /** Theme color */
  color: string
  /** Avatar image filename */
  avatar?: string
  /** Origin (constellation / star name) */
  origin: string
  /** Launch command */
  command: string
  /** Active session count */
  activeSessionCount: number
  /** Total session count */
  totalSessionCount: number
  /** Summary (from viewer.config.json) */
  summary?: string
}

// Session-agent association record
export interface SessionAgentRecord {
  sessionId: string
  agentType: string
  cwd: string
  startedAt: string
}

// Claude CLI process management
export interface ClaudeProcess {
  /** Session ID (existing session ID on resume, determined after launch for new sessions) */
  sessionId: string | null
  /** Agent ID (for new sessions) */
  agentId?: string
  /** Process status */
  status: 'starting' | 'running' | 'completed' | 'error'
  /** Start time */
  startedAt: string
  /** Error message */
  error?: string
}

// Send message request
export interface SendMessageRequest {
  message: string
}

// New session start request
export interface NewSessionRequest {
  agentId?: string
  message?: string
  cwd?: string
  /** Key for the initial prompt dictionary (e.g. "onboarding:first-time"). When specified, the resolved text from the dictionary is sent */
  initialPrompt?: string
}

// New session start response
export interface NewSessionResponse {
  success: boolean
  processId: string
  error?: string
}

// tmux send request
export interface TmuxSendRequest {
  /** Target window name (agent ID) */
  windowName: string
  /** Message to send */
  message: string
}

// tmux agent start request
export interface TmuxStartAgentRequest {
  /** Agent ID */
  agentId: string
  /** Window name (defaults to agentId if omitted) */
  windowName?: string
  /** Working directory */
  cwd?: string
}

// NOTE (v0.1.0): Task management is out of scope for v0.1.0; Task-related type definitions have been removed.
// Will be reintroduced in v0.1.1+ based on Claude Code's built-in task management (TaskCreate etc.).
