/**
 * settings-reader.ts
 * CLAUDE.md や .claude/ 配下の設定ファイルを読み取り、構造化データとして返す
 */

import { join } from 'path'
import type { FileAccessLayer } from './fs-layer'

// --- 型定義 ---

export interface BasicSettings {
  projectName: string
  description: string
  concept: string
  userName: string
  language: string
  agents: { id: string; name: string; role: string; employeeId?: string }[]
}

export interface SkillInfo {
  name: string
  description: string
  category: 'operation' | 'procedure' | 'knowledge'
  invocation: string
}

export interface HookInfo {
  event: string
  type: 'command'
  command: string
}

export interface AutomationSettings {
  hooks: HookInfo[]
  crons: []
}

export interface IntegrationInfo {
  name: string
  type: string
  status: 'configured'
}

export interface RuleInfo {
  name: string
  content: string
}

// --- 実装 ---

/**
 * プロジェクト基本情報を読み取る
 * viewer.config.json の project セクション + agents セクションを主データソースにし、
 * CLAUDE.md は補完用に使用
 */
export function readBasicSettings(fs: FileAccessLayer, projectRoot: string): BasicSettings {
  const settings: BasicSettings = {
    projectName: '',
    description: '',
    concept: '',
    userName: '',
    language: '日本語',
    agents: [],
  }

  // viewer.config.json から読み取り（主データソース）
  const configPath = join(projectRoot, 'config', 'viewer.config.json')
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

      // project セクション
      if (config.project) {
        settings.projectName = config.project.name || ''
        settings.description = config.project.description || ''
        settings.concept = config.project.concept || ''
      }

      // user セクション
      if (config.user?.name) {
        settings.userName = config.user.name
      }

      // agents セクション
      if (config.agents) {
        for (const [id, agentCfg] of Object.entries(config.agents)) {
          if (id === 'default') continue
          const cfg = agentCfg as { name?: string; summary?: string }
          settings.agents.push({
            id,
            name: cfg.name || id,
            role: cfg.summary || '',
          })
        }
      }
    } catch {
      // 読み取り失敗時はフォールバック
    }
  }

  // CLAUDE.md から補完（viewer.config.json にない情報を取得）
  const claudeMdPath = join(projectRoot, 'CLAUDE.md')
  if (fs.existsSync(claudeMdPath)) {
    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8')

      // プロジェクト名（未取得の場合）
      if (!settings.projectName) {
        const nameMatch = content.match(/プロジェクト名:\s*(.+)/)
        if (nameMatch) settings.projectName = nameMatch[1].trim()
      }

      // 説明（未取得の場合）
      if (!settings.description) {
        const descMatch = content.match(/説明:\s*(.+)/)
        if (descMatch) settings.description = descMatch[1].trim()
      }

      // コンセプト（未取得の場合）
      if (!settings.concept) {
        const conceptMatch = content.match(/システムコンセプト:\s*(.+)/)
        if (conceptMatch) {
          const val = conceptMatch[1].trim()
          if (val !== '未設定') settings.concept = val
        }
      }

      // 言語設定
      if (content.includes('常に日本語で会話する')) {
        settings.language = '日本語'
      } else if (content.includes('Always communicate in English')) {
        settings.language = 'English'
      }

      // エージェント情報をチーム構成テーブルから補完（employee_id）
      const agentsDir = join(projectRoot, '.claude', 'agents')
      if (fs.existsSync(agentsDir)) {
        const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
        for (const file of files) {
          const agentId = file.replace('.md', '')
          const agentContent = fs.readFileSync(join(agentsDir, file), 'utf-8')
          const empIdMatch = agentContent.match(/employee_id:\s*"?(\d+)"?/)
          if (empIdMatch) {
            const existing = settings.agents.find((a) => a.id === agentId)
            if (existing) {
              existing.employeeId = empIdMatch[1]
            }
          }
        }
      }
    } catch {
      // 読み取り失敗時は無視
    }
  }

  return settings
}

/**
 * スキル一覧を読み取る
 */
export function readSkills(fs: FileAccessLayer, projectRoot: string): SkillInfo[] {
  const skillsDir = join(projectRoot, '.claude', 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const skills: SkillInfo[] = []

  try {
    const dirs = fs.readdirSync(skillsDir)
    for (const dirName of dirs) {
      const skillDir = join(skillsDir, dirName)
      const skillFile = join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue

      try {
        const content = fs.readFileSync(skillFile, 'utf-8')

        // YAML フロントマターからメタデータを抽出
        let description = ''
        let category: SkillInfo['category'] = 'procedure'

        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (frontmatterMatch) {
          const fm = frontmatterMatch[1]

          const descMatch = fm.match(/description:\s*"?(.+?)"?\s*$/m)
          if (descMatch) description = descMatch[1].trim()

          // カテゴリ判定
          if (fm.includes('disable-model-invocation: true')) {
            category = 'operation'
          } else if (fm.includes('user-invocable: false')) {
            category = 'knowledge'
          }
        }

        skills.push({
          name: dirName,
          description,
          category,
          invocation: `/${dirName}`,
        })
      } catch {
        // 個別スキルの読み取り失敗はスキップ
      }
    }
  } catch {
    // ディレクトリ読み取り失敗
  }

  return skills
}

/**
 * 自動処理設定を読み取る（hooks + cron）
 */
export function readAutomations(fs: FileAccessLayer, projectRoot: string): AutomationSettings {
  const result: AutomationSettings = { hooks: [], crons: [] }

  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return result

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

    // hooks セクション
    if (settings.hooks) {
      for (const [event, hookList] of Object.entries(settings.hooks)) {
        if (!Array.isArray(hookList)) continue
        for (const hook of hookList) {
          const h = hook as { type?: string; command?: string }
          if (h.type === 'command' && h.command) {
            result.hooks.push({
              event,
              type: 'command',
              command: h.command,
            })
          }
        }
      }
    }
  } catch {
    // 読み取り失敗時は空を返す
  }

  return result
}

/**
 * 外部連携設定を読み取る（MCP サーバー等）
 */
export function readIntegrations(fs: FileAccessLayer, projectRoot: string): IntegrationInfo[] {
  const integrations: IntegrationInfo[] = []

  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return integrations

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

    if (settings.mcpServers) {
      for (const name of Object.keys(settings.mcpServers)) {
        integrations.push({
          name,
          type: 'mcp',
          status: 'configured',
        })
      }
    }
  } catch {
    // 読み取り失敗時は空を返す
  }

  return integrations
}

/**
 * ルール一覧を読み取る
 */
export function readRules(fs: FileAccessLayer, projectRoot: string): RuleInfo[] {
  const rulesDir = join(projectRoot, '.claude', 'rules')
  if (!fs.existsSync(rulesDir)) return []

  const rules: RuleInfo[] = []

  try {
    const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      try {
        const content = fs.readFileSync(join(rulesDir, file), 'utf-8')
        rules.push({
          name: file.replace('.md', ''),
          content: content.trim(),
        })
      } catch {
        // 個別ファイル読み取り失敗はスキップ
      }
    }
  } catch {
    // ディレクトリ読み取り失敗
  }

  return rules
}
