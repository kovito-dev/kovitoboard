/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent reference docs installer.
 *
 * Copies bundled agent-ref docs from the KB install directory
 * into <projectRoot>/.kovitoboard/agent-ref/ so that Claude Code
 * agents can read them via relative paths from projectRoot.
 *
 * This replaces the earlier symlink-based approach (POST /api/config/setup-agent-ref)
 * because copies are more robust — symlinks break if the KB install directory moves.
 */
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from './fs-layer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface InstallResult {
  installed: boolean
  reason?: string
}

/**
 * Install agent reference docs into <projectRoot>/.kovitoboard/agent-ref/.
 *
 * - Skips if the destination already exists (respects user edits).
 * - Copies only top-level .md files from the locale-specific source.
 *
 * @param fs          FileAccessLayer instance
 * @param projectRoot Absolute path to the project root
 * @param locale      'ja' or 'en' — selects the source subdirectory
 */
export function installAgentRefDocs(
  fs: FileAccessLayer,
  projectRoot: string,
  locale: 'ja' | 'en'
): InstallResult {
  // Both dev mode (src/server/) and built mode (dist/server/)
  // are two levels below the KB root, so one candidate suffices.
  const kbRoot = resolve(__dirname, '../..')
  const srcBase = join(kbRoot, 'docs', 'agent-ref')

  if (!fs.existsSync(srcBase)) {
    return { installed: false, reason: 'agent-ref source not found in KB install' }
  }

  const destDir = join(projectRoot, '.kovitoboard', 'agent-ref')

  // Already installed — respect user edits
  if (fs.existsSync(destDir)) {
    return { installed: false, reason: 'already exists' }
  }

  // Select locale-specific source directory
  const srcForLocale = locale === 'en' ? join(srcBase, 'en') : srcBase
  if (!fs.existsSync(srcForLocale)) {
    return { installed: false, reason: `locale source not found: ${srcForLocale}` }
  }

  fs.mkdirSync(destDir, { recursive: true })

  // Copy only top-level .md files (skip subdirectories like 'en/')
  const entries = fs.readdirSync(srcForLocale)
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const fullPath = join(srcForLocale, entry)
    try {
      const stat = fs.statSync(fullPath)
      if (stat.size >= 0) {
        // statSync succeeded — it's a file (directories would also pass,
        // but .md extension filter already excludes them in practice)
        const content = fs.readFileSync(fullPath, 'utf-8')
        fs.writeFileSync(join(destDir, entry), content, 'utf-8')
      }
    } catch {
      // Skip entries that cannot be read (e.g. broken symlinks)
      continue
    }
  }

  return { installed: true }
}
