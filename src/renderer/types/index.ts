// Type definitions for the renderer (manually synced with server-side types.ts)

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
  /** Stop reason for assistant messages ("end_turn" indicates response completion) */
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

// tmux window information
export interface TmuxWindow {
  index: number
  name: string
  active: boolean
}

// tmux status
export interface TmuxStatus {
  hasSession: boolean
  sessionName: string
  windows: TmuxWindow[]
  /** Agent ID -> tmux window name */
  agentWindowMap: Record<string, string>
}

// NOTE (v0.1.0): Task management is out of scope for v0.1.0; Task-related type definitions have been removed.
// They will be reintroduced in v0.1.1+ based on Claude Code's native task management (TaskCreate, etc.).

// Send message response
export interface SendMessageResponse {
  success: boolean
  processId: string
  error?: string
}

// New session response
export interface NewSessionResponse {
  success: boolean
  processId: string
  error?: string
}
