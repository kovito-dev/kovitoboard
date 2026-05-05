/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
  /**
   * Flag mirrored from server-side EventMetadata. When set, MessageBubble
   * renders a localized "interrupt" pill instead of the raw English
   * sentinel from Claude Code (see server-side comment for details).
   */
  interrupted?: 'tool-rejected' | 'user-interrupt'
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

/**
 * Session origin (DEC-020 v1.1 §2.6 / EU8). Mirrors the server-side
 * `SessionOrigin` so the Sessions list can decorate sidebar-origin
 * sessions without leaking server-only types into the renderer.
 */
export type SessionOrigin =
  | 'sidebar'
  | 'sessions'
  | 'recipe-create-app'
  /**
   * v0.1.0 install handover (DEC-024 #2). Sessions started by the
   * recipe sample card's "Install" → agent-picker flow.
   */
  | 'recipe-install'
  /**
   * v0.1.0 app removal flow (DEC-024 #3). Sessions started by the
   * NavMenu "Remove app" button.
   */
  | 'app-removal'

export interface SessionSummary {
  id: string
  projectName: string
  projectPath: string
  status: string
  agentId?: string
  /** Where this session was started from. Optional for legacy sessions. */
  origin?: SessionOrigin
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
  /**
   * System-managed agent flag (Q13 / AA-7). Mirrors the server-side
   * field — true for KB-provided virtual entries such as the default
   * Claude session. The renderer uses this to (a) render the agent
   * under a dedicated "System" section in AgentList and (b) hide
   * editing affordances on the detail page.
   */
  isSystem?: boolean
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
