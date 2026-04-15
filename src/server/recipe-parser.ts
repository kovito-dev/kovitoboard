/**
 * Recipe parser — supports both directory format and single-file Markdown format.
 */
import { join, extname, normalize } from 'path'
import { createHash } from 'crypto'
import matter from 'gray-matter'
import type { FileAccessLayer } from './fs-layer'
import type {
  ParsedRecipe,
  RecipeMetadata,
  ArtifactEntry,
  ArtifactWithContent,
  ArtifactType,
  RecipeMenuEntry,
} from '../shared/recipe-types'

const ALLOWED_EXTENSIONS = new Set(['.tsx', '.ts', '.css', '.json', '.md'])
const VALID_ARTIFACT_TYPES = new Set<ArtifactType>(['page', 'style', 'lib', 'hook', 'util'])

/**
 * Parse a recipe from a local file or directory path.
 * Auto-detects format based on whether the source is a directory (with recipe.yaml)
 * or a single .md file.
 */
export function parseRecipe(source: string, fs: FileAccessLayer): ParsedRecipe {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    throw new Error('URL recipe sources are not yet supported in v0.1.0. Please use a local path.')
  }

  if (!fs.existsSync(source)) {
    throw new Error(`Recipe source not found: ${source}`)
  }

  // Detect directory by checking for recipe.yaml inside
  const possibleYaml = join(source, 'recipe.yaml')
  if (fs.existsSync(possibleYaml)) {
    return parseDirectoryRecipe(source, fs)
  }

  if (source.endsWith('.md') || source.endsWith('.markdown')) {
    return parseMarkdownRecipe(source, fs)
  }

  throw new Error(`Unsupported recipe format. Expected a directory with recipe.yaml or a .md file: ${source}`)
}

/**
 * Parse a directory-format recipe.
 * Structure: recipe-name/recipe.yaml + artifact files
 */
function parseDirectoryRecipe(dirPath: string, fs: FileAccessLayer): ParsedRecipe {
  const yamlPath = join(dirPath, 'recipe.yaml')
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`recipe.yaml not found in directory: ${dirPath}`)
  }

  const yamlContent = fs.readFileSync(yamlPath, 'utf-8')
  const { data } = matter(yamlContent)

  const metadata = extractMetadata(data)
  const rawArtifacts: ArtifactEntry[] = extractArtifactEntries(data.artifacts)
  const menu: RecipeMenuEntry[] = extractMenuEntries(data.menu)
  const instruction: string | undefined = typeof data.instruction === 'string' ? data.instruction : undefined

  // Read artifact file contents
  const artifacts: ArtifactWithContent[] = rawArtifacts.map((entry) => {
    const filePath = join(dirPath, entry.path)
    if (!fs.existsSync(filePath)) {
      throw new Error(`Artifact file not found: ${entry.path} (expected at ${filePath})`)
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    return {
      ...entry,
      content,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
    }
  })

  const recipe: ParsedRecipe = {
    metadata,
    artifacts,
    menu,
    instruction,
    hash: '',
    sourceFormat: 'directory',
    sourcePath: dirPath,
  }
  recipe.hash = computeRecipeHash(recipe)
  return recipe
}

/**
 * Parse a single-file Markdown recipe.
 * Structure: YAML frontmatter + ## artifacts/path sections with fenced code blocks
 */
function parseMarkdownRecipe(filePath: string, fs: FileAccessLayer): ParsedRecipe {
  const content = fs.readFileSync(filePath, 'utf-8')
  const { data, content: body } = matter(content)

  const metadata = extractMetadata(data)
  const rawArtifacts: ArtifactEntry[] = extractArtifactEntries(data.artifacts)
  const menu: RecipeMenuEntry[] = extractMenuEntries(data.menu)
  const instruction: string | undefined = typeof data.instruction === 'string' ? data.instruction : undefined

  // Parse artifact contents from markdown body
  const artifactContents = parseArtifactSections(body)
  const artifacts: ArtifactWithContent[] = rawArtifacts.map((entry) => {
    const key = `artifacts/${entry.path}`
    const fileContent = artifactContents.get(key)
    if (fileContent === undefined) {
      throw new Error(`Artifact content not found in markdown body: ## ${key}`)
    }
    return {
      ...entry,
      content: fileContent,
      sizeBytes: Buffer.byteLength(fileContent, 'utf-8'),
    }
  })

  const recipe: ParsedRecipe = {
    metadata,
    artifacts,
    menu,
    instruction,
    hash: '',
    sourceFormat: 'markdown',
    sourcePath: filePath,
  }
  recipe.hash = computeRecipeHash(recipe)
  return recipe
}

/**
 * Extract and validate recipe metadata from YAML data.
 */
function extractMetadata(data: Record<string, unknown>): RecipeMetadata {
  if (typeof data.name !== 'string' || data.name.trim().length === 0) {
    throw new Error('Recipe metadata: "name" is required')
  }
  if (typeof data.description !== 'string' || data.description.trim().length === 0) {
    throw new Error('Recipe metadata: "description" is required')
  }
  if (typeof data.version !== 'string' || data.version.trim().length === 0) {
    throw new Error('Recipe metadata: "version" is required')
  }

  return {
    name: data.name.trim(),
    description: data.description.trim(),
    version: data.version.trim(),
    author: typeof data.author === 'string' ? data.author.trim() : undefined,
    kovitoboard: typeof data.kovitoboard === 'string' ? data.kovitoboard.trim() : undefined,
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : undefined,
  }
}

/**
 * Extract and validate artifact entries from YAML data.
 */
function extractArtifactEntries(artifacts: unknown): ArtifactEntry[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('Recipe must have at least one artifact')
  }

  return artifacts.map((a, i) => {
    if (typeof a !== 'object' || a === null) {
      throw new Error(`Artifact ${i}: must be an object`)
    }
    const entry = a as Record<string, unknown>
    if (typeof entry.path !== 'string') {
      throw new Error(`Artifact ${i}: "path" is required`)
    }
    if (typeof entry.type !== 'string' || !VALID_ARTIFACT_TYPES.has(entry.type as ArtifactType)) {
      throw new Error(`Artifact ${i}: "type" must be one of: ${[...VALID_ARTIFACT_TYPES].join(', ')}`)
    }

    const normalizedPath = normalize(entry.path)
    const ext = extname(normalizedPath)
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`Artifact ${i}: extension "${ext}" is not allowed (${[...ALLOWED_EXTENSIONS].join(', ')})`)
    }

    return {
      path: normalizedPath,
      type: entry.type as ArtifactType,
    }
  })
}

/**
 * Extract menu entries from YAML data (optional field).
 */
function extractMenuEntries(menu: unknown): RecipeMenuEntry[] {
  if (!Array.isArray(menu)) return []

  return menu
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m, i) => {
      if (typeof m.id !== 'string') throw new Error(`Menu entry ${i}: "id" is required`)
      if (typeof m.label !== 'string') throw new Error(`Menu entry ${i}: "label" is required`)
      return {
        id: m.id,
        label: m.label,
        icon: typeof m.icon === 'string' ? m.icon : 'folder',
        page: typeof m.page === 'string' ? m.page : '',
      }
    })
}

/**
 * Parse artifact sections from markdown body.
 * Looks for `## artifacts/path/file.ext` headings followed by fenced code blocks.
 */
function parseArtifactSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  // Match ## artifacts/... headings
  const headingPattern = /^## (artifacts\/\S+)\s*$/gm
  const matches: Array<{ key: string; index: number }> = []

  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(body)) !== null) {
    matches.push({ key: match[1], index: match.index + match[0].length })
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index - `## ${matches[i + 1].key}`.length : body.length
    const sectionBody = body.slice(start, end)

    // Extract content from fenced code block
    const codeMatch = sectionBody.match(/```\w*\n([\s\S]*?)```/)
    if (codeMatch) {
      sections.set(matches[i].key, codeMatch[1].trimEnd())
    }
  }

  return sections
}

/**
 * Compute SHA-256 hash of recipe content for integrity/history tracking.
 */
export function computeRecipeHash(recipe: Pick<ParsedRecipe, 'metadata' | 'artifacts'>): string {
  const canonical = JSON.stringify({
    name: recipe.metadata.name,
    version: recipe.metadata.version,
    artifacts: recipe.artifacts
      .map((a) => ({ path: a.path, content: a.content }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}
