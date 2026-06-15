/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
  /**
   * Flag set on `user` and `tool_result` events that originated from
   * Claude Code's "interrupt / reject" path. Two flavours:
   *
   * - `'tool-rejected'`: the user (or KB on the user's behalf) declined
   *   a permission prompt. Claude Code surfaces this as a `tool_result`
   *   block with `is_error: true` and a fixed English sentinel
   *   ("The user doesn't want to proceed with this tool use ...").
   * - `'user-interrupt'`: Claude Code's follow-up "[Request interrupted
   *   by user for tool use]" sentinel that appears immediately after a
   *   tool rejection or an `Esc` press during a running tool call.
   *
   * Both end the agent turn — there is NO subsequent assistant message.
   * Without this flag the SessionManager would leave the session in
   * `waiting` indefinitely (the typing indicator never dismisses) and
   * the renderer would display the raw English sentinel verbatim.
   * Detection happens in `parser.ts`; status handling in
   * `session-manager.ts`; localization + special rendering in the
   * renderer's MessageBubble.
   */
  interrupted?: 'tool-rejected' | 'user-interrupt'
}

// Session
/**
 * Session origin (DEC-020 v1.1 §2.6 / EU8). Identifies whether a
 * session was started from the Ambient Session Sidebar or from the
 * standard Sessions page. Used by the UI to decorate sidebar-origin
 * sessions in the Sessions list. Optional — pre-existing sessions and
 * sessions started by external means default to `'sessions'` for
 * backward compatibility.
 */
export type SessionOrigin =
  | 'sidebar'
  | 'sessions'
  | 'recipe-create-app'
  /**
   * v0.1.0 install handover (DEC-024 #2 / spec §3.2): the user
   * picked an agent in the recipe sample card's agent picker and
   * the install API kicked off a session with the v2.0 install
   * prompt. The watcher reservation lets the resulting session
   * inherit this origin tag once Claude writes the JSONL.
   */
  | 'recipe-install'
  /**
   * v0.1.0 app removal flow (DEC-024 #3 / spec §F8): the user opened
   * the AppRemovalModal from the NavMenu remove-button, picked an
   * agent, and the request-removal API kicked off the agent dialog
   * that walks them through `app/<appId>/` cleanup.
   */
  | 'app-removal'

export interface Session {
  id: string
  projectPath: string
  projectName: string
  filePath: string
  status: 'active' | 'thinking' | 'waiting' | 'ready' | 'idle'
  /** Agent ID (obtained from agent-setting event) */
  agentId?: string
  /**
   * Where this session was started from. Set when `setAgentId` consumes
   * a pending origin reservation (see SessionManager.reserveOrigin).
   * Absent for legacy sessions and sessions whose origin could not be
   * resolved within the reservation TTL.
   */
  origin?: SessionOrigin
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
  /** Session origin (DEC-020 / EU8). See `Session.origin`. */
  origin?: SessionOrigin
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
    /**
     * Period (ms) of the reconciliation scan that recovers JSONL
     * add/change events the live watcher dropped (session-management.md
     * §7.3.2). Optional and additive: existing `viewer.config.json` files
     * without this field deep-merge to the default (10000). A value `<= 0`
     * disables the reconciliation scan (operator opt-out, §7.3.3) — not
     * recommended, since the scan is the primary safety net against the
     * dirty-start silent degrade (§7.3.1).
     */
    reconcileInterval?: number
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
  /**
   * System-managed agent (Q13 / AA-7). When true, the agent is a
   * KB-provided virtual entry like "Claude (default)" — its
   * definition cannot be edited, sessions are launched without an
   * `--agent` flag, and the AgentList renders it under a separate
   * "System" group at the bottom.
   */
  isSystem?: boolean
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
  /**
   * Session origin (DEC-020 / EU8). When set to `'sidebar'`, the
   * SessionManager records a pending reservation so the resulting
   * session inherits the right origin once its agent is resolved.
   * Defaults to `'sessions'` when omitted.
   */
  origin?: SessionOrigin
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
