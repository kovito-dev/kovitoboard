/**
 * エージェント作成ロジック
 *
 * テンプレートを読み取り、カスタマイズを適用して
 * .claude/agents/ に新規エージェント定義ファイルを展開する。
 */

import { join } from 'path'
import matter from 'gray-matter'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'
import { getAgentTemplateContent } from './template-reader'

/** createAgentFromTemplate のオプション */
export interface CreateAgentOptions {
  /** テンプレート ID（例: "kovito-concierge"） */
  templateId: string
  /** エージェント ID（ファイル名に使用。例: "my-agent"） */
  agentId: string
  /** 表示名（frontmatter の displayName に設定） */
  displayName?: string
  /** ロケール */
  locale?: 'ja' | 'en'
  /** 構造化フィールドのカスタマイズ値 */
  customizations?: {
    personality?: string
    toneSample?: string
    extraInstructions?: string
  }
}

/** createAgentFromTemplate の戻り値 */
export interface CreateAgentResult {
  success: boolean
  /** 作成されたファイルの絶対パス */
  filePath?: string
  error?: string
}

/** エージェント ID のバリデーション */
function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && id.length <= 64
}

/**
 * テンプレートからエージェント定義ファイルを作成する。
 *
 * 処理フロー:
 * 1. テンプレートを読み込み
 * 2. マーカー置換（カスタマイズ値があれば）
 * 3. displayName があれば frontmatter に追加
 * 4. .claude/agents/{agentId}.md に書き込み
 * 5. .claude/agents/ が無ければ作成
 */
export function createAgentFromTemplate(
  fs: FileAccessLayer,
  options: CreateAgentOptions,
): CreateAgentResult {
  const { templateId, agentId, displayName, locale = 'ja', customizations } = options

  // バリデーション
  if (!isValidAgentId(agentId)) {
    return { success: false, error: 'Invalid agent ID. Use alphanumeric, hyphens, underscores (max 64 chars).' }
  }

  // テンプレート読み込み
  const templateContent = getAgentTemplateContent(fs, templateId, locale)
  if (!templateContent) {
    return { success: false, error: `Template not found: ${templateId}` }
  }

  // frontmatter と本文を分離
  const { data: frontmatterData, content: bodyContent } = matter(templateContent)

  // displayName を frontmatter に追加
  if (displayName) {
    frontmatterData.displayName = displayName
  }

  // マーカーベースの置換
  let processedBody = bodyContent
  if (customizations) {
    if (customizations.personality !== undefined) {
      processedBody = replaceMarkerSection(processedBody, 'PERSONALITY', customizations.personality)
    }
    if (customizations.toneSample !== undefined) {
      processedBody = replaceMarkerSection(processedBody, 'TONE_SAMPLE', customizations.toneSample)
    }
    if (customizations.extraInstructions !== undefined) {
      processedBody = replaceMarkerSection(processedBody, 'EXTRA_INSTRUCTIONS', customizations.extraInstructions)
    }
  }

  // frontmatter を再構築
  const finalContent = matter.stringify(processedBody, frontmatterData)

  // .claude/agents/ ディレクトリの確保
  const projectRoot = resolveProjectRoot(fs)
  const agentsDir = join(projectRoot, '.claude', 'agents')
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }

  // 同名ファイルの存在チェック
  const filePath = join(agentsDir, `${agentId}.md`)
  if (fs.existsSync(filePath)) {
    return { success: false, error: `Agent already exists: ${agentId}` }
  }

  // 書き込み
  try {
    fs.writeFileSync(filePath, finalContent, 'utf-8')
    return { success: true, filePath }
  } catch (err) {
    console.error('[agent-writer] Failed to write agent file:', err)
    return { success: false, error: 'Failed to write agent file' }
  }
}

/**
 * マーカーで囲まれたセクションを置換する。
 *
 * 形式:
 * <!-- KB:{NAME}_START -->
 * ... content ...
 * <!-- KB:{NAME}_END -->
 *
 * マーカーが見つからない場合は何も変更しない。
 */
function replaceMarkerSection(content: string, markerName: string, newValue: string): string {
  const startMarker = `<!-- KB:${markerName}_START -->`
  const endMarker = `<!-- KB:${markerName}_END -->`

  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return content
  }

  const before = content.substring(0, startIdx + startMarker.length)
  const after = content.substring(endIdx)

  return `${before}\n${newValue}\n${after}`
}
