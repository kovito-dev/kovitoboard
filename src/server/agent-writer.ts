/**
 * エージェント作成・更新ロジック
 *
 * - createAgentFromTemplate: テンプレートから新規エージェントを作成
 * - updateAgentSections: 既存エージェントの構造化フィールドを部分更新
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
export function isValidAgentId(id: string): boolean {
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

/** updateAgentSections のオプション */
export interface UpdateAgentOptions {
  /** 表示名の変更（undefined = 変更なし） */
  displayName?: string
  /** 構造化フィールドのカスタマイズ値 */
  sections?: {
    personality?: string
    toneSample?: string
    extraInstructions?: string
  }
}

/** updateAgentSections の戻り値 */
export interface UpdateAgentResult {
  success: boolean
  error?: string
}

/** 抽出されたマーカーセクションの内容 */
export interface ExtractedSections {
  /** マーカーが存在するかどうか */
  hasMarkers: boolean
  /** frontmatter の displayName（未設定なら undefined） */
  displayName?: string
  personality?: string
  toneSample?: string
  extraInstructions?: string
}

/**
 * 既存エージェントの構造化フィールドを部分更新する。
 *
 * - マーカーが存在するファイル: 該当セクションのみ置換
 * - マーカーが無いファイル（手動作成・レガシー）: エラーを返す（壊さない）
 * - displayName 変更: frontmatter の `displayName` フィールドを gray-matter で更新
 */
export function updateAgentSections(
  fs: FileAccessLayer,
  agentId: string,
  options: UpdateAgentOptions,
): UpdateAgentResult {
  if (!isValidAgentId(agentId)) {
    return { success: false, error: 'Invalid agent ID' }
  }

  const projectRoot = resolveProjectRoot(fs)
  const filePath = join(projectRoot, '.claude', 'agents', `${agentId}.md`)

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `Agent not found: ${agentId}` }
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const { data: frontmatterData, content: bodyContent } = matter(raw)

    // セクション更新が要求されている場合、マーカーの存在を確認
    if (options.sections) {
      const hasAnyMarker = MARKER_NAMES.some(name => {
        const startMarker = `<!-- KB:${name}_START -->`
        return bodyContent.includes(startMarker)
      })

      if (!hasAnyMarker) {
        return {
          success: false,
          error: 'This agent file does not contain structured field markers (KB:*). Manual files cannot be edited through this API.',
        }
      }
    }

    // displayName 更新
    if (options.displayName !== undefined) {
      if (options.displayName.trim() === '') {
        // 空文字の場合は displayName フィールドを削除
        delete frontmatterData.displayName
      } else {
        frontmatterData.displayName = options.displayName
      }
    }

    // マーカーベースのセクション置換
    let processedBody = bodyContent
    if (options.sections) {
      if (options.sections.personality !== undefined) {
        processedBody = replaceMarkerSection(processedBody, 'PERSONALITY', options.sections.personality)
      }
      if (options.sections.toneSample !== undefined) {
        processedBody = replaceMarkerSection(processedBody, 'TONE_SAMPLE', options.sections.toneSample)
      }
      if (options.sections.extraInstructions !== undefined) {
        processedBody = replaceMarkerSection(processedBody, 'EXTRA_INSTRUCTIONS', options.sections.extraInstructions)
      }
    }

    const finalContent = matter.stringify(processedBody, frontmatterData)
    fs.writeFileSync(filePath, finalContent, 'utf-8')

    return { success: true }
  } catch (err) {
    console.error('[agent-writer] Failed to update agent file:', err)
    return { success: false, error: 'Failed to update agent file' }
  }
}

/**
 * エージェントファイルから構造化フィールドの現在値を抽出する。
 * 編集 UI が初期値を表示するために使用。
 */
export function extractMarkerSections(
  fs: FileAccessLayer,
  agentId: string,
): ExtractedSections | null {
  if (!isValidAgentId(agentId)) return null

  const projectRoot = resolveProjectRoot(fs)
  const filePath = join(projectRoot, '.claude', 'agents', `${agentId}.md`)

  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const { data: frontmatterData, content: bodyContent } = matter(raw)

    const personality = extractSingleSection(bodyContent, 'PERSONALITY')
    const toneSample = extractSingleSection(bodyContent, 'TONE_SAMPLE')
    const extraInstructions = extractSingleSection(bodyContent, 'EXTRA_INSTRUCTIONS')

    const hasMarkers = personality !== undefined || toneSample !== undefined || extraInstructions !== undefined

    return {
      hasMarkers,
      displayName: typeof frontmatterData.displayName === 'string' ? frontmatterData.displayName : undefined,
      personality,
      toneSample,
      extraInstructions,
    }
  } catch {
    return null
  }
}

/** 全マーカー名のリスト */
const MARKER_NAMES = ['PERSONALITY', 'TONE_SAMPLE', 'EXTRA_INSTRUCTIONS'] as const

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

/**
 * マーカーで囲まれたセクションの内容を抽出する。
 * マーカーが存在しない場合は undefined を返す。
 */
function extractSingleSection(content: string, markerName: string): string | undefined {
  const startMarker = `<!-- KB:${markerName}_START -->`
  const endMarker = `<!-- KB:${markerName}_END -->`

  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return undefined
  }

  // マーカータグの直後から終了マーカーの直前まで
  const sectionContent = content.substring(startIdx + startMarker.length, endIdx)

  // 前後の空行を除去
  return sectionContent.replace(/^\n/, '').replace(/\n$/, '')
}
