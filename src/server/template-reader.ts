/**
 * テンプレート一覧と内容の取得
 *
 * templates/agents/*.md を走査してエージェントテンプレートの
 * サマリーおよび本文を返す。
 * FileAccessLayer を受け取る設計。frontmatter パースには gray-matter を使用。
 */
import { resolve, dirname, join, basename } from 'path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import type { FileAccessLayer } from './fs-layer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** テンプレートサマリー */
export interface AgentTemplateSummary {
  id: string           // e.g. "kovito-concierge"
  name: string         // frontmatter の name
  description: string  // frontmatter の description
  model: string        // frontmatter の model
}

/**
 * テンプレートディレクトリのパスを解決する。
 * dev: src/server/ -> ../../templates/agents
 * build: dist/server/ -> ../templates/agents
 */
function getTemplatesDir(fs: FileAccessLayer): string {
  const candidates = [
    resolve(__dirname, '../../templates/agents'),
    resolve(__dirname, '../templates/agents'),
  ]
  return candidates.find(d => fs.existsSync(d)) || candidates[0]
}

/**
 * templates/agents/*.md を走査してテンプレート一覧を返す。
 * `.en.md` ファイルは除外する（ロケール別取得は getAgentTemplateContent で行う）。
 */
export function listAgentTemplates(fs: FileAccessLayer): AgentTemplateSummary[] {
  const dir = getTemplatesDir(fs)
  if (!fs.existsSync(dir)) return []

  const templates: AgentTemplateSummary[] = []

  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.endsWith('.en.md'))

    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const { data } = matter(raw)

        const id = basename(file, '.md')
        const name = typeof data.name === 'string' ? data.name : id
        const description = typeof data.description === 'string' ? data.description : ''
        const model = typeof data.model === 'string' ? data.model : 'default'

        templates.push({ id, name, description, model })
      } catch (err) {
        console.error(`[template-reader] Failed to parse template ${file}:`, err)
      }
    }
  } catch (err) {
    console.error('[template-reader] Error reading templates directory:', err)
  }

  return templates
}

/**
 * 指定テンプレートの内容を返す。
 * locale が 'en' の場合は `{id}.en.md` を優先し、無ければ `{id}.md` にフォールバック。
 * locale が 'ja' の場合は `{id}.md` を返す。
 * テンプレートが見つからない場合は null を返す。
 */
export function getAgentTemplateContent(
  fs: FileAccessLayer,
  id: string,
  locale: 'ja' | 'en',
): string | null {
  const dir = getTemplatesDir(fs)
  if (!fs.existsSync(dir)) return null

  // ID のバリデーション（ディレクトリトラバーサル防止）
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null

  if (locale === 'en') {
    // 英語版を優先
    const enPath = join(dir, `${id}.en.md`)
    if (fs.existsSync(enPath)) {
      try {
        return fs.readFileSync(enPath, 'utf-8')
      } catch {
        // フォールバックへ
      }
    }
  }

  // 日本語版（デフォルト）
  const jaPath = join(dir, `${id}.md`)
  if (!fs.existsSync(jaPath)) return null

  try {
    return fs.readFileSync(jaPath, 'utf-8')
  } catch {
    return null
  }
}
