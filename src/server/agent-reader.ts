import { join, basename } from 'path'
import { resolveProjectRoot } from './config'
import { getSessionAgentsRecordPath } from './paths'
import type { FileAccessLayer } from './fs-layer'
import type { AgentInfo, SessionAgentRecord, ViewerConfig } from './types'

/**
 * Read agent definitions from .claude/agents/*.md
 * Does not include the default assistant (launched without --agent)
 */
export function loadAgentDefinitions(fs: FileAccessLayer, config: ViewerConfig): AgentInfo[] {
  // Look for agent definitions from the path equivalent to CLAUDE_PROJECT_DIR
  // config.claudeDir is ~/.claude, so look for project-configured agents from there
  // Agent definitions are in <project>/.claude/agents/
  const agentsDir = findAgentsDir(fs, config)
  if (!agentsDir) return []

  const agents: AgentInfo[] = []

  try {
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))

    for (const file of files) {
      const filePath = join(agentsDir, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const agent = parseAgentDefinition(file, content, config)
      if (agent) {
        agents.push(agent)
      }
    }
  } catch (err) {
    console.error('[agent-reader] Error reading agent definitions:', err)
  }

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
    console.error('[agent-reader] Error reading session-agent records:', err)
  }

  return records
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
 * Find the agent definitions directory.
 *
 * v0.1.0 strategy (R2 support):
 * 1. Prefer `.claude/agents/` directly under the project root (resolveProjectRoot())
 * 2. Fallback: traverse parent directories from cwd looking for `.claude/agents/`
 * 3. Fallback: `agents/` under claudeDir
 */
function findAgentsDir(fs: FileAccessLayer, config: ViewerConfig): string | null {
  // 1. Prefer .claude/agents/ directly under project root
  const projectAgentsDir = join(resolveProjectRoot(fs), '.claude', 'agents')
  if (fs.existsSync(projectAgentsDir)) return projectAgentsDir

  // 2. Fallback: traverse upward from cwd looking for .claude/agents/
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.claude', 'agents')
    if (fs.existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break // Reached filesystem root
    dir = parent
  }

  // 3. Fallback: agent definitions inside claudeDir
  const claudeAgentsDir = join(config.claudeDir, 'agents')
  if (fs.existsSync(claudeAgentsDir)) return claudeAgentsDir

  return null
}

/**
 * Parse an agent definition file.
 */
function parseAgentDefinition(
  filename: string,
  content: string,
  config: ViewerConfig
): AgentInfo | null {
  // Extract YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]

  // Extract name, description, model
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*"?(.+?)"?\s*$/m)
  const modelMatch = frontmatter.match(/^model:\s*(.+)$/m)
  const employeeIdMatch = frontmatter.match(/^employee_id:\s*"?(.+?)"?\s*$/m)

  if (!nameMatch) return null

  const id = basename(filename, '.md')
  const name = nameMatch[1].trim()
  const description = descMatch ? descMatch[1].trim() : ''
  const model = modelMatch ? modelMatch[1].trim() : 'default'
  const employeeId = employeeIdMatch ? employeeIdMatch[1].trim() : undefined

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
  // Pattern: "- **名前:** Name（EnglishName / Origin）"
  const originMatch = content.match(/\*\*名前:\*\*\s*.+?[/／]\s*(.+?)\)/)
  if (originMatch) {
    origin = originMatch[1].trim()
  }

  // Get color from config
  const agentConfig = config.agents[id] || config.agents[name]
  const color = agentConfig?.color || '#6B7280'

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
