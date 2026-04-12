import { join, basename } from 'path'
import { resolveProjectRoot } from './config'
import { getSessionAgentsRecordPath } from './paths'
import type { FileAccessLayer } from './fs-layer'
import type { AgentInfo, SessionAgentRecord, ViewerConfig } from './types'

/**
 * .claude/agents/*.md からエージェント定義を読み取る
 * デフォルトアシスタント（--agent なし起動）は含めない
 */
export function loadAgentDefinitions(fs: FileAccessLayer, config: ViewerConfig): AgentInfo[] {
  // CLAUDE_PROJECT_DIR に相当するパスからエージェント定義を探す
  // config.claudeDir は ~/.claude なので、そこからプロジェクト設定のエージェントを探す
  // エージェント定義は anode-workspace/.claude/agents/ にある
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
    console.error('[agent-reader] エージェント定義の読み取りエラー:', err)
  }

  return agents
}

/**
 * `.kovitoboard/session-agents.jsonl` からセッション-エージェント紐づけを読み取る
 *
 * @param _config ViewerConfig（現状未使用だが、将来の設定拡張に備えて残す）
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
        // 不正な行はスキップ
      }
    }
  } catch (err) {
    console.error('[agent-reader] セッション-エージェント記録の読み取りエラー:', err)
  }

  return records
}

/**
 * セッションID → エージェントID のマッピングを構築
 * 同一セッションに複数エントリがある場合（/clear による再記録）、
 * 具体的なエージェント名（default 以外）を優先する
 */
export function buildSessionAgentMap(records: SessionAgentRecord[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const record of records) {
    const existing = map.get(record.sessionId)
    // 既に具体的なエージェントが記録済みなら default で上書きしない
    if (existing && existing !== 'default' && record.agentType === 'default') continue
    map.set(record.sessionId, record.agentType)
  }
  return map
}

/**
 * エージェント定義ディレクトリを探す
 *
 * v0.1.0 方針（R2 対応）:
 * 1. プロジェクトルート（resolveProjectRoot()）直下の `.claude/agents/` を最優先
 * 2. fallback: cwd から親ディレクトリを遡って `.claude/agents/` を検索
 * 3. fallback: claudeDir 配下の `agents/`
 */
function findAgentsDir(fs: FileAccessLayer, config: ViewerConfig): string | null {
  // 1. プロジェクトルート直下の .claude/agents/ を最優先
  const projectAgentsDir = join(resolveProjectRoot(fs), '.claude', 'agents')
  if (fs.existsSync(projectAgentsDir)) return projectAgentsDir

  // 2. fallback: cwd から上に遡って .claude/agents/ を探す
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.claude', 'agents')
    if (fs.existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break // ルートに到達
    dir = parent
  }

  // 3. fallback: claudeDir 内にエージェント定義がある場合
  const claudeAgentsDir = join(config.claudeDir, 'agents')
  if (fs.existsSync(claudeAgentsDir)) return claudeAgentsDir

  return null
}

/**
 * エージェント定義ファイルをパース
 */
function parseAgentDefinition(
  filename: string,
  content: string,
  config: ViewerConfig
): AgentInfo | null {
  // YAML フロントマターを抽出
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]

  // name, description, model を取得
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

  // 本文から日本語名とロールを抽出
  // パターン: "# リラ（Lyra）— 編集長 / コンテンツディレクター"
  const headingMatch = content.match(/^#\s+(.+?)(?:（(.+?)）)?(?:\s*[—-]+\s*(.+))?$/m)

  let displayName = ''
  let origin = ''
  let role = ''

  if (headingMatch) {
    displayName = headingMatch[1].trim()
    // 英語名がある場合は括弧内から由来を推定
    if (headingMatch[2]) {
      origin = headingMatch[2].trim()
    }
    if (headingMatch[3]) {
      role = headingMatch[3].trim()
    }
  }

  // 由来をペルソナセクションから抽出
  // パターン: "- **名前:** リラ（Lyra / こと座）"
  const originMatch = content.match(/\*\*名前:\*\*\s*.+?[/／]\s*(.+?)\)/)
  if (originMatch) {
    origin = originMatch[1].trim()
  }

  // config からカラーを取得
  const agentConfig = config.agents[id] || config.agents[name]
  const color = agentConfig?.color || '#6B7280'

  // config に日本語名があればそちらを優先
  if (agentConfig?.name) {
    displayName = agentConfig.name
  }

  // config からアバターを取得
  const avatar = agentConfig?.avatar

  // config から summary を取得
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
