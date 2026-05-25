/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { serverLogger } from './logger'
import { dirname, join, basename } from 'path'
import { resolveProjectRoot } from './config'
import { getSessionAgentsRecordPath } from './paths'
import { resolveAvatarRelativeName } from './services/avatar-resolver'
import type { FileAccessLayer } from './fs-layer'
import type { AgentInfo, SessionAgentRecord, ViewerConfig } from './types'

/**
 * Reserved ID for the system-managed default agent (Q13 / AA-7).
 *
 * The double-underscore prefix is reserved by KB so user-created
 * agents cannot accidentally collide. tmux-bridge.startAgent
 * dispatches this ID without an `--agent` flag, launching plain
 * `claude` so the user gets a vanilla Claude Code session inside KB
 * without having to drop to a terminal.
 */
export const SYSTEM_DEFAULT_AGENT_ID = '__claude_default__'

/**
 * Synthesise the AgentInfo entry for the system default agent so the
 * Agents page can show "Claude (default)" alongside the bundled and
 * user-authored agents. The entry is virtual — it lives only at API
 * response time and is intentionally not persisted to .claude/agents/
 * so it cannot be edited or removed.
 *
 * Localisation of `displayName` / `description` is handled in the
 * renderer (architect §6.11): the server returns stable English
 * tokens that the i18n layer can override per locale.
 */
function buildSystemDefaultAgent(): AgentInfo {
  return {
    id: SYSTEM_DEFAULT_AGENT_ID,
    displayName: 'Claude (default)',
    description: 'Vanilla Claude Code session without a custom system prompt. Useful for general-purpose chats inside KB.',
    role: 'Default',
    model: 'default',
    color: '#a855f7',
    avatar: 'default/claude-default.svg',
    origin: 'system',
    command: 'claude',
    activeSessionCount: 0,
    totalSessionCount: 0,
    isSystem: true,
  }
}

/**
 * Read agent definitions from .claude/agents/*.md
 * Does not include the default assistant (launched without --agent)
 *
 * The system default agent (Q13 / AA-7) is appended at the end so
 * it always sorts after any user/bundled agents in the AgentList.
 */
export function loadAgentDefinitions(fs: FileAccessLayer, config: ViewerConfig): AgentInfo[] {
  // Look for agent definitions from the path equivalent to CLAUDE_PROJECT_DIR
  // config.claudeDir is ~/.claude, so look for project-configured agents from there
  // Agent definitions are in <project>/.claude/agents/
  const agentsDir = findAgentsDir(fs, config)
  const agents: AgentInfo[] = []

  if (agentsDir) {
    try {
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))

      for (const file of files) {
        const filePath = join(agentsDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        const agent = parseAgentDefinition(file, content, config)
        if (agent) {
          // If viewer config did not pin an avatar for this agent, fall back
          // to a matching file under public/avatars/{custom,default}/. The
          // value is a path relative to the avatars root (e.g.
          // `default/kovito-concierge.svg`) because <AgentAvatar> in the
          // renderer prepends `/avatars/` on its own.
          if (!agent.avatar) {
            const rel = resolveAvatarRelativeName(fs, agent.id)
            if (rel) agent.avatar = rel
          }
          agents.push(agent)
        }
      }
    } catch (err) {
      serverLogger.error({ err }, '[agent-reader] Error reading agent definitions:')
    }
  }

  // Always append the system default agent. Even when no user agents
  // exist, KB still wants to expose a way to start a vanilla Claude
  // Code session — that's the whole point of Q13.
  agents.push(buildSystemDefaultAgent())

  return agents
}

/**
 * Read session-agent associations from `.kovitoboard/session-agents.jsonl`
 *
 * @param _config ViewerConfig (currently unused, kept for future config extensibility)
 */
export function loadSessionAgentRecords(fs: FileAccessLayer, _config: ViewerConfig): SessionAgentRecord[] {
  const recordPath = getSessionAgentsRecordPath(fs)
  if (!fs.existsSync(recordPath)) return []

  const records: SessionAgentRecord[] = []
  try {
    const content = fs.readFileSync(recordPath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim())

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as SessionAgentRecord
        if (record.sessionId && record.agentType) {
          records.push(record)
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch (err) {
    serverLogger.error({ err }, '[agent-reader] Error reading session-agent records:')
  }

  return records
}

/**
 * Persist a session → agent association to `.kovitoboard/session-agents.jsonl`.
 *
 * The file is an append-only log; `buildSessionAgentMap` replays it in order
 * and specific agent IDs beat `default`, so writing the same session multiple
 * times is safe and the most recent specific ID wins.
 */
export function appendSessionAgentRecord(
  fs: FileAccessLayer,
  sessionId: string,
  agentType: string,
): void {
  const recordPath = getSessionAgentsRecordPath(fs)
  const dir = dirname(recordPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const record: SessionAgentRecord = {
    sessionId,
    agentType,
    cwd: resolveProjectRoot(fs),
    startedAt: new Date().toISOString(),
  }

  let existing = ''
  if (fs.existsSync(recordPath)) {
    try {
      existing = fs.readFileSync(recordPath, 'utf-8')
    } catch {
      // treat as empty on read failure; the new record will still be written
    }
  }
  const needsSeparator = existing.length > 0 && !existing.endsWith('\n')
  const next = existing + (needsSeparator ? '\n' : '') + JSON.stringify(record) + '\n'
  fs.writeFileSync(recordPath, next, 'utf-8')
}

/**
 * Build a sessionId -> agentId mapping.
 * When multiple entries exist for the same session (re-recorded via /clear),
 * a specific agent name (other than 'default') takes priority.
 */
export function buildSessionAgentMap(records: SessionAgentRecord[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const record of records) {
    const existing = map.get(record.sessionId)
    // Do not overwrite with 'default' if a specific agent is already recorded
    if (existing && existing !== 'default' && record.agentType === 'default') continue
    map.set(record.sessionId, record.agentType)
  }
  return map
}

/**
 * Get the raw content of a specific agent's definition file.
 * Returns null if the agent or file is not found.
 */
export function getAgentDefinitionContent(
  fs: FileAccessLayer,
  config: ViewerConfig,
  agentId: string,
): string | null {
  const agentsDir = findAgentsDir(fs, config)
  if (!agentsDir) return null

  const filePath = join(agentsDir, `${agentId}.md`)
  if (!fs.existsSync(filePath)) return null

  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Locate the agent definitions directory.
 *
 * DEC-014: Strictly resolve from the project root. No implicit fallbacks.
 * If the directory does not exist, callers receive an empty list and the
 * UI shows the empty-state guide (`agent.list.empty` etc.).
 */
function findAgentsDir(fs: FileAccessLayer, _config: ViewerConfig): string | null {
  const projectAgentsDir = join(resolveProjectRoot(fs), '.claude', 'agents')
  return fs.existsSync(projectAgentsDir) ? projectAgentsDir : null
}

/**
 * Parse an agent definition file.
 */
function parseAgentDefinition(
  filename: string,
  content: string,
  config: ViewerConfig
): AgentInfo | null {
  // Normalize CRLF to LF before regex matching. Agent definition files
  // checked out under git's `core.autocrlf=true` (the default on
  // Windows / WSL with Windows credentials) come back with CRLF, and
  // the frontmatter / per-field regexes below were authored against
  // bare `\n`. Normalizing once here keeps the rest of the parser
  // simple and avoids a class of "agents silently disappear on
  // Windows" bugs.
  content = content.replace(/\r\n/g, '\n')

  // Extract YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]

  // Extract name, description, model
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*"?(.+?)"?\s*$/m)
  const modelMatch = frontmatter.match(/^model:\s*(.+)$/m)
  const employeeIdMatch = frontmatter.match(/^employee_id:\s*"?(.+?)"?\s*$/m)
  // Q3 / AD-3: themeColor field. Optional — when missing the parser
  // falls back to the viewer.config.json color or the default below.
  const themeColorMatch = frontmatter.match(/^themeColor:\s*"?(#[0-9a-fA-F]{3,8})"?\s*$/m)

  if (!nameMatch) return null

  const id = basename(filename, '.md')
  const name = nameMatch[1].trim()
  const description = descMatch ? descMatch[1].trim() : ''
  const model = modelMatch ? modelMatch[1].trim() : 'default'
  const employeeId = employeeIdMatch ? employeeIdMatch[1].trim() : undefined
  const themeColor = themeColorMatch ? themeColorMatch[1].trim() : undefined

  // Extract display name and role from body
  // Pattern: "# Name（EnglishName）— Role / Title"
  const headingMatch = content.match(/^#\s+(.+?)(?:（(.+?)）)?(?:\s*[—-]+\s*(.+))?$/m)

  let displayName = ''
  let origin = ''
  let role = ''

  if (headingMatch) {
    displayName = headingMatch[1].trim()
    // If an English name exists, infer origin from parenthesized content
    if (headingMatch[2]) {
      origin = headingMatch[2].trim()
    }
    if (headingMatch[3]) {
      role = headingMatch[3].trim()
    }
  }

  // Extract origin from persona section
  // Pattern: "- **Name:** Name (EnglishName / Origin)" (Japanese frontmatter key)
  const originMatch = content.match(/\*\*名前:\*\*\s*.+?[/／]\s*(.+?)\)/)
  if (originMatch) {
    origin = originMatch[1].trim()
  }

  // Get color: frontmatter `themeColor` wins (Q3 / AD-3 explicit
  // override), falling back to viewer.config.json then to the
  // legacy neutral grey when neither source declared a value.
  const agentConfig = config.agents[id] || config.agents[name]
  const color = themeColor ?? agentConfig?.color ?? '#6B7280'

  // Prefer display name from config if available
  if (agentConfig?.name) {
    displayName = agentConfig.name
  }

  // Get avatar from config
  const avatar = agentConfig?.avatar

  // Get summary from config
  const summary = agentConfig?.summary || ''

  return {
    id,
    employeeId,
    displayName: displayName || name,
    description,
    role,
    model,
    color,
    avatar,
    origin,
    command: `claude --agent ${id}`,
    activeSessionCount: 0,
    totalSessionCount: 0,
    summary,
  }
}
