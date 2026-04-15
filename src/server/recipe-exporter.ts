/**
 * Recipe exporter — scan app/ directory and generate recipe files.
 */
import { join, extname, relative, dirname } from 'path'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'
import type {
  ArtifactType,
  RecipeMetadata,
  RecipeMenuEntry,
  AppScanResult,
} from '../shared/recipe-types'

/** Infer artifact type from a relative path under app/. */
export function inferArtifactType(relativePath: string): ArtifactType {
  if (relativePath.startsWith('pages/')) return 'page'
  if (relativePath.startsWith('styles/')) return 'style'
  if (relativePath.startsWith('hooks/')) return 'hook'
  if (relativePath.startsWith('utils/')) return 'util'
  return 'lib' // fallback
}

/**
 * Parse app/menu.ts to extract menu entry definitions.
 * Uses regex since the file is TypeScript (cannot JSON.parse).
 * Returns empty array if the file doesn't exist or parsing fails.
 */
export function parseMenuTs(content: string): RecipeMenuEntry[] {
  const entries: RecipeMenuEntry[] = []

  // Match individual object literals in the menuEntries array
  const entryPattern = /\{\s*id:\s*['"]([^'"]+)['"]\s*,\s*label:\s*['"]([^'"]+)['"]\s*,\s*icon:\s*['"]([^'"]+)['"]\s*,\s*component:\s*\(\)\s*=>\s*import\(\s*['"]\.\/([^'"]+)['"]\s*\)/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(content)) !== null) {
    entries.push({
      id: match[1],
      label: match[2],
      icon: match[3],
      page: match[4],
    })
  }

  return entries
}

/**
 * Scan the app/ directory and collect all artifacts + menu entries.
 */
export function scanAppDirectory(fs: FileAccessLayer): AppScanResult {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')

  if (!fs.existsSync(appDir)) {
    return { artifacts: [], menu: [], totalSize: 0 }
  }

  const artifacts: AppScanResult['artifacts'] = []
  let totalSize = 0

  // Recursively scan (simple non-recursive approach for v0.1.0)
  function scanDir(dir: string): void {
    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const relativePath = relative(appDir, fullPath)

      // Skip hidden files, node_modules, api/ directory, menu.ts
      if (entry.startsWith('.') || entry === 'node_modules') continue
      if (relativePath === 'menu.ts' || relativePath === 'menu.tsx') continue
      if (relativePath.startsWith('api/') || relativePath.startsWith('api\\')) continue

      // Detect directory by trying readdirSync (FileStat has no isDirectory)
      let isDir = false
      try {
        fs.readdirSync(fullPath)
        isDir = true
      } catch { /* not a directory */ }

      if (isDir) {
        scanDir(fullPath)
      } else {
        const stat = fs.statSync(fullPath)
        const sizeBytes = stat.size
        artifacts.push({
          path: relativePath,
          type: inferArtifactType(relativePath),
          sizeBytes,
        })
        totalSize += sizeBytes
      }
    }
  }

  scanDir(appDir)

  // Read menu.ts
  let menu: RecipeMenuEntry[] = []
  const menuPath = join(appDir, 'menu.ts')
  if (fs.existsSync(menuPath)) {
    try {
      const menuContent = fs.readFileSync(menuPath, 'utf-8')
      menu = parseMenuTs(menuContent)
    } catch (err) {
      console.warn('[recipe-exporter] Failed to parse app/menu.ts:', err)
    }
  }

  return { artifacts, menu, totalSize }
}

/**
 * Export app/ contents as a directory-format recipe.
 */
export function exportAsDirectory(
  fs: FileAccessLayer,
  scan: AppScanResult,
  metadata: RecipeMetadata,
  outputPath: string,
): void {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')

  // Create output directory
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true })
  }

  // Generate recipe.yaml
  const yaml = buildRecipeYaml(metadata, scan)
  fs.writeFileSync(join(outputPath, 'recipe.yaml'), yaml, 'utf-8')

  // Copy artifact files
  for (const artifact of scan.artifacts) {
    const srcPath = join(appDir, artifact.path)
    const destPath = join(outputPath, artifact.path)
    const destDir = dirname(destPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }
    const content = fs.readFileSync(srcPath, 'utf-8')
    fs.writeFileSync(destPath, content, 'utf-8')
  }
}

/**
 * Export app/ contents as a single Markdown recipe file.
 */
export function exportAsMarkdown(
  fs: FileAccessLayer,
  scan: AppScanResult,
  metadata: RecipeMetadata,
  outputPath: string,
): string {
  const projectRoot = resolveProjectRoot(fs)
  const appDir = join(projectRoot, 'app')

  const sections: string[] = []

  // YAML frontmatter
  sections.push('---')
  sections.push(`name: "${metadata.name}"`)
  sections.push(`description: "${metadata.description}"`)
  sections.push(`version: "${metadata.version}"`)
  if (metadata.author) sections.push(`author: "${metadata.author}"`)
  if (metadata.kovitoboard) sections.push(`kovitoboard: "${metadata.kovitoboard}"`)
  if (metadata.tags && metadata.tags.length > 0) {
    sections.push(`tags: [${metadata.tags.map((t) => `"${t}"`).join(', ')}]`)
  }

  // artifacts field
  sections.push('artifacts:')
  for (const artifact of scan.artifacts) {
    sections.push(`  - path: "${artifact.path}"`)
    sections.push(`    type: "${artifact.type}"`)
  }

  // menu field
  if (scan.menu.length > 0) {
    sections.push('menu:')
    for (const entry of scan.menu) {
      sections.push(`  - id: "${entry.id}"`)
      sections.push(`    label: "${entry.label}"`)
      sections.push(`    icon: "${entry.icon}"`)
      sections.push(`    page: "${entry.page}"`)
    }
  }

  sections.push('---')
  sections.push('')
  sections.push(`# ${metadata.name}`)
  sections.push('')
  sections.push(metadata.description)
  sections.push('')

  // Artifact sections
  for (const artifact of scan.artifacts) {
    const srcPath = join(appDir, artifact.path)
    const content = fs.readFileSync(srcPath, 'utf-8')
    const lang = getLanguageId(artifact.path)

    sections.push(`## artifacts/${artifact.path}`)
    sections.push('')
    sections.push('```' + lang)
    sections.push(content)
    sections.push('```')
    sections.push('')
  }

  const result = sections.join('\n')
  fs.writeFileSync(outputPath, result, 'utf-8')
  return result
}

// --- Helpers ---

function buildRecipeYaml(metadata: RecipeMetadata, scan: AppScanResult): string {
  const lines: string[] = []
  lines.push(`name: "${metadata.name}"`)
  lines.push(`description: "${metadata.description}"`)
  lines.push(`version: "${metadata.version}"`)
  if (metadata.author) lines.push(`author: "${metadata.author}"`)
  if (metadata.kovitoboard) lines.push(`kovitoboard: "${metadata.kovitoboard}"`)
  if (metadata.tags && metadata.tags.length > 0) {
    lines.push(`tags: [${metadata.tags.map((t) => `"${t}"`).join(', ')}]`)
  }
  lines.push('')
  lines.push('artifacts:')
  for (const artifact of scan.artifacts) {
    lines.push(`  - path: "${artifact.path}"`)
    lines.push(`    type: "${artifact.type}"`)
  }
  if (scan.menu.length > 0) {
    lines.push('')
    lines.push('menu:')
    for (const entry of scan.menu) {
      lines.push(`  - id: "${entry.id}"`)
      lines.push(`    label: "${entry.label}"`)
      lines.push(`    icon: "${entry.icon}"`)
      lines.push(`    page: "${entry.page}"`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function getLanguageId(filePath: string): string {
  const ext = extname(filePath)
  switch (ext) {
    case '.tsx': return 'tsx'
    case '.ts': return 'typescript'
    case '.css': return 'css'
    case '.json': return 'json'
    case '.md': return 'markdown'
    default: return ''
  }
}
