/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe parser — supports both directory format and single-file Markdown format.
 */
import { join, extname, normalize } from 'path'
import { createHash } from 'crypto'
import matter from 'gray-matter'
import type { FileAccessLayer } from './fs-layer'
import { recipeLogger } from './logger'
import type {
  ParsedRecipe,
  RecipeMetadata,
  RecipeApiSection,
  ArtifactEntry,
  ArtifactWithContent,
  ArtifactType,
  RecipeMenuEntry,
} from '../shared/recipe-types'
import { validateApiSection, parseApiSection } from './recipe/apiTypes.js'

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
  const api = extractApiSection(data.api)

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
    api,
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
  const api = extractApiSection(data.api)

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
    api,
    hash: '',
    sourceFormat: 'markdown',
    sourcePath: filePath,
  }
  recipe.hash = computeRecipeHash(recipe)
  return recipe
}

/** Format constraint for `recipeId` (DEC-024 D-8 / spec §3.3). */
const RECIPE_ID_PATTERN = /^[A-Za-z0-9_\-./@]+$/
const RECIPE_ID_MAX_LENGTH = 256

/**
 * Synthesize a `recipeId` from the recipe name when the YAML omits
 * the field. Kebab-case the ASCII letters/digits, collapse runs of
 * separators, and emit the placeholder `'recipe'` when the name has
 * no ASCII characters (e.g. a Japanese-only name) so we never
 * return an empty string. The placeholder is rare in practice
 * because the `recipeId` field becomes a parse error in v0.2.0; the
 * fallback exists strictly to keep v0.1.x recipes that predate the
 * field readable.
 */
export function deriveRecipeIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'recipe'
}

/**
 * Extract and validate recipe metadata from YAML data.
 *
 * `recipeId` handling (Phase A scaffolding; full warn-logging /
 * error wording lands in Phase B):
 *   - When present and valid → used verbatim.
 *   - When present but malformed → throws so the recipe is rejected
 *     before it can be persisted with an unsafe identifier.
 *   - When absent → falls back to `kebab-case(name)` to keep
 *     pre-DEC-024 v1.x recipes parseable; the v0.2.0 plan is to
 *     turn this into a parse error.
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

  let recipeId: string
  if (typeof data.recipeId === 'string' && data.recipeId.length > 0) {
    if (!RECIPE_ID_PATTERN.test(data.recipeId)) {
      throw new Error(
        `Recipe metadata: "recipeId" has invalid characters. ` +
        `Allowed: letters, digits, "_", "-", ".", "/", "@".`,
      )
    }
    if (data.recipeId.length > RECIPE_ID_MAX_LENGTH) {
      throw new Error(
        `Recipe metadata: "recipeId" is too long ` +
        `(${data.recipeId.length} chars; max ${RECIPE_ID_MAX_LENGTH}).`,
      )
    }
    recipeId = data.recipeId
  } else {
    // v0.1.x backward-compat fallback. The recipe omitted
    // `recipeId`, so we synthesize one from `name` to keep the
    // parser usable until v0.2.0 turns this branch into a parse
    // error. We emit a warn line so the omission surfaces in the
    // server log even though the parse itself succeeds — this is
    // the signal recipe authors need to fix their YAML before
    // v0.2.0 ships.
    recipeId = deriveRecipeIdFromName(data.name)
    recipeLogger.warn(
      { fallbackRecipeId: recipeId, name: data.name },
      'recipe.yaml does not declare `recipeId`; falling back to ' +
      'kebab-case(name). This fallback will be removed in v0.2.0 — ' +
      'please add an explicit `recipeId` field.',
    )
  }

  return {
    recipeId,
    name: data.name.trim(),
    description: data.description.trim(),
    version: data.version.trim(),
    author: typeof data.author === 'string' ? data.author.trim() : undefined,
    kovitoboard: typeof data.kovitoboard === 'string' ? data.kovitoboard.trim() : undefined,
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : undefined,
    i18n: extractI18nOverrides(data.i18n),
  }
}

/**
 * Pick out the optional `i18n` map from raw YAML.
 *
 * Shape: `{ <locale>: { name?: string; description?: string } }`. The
 * renderer uses these to override the top-level Japanese-default
 * `name` / `description` for non-default locales. Anything that does
 * not look like the expected shape is dropped silently — recipes
 * authored before this field existed continue to work (the renderer
 * just falls back to the top-level fields).
 */
function extractI18nOverrides(
  raw: unknown,
): Record<string, { name?: string; description?: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, { name?: string; description?: string }> = {}
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : undefined
    const description =
      typeof entry.description === 'string' ? entry.description.trim() : undefined
    if (!name && !description) continue
    out[locale] = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
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
 * Extract and validate the api: section from YAML data (optional field).
 *
 * Returns undefined if the api: section is not present.
 * Throws an error if present but invalid.
 *
 * @see recipe-system.md §12-4-1 (block conditions)
 */
function extractApiSection(apiData: unknown): RecipeApiSection | undefined {
  if (apiData === undefined || apiData === null) {
    return undefined // api: not specified is allowed (recipe without handlers)
  }

  const validationError = validateApiSection(apiData)
  if (validationError) {
    throw new Error(`Invalid api section: ${validationError}`)
  }

  const parsed = parseApiSection(apiData as Record<string, unknown>)
  return {
    scopes: parsed.scopes as string[],
    calls: parsed.calls.map((c) => ({
      id: c.id,
      handler: c.handler as string,
      args: c.args,
    })),
  }
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
