/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Retrieve template list and contents.
 *
 * Scans templates/agents/*.md and returns agent template
 * summaries and body content.
 * Designed to receive a FileAccessLayer. Uses gray-matter for frontmatter parsing.
 */
import { serverLogger } from './logger'
import { resolve, dirname, join, basename } from 'path'
import { fileURLToPath } from 'node:url'
import { safeMatter as matter } from './recipe/safe-matter'
import type { FileAccessLayer } from './fs-layer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Template summary */
export interface AgentTemplateSummary {
  id: string           // e.g. "kovito-concierge"
  name: string         // name from frontmatter
  description: string  // description from frontmatter
  model: string        // model from frontmatter
}

/**
 * Resolve the template directory path.
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
 * Scan templates/agents/*.md and return the template list.
 *
 * `.en.md` files are not enumerated as separate entries; they are excluded
 * from id enumeration and consulted only for locale resolution.
 *
 * `id` / `model` come from `{id}.md` (locale-independent SSOT). When
 * `locale === 'en'`, `name` / `description` are resolved from `{id}.en.md`
 * if present, falling back to `{id}.md` otherwise. This mirrors the
 * selection policy of `getAgentTemplateContent`.
 */
export function listAgentTemplates(
  fs: FileAccessLayer,
  locale: 'ja' | 'en' = 'ja',
): AgentTemplateSummary[] {
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
        const model = typeof data.model === 'string' ? data.model : 'default'

        // name / description follow the requested locale; id / model do not.
        // For locale 'en', the `.en.md` overlay is resolved per field: a
        // localized field is used when present, otherwise it falls back to the
        // base `.md` value (so a partial `.en.md` overlay never blanks a field).
        let localized = data
        if (locale === 'en') {
          const enPath = join(dir, `${id}.en.md`)
          if (fs.existsSync(enPath)) {
            try {
              localized = matter(fs.readFileSync(enPath, 'utf-8')).data
            } catch (err) {
              serverLogger.error({ err }, `[template-reader] Failed to parse template ${id}.en.md:`)
              // Keep the `.md` frontmatter as fallback.
            }
          }
        }

        const pick = (key: 'name' | 'description'): string | undefined => {
          if (typeof localized[key] === 'string') return localized[key]
          if (typeof data[key] === 'string') return data[key]
          return undefined
        }

        const name = pick('name') ?? id
        const description = pick('description') ?? ''

        templates.push({ id, name, description, model })
      } catch (err) {
        serverLogger.error({ err }, `[template-reader] Failed to parse template ${file}:`)
      }
    }
  } catch (err) {
    serverLogger.error({ err }, '[template-reader] Error reading templates directory:')
  }

  return templates
}

/**
 * Return the content of the specified template.
 * If locale is 'en', prefer `{id}.en.md` and fall back to `{id}.md`.
 * If locale is 'ja', return `{id}.md`.
 * Returns null if the template is not found.
 */
export function getAgentTemplateContent(
  fs: FileAccessLayer,
  id: string,
  locale: 'ja' | 'en',
): string | null {
  const dir = getTemplatesDir(fs)
  if (!fs.existsSync(dir)) return null

  // ID validation (prevent directory traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null

  if (locale === 'en') {
    // Prefer English version
    const enPath = join(dir, `${id}.en.md`)
    if (fs.existsSync(enPath)) {
      try {
        return fs.readFileSync(enPath, 'utf-8')
      } catch {
        // Fall through to fallback
      }
    }
  }

  // Japanese version (default)
  const jaPath = join(dir, `${id}.md`)
  if (!fs.existsSync(jaPath)) return null

  try {
    return fs.readFileSync(jaPath, 'utf-8')
  } catch {
    return null
  }
}
