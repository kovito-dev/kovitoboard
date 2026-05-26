/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe parser — supports both directory format and single-file Markdown format.
 */
import { join, extname, normalize, posix as pathPosix, win32 as pathWin32, sep } from 'path'
import { createHash } from 'crypto'
import { safeMatter as matter } from './recipe/safe-matter'
import type { FileAccessLayer } from './fs-layer'
import { recipeLogger } from './logger'
import type {
  ParsedRecipe,
  RecipeMetadata,
  RecipeApiSection,
  RecipeCaptureSection,
  CaptureKindValue,
  ArtifactEntry,
  ArtifactWithContent,
  ArtifactType,
  RecipeMenuEntry,
} from '../shared/recipe-types'
import { CAPTURE_KIND_VALUES } from '../shared/recipe-types'
import {
  MAX_RECIPE_YAML_BYTES,
  MAX_RECIPE_TOTAL_BYTES,
  MAX_RECIPE_ARTIFACTS,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_RECIPE_ID_LENGTH,
  MAX_RECIPE_NAME_LENGTH,
  MAX_INSTRUCTION_BYTES,
  MAX_PERMISSION_ENTRIES,
} from '../shared/security-limits'
import { validateApiSection, parseApiSection } from './recipe/apiTypes.js'

const ALLOWED_EXTENSIONS = new Set(['.tsx', '.ts', '.css', '.json', '.md'])
const VALID_ARTIFACT_TYPES = new Set<ArtifactType>(['page', 'style', 'lib', 'hook', 'util'])

/**
 * Structured context captured when an external input exceeds one of
 * the security-limits boundaries enforced at parser entry. The route
 * layer reads `httpStatus` to decide between 413 (size overflow) and
 * 400 (count / length overflow).
 *
 * @see docs/specs/security-limits.md (kovitoboard-dev) v1.1 §5.1 / §6.2
 */
export interface RecipeParseErrorContext {
  /** Limit identifier (e.g. `MAX_RECIPE_YAML_BYTES`). */
  limit: string
  /** Configured ceiling. */
  limitValue: number
  /** Observed value that breached the ceiling. */
  actualValue: number
  /** HTTP status the route layer should map this error to. */
  httpStatus: 413 | 400
  /** Recipe identifier when known at the point of detection. */
  recipeId?: string
}

/**
 * Thrown when the parser refuses an input because it would exceed a
 * security-limits boundary. The route layer translates this into a
 * generic 413 / 400 response (no path leakage per spec §6.2).
 *
 * Distinct from the legacy `Error` instances thrown by the recipe
 * metadata / artifact shape checks so the route layer can branch on
 * `err instanceof RecipeParseError` without string-matching messages.
 */
export class RecipeParseError extends Error {
  readonly code = 'RECIPE_PARSE_LIMIT_EXCEEDED'
  readonly context: RecipeParseErrorContext

  constructor(context: RecipeParseErrorContext, message?: string) {
    super(
      message ??
        `${context.limit} exceeded (limit=${context.limitValue}, actual=${context.actualValue})`,
    )
    this.name = 'RecipeParseError'
    this.context = context
  }
}

/**
 * Centralized limit check + structured warn log. Keeps every call
 * site identical so the post-mortem log fields stay uniform and
 * routes can rely on a single error type.
 */
function checkParserLimit(opts: {
  limit: string
  limitValue: number
  actualValue: number
  httpStatus: 413 | 400
  recipeId?: string
  extraFields?: Record<string, unknown>
}): void {
  if (opts.actualValue <= opts.limitValue) return
  recipeLogger.warn(
    {
      ...(opts.recipeId ? { recipeId: opts.recipeId } : {}),
      ...(opts.extraFields ?? {}),
      limit: opts.limit,
      limitValue: opts.limitValue,
      actualValue: opts.actualValue,
    },
    'recipe input exceeded limit',
  )
  throw new RecipeParseError({
    limit: opts.limit,
    limitValue: opts.limitValue,
    actualValue: opts.actualValue,
    httpStatus: opts.httpStatus,
    recipeId: opts.recipeId,
  })
}

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

  // L-R1: reject oversized recipe.yaml on stat metadata BEFORE
  // readFileSync materializes the file into a Node string. Without
  // this, a hostile 1 GiB recipe.yaml would be fully decoded into
  // memory before the ceiling check fires — the OOM path the limit
  // is supposed to close. gray-matter / js-yaml would then re-walk
  // that same string and allocate a YAML AST on top.
  const yamlStat = fs.statSync(yamlPath)
  checkParserLimit({
    limit: 'MAX_RECIPE_YAML_BYTES',
    limitValue: MAX_RECIPE_YAML_BYTES,
    actualValue: yamlStat.size,
    httpStatus: 413,
    extraFields: { sourcePath: dirPath },
  })

  const yamlContent = fs.readFileSync(yamlPath, 'utf-8')
  // Decoded byte count (utf-8 round-trip matches `yamlStat.size`
  // for well-formed inputs); used below to seed the cumulative
  // total-byte counter for L-R2.
  const yamlBytes = Buffer.byteLength(yamlContent, 'utf-8')

  const { data } = matter(yamlContent)

  rejectAuthorTrustLevel(data, dirPath)

  const metadata = extractMetadata(data)
  const rawArtifacts: ArtifactEntry[] = extractArtifactEntries(data.artifacts, metadata.recipeId)
  const menu: RecipeMenuEntry[] = extractMenuEntries(data.menu)
  const instruction: string | undefined = typeof data.instruction === 'string' ? data.instruction : undefined
  if (instruction !== undefined) {
    checkInstructionLength(instruction, metadata.recipeId)
  }
  const api = extractApiSection(data.api, metadata.recipeId)
  const capture = extractCaptureSection(data.capture, metadata.recipeId)

  // Read artifact file contents. We stat each file BEFORE reading
  // so an oversized artifact never gets pulled into memory — the
  // L-R4 / L-R2 ceilings reject from stat metadata first, then
  // readFileSync runs only on the already-bounded subset. Without
  // the stat-first ordering the parser would still materialize a
  // hostile artifact body before checking the byte count, which is
  // the OOM path the limits are supposed to close.
  // Canonicalise the recipe directory once so the per-artifact
  // containment check below compares like-with-like. `realpath`
  // failure on the directory itself is treated as a parse error —
  // we already opened the YAML through `fs.readFileSync` further
  // up, so a broken `dirPath` at this point is a programmer bug,
  // not a recipe authoring mistake.
  const canonicalDir = fs.realpathSync(dirPath)

  let totalBytes = yamlBytes
  const artifacts: ArtifactWithContent[] = rawArtifacts.map((entry) => {
    const filePath = join(dirPath, entry.path)
    if (!fs.existsSync(filePath)) {
      throw new Error(`Artifact file not found: ${entry.path} (expected at ${filePath})`)
    }
    // Final containment check (supplementary review §S3 step 3):
    // even when `entry.path` itself contains no `..` segments, a
    // symlink inside the recipe directory can still redirect to an
    // arbitrary project file. `realpath` resolves every symlink in
    // the resolved chain so the comparison reflects the actual
    // on-disk target, not the lexical path. The check runs BEFORE
    // `statSync` / `readFileSync` so a hostile artifact body never
    // reaches the bounded reader at all.
    const canonicalFile = fs.realpathSync(filePath)
    if (!isPathWithin(canonicalFile, canonicalDir)) {
      throw new Error(
        `Artifact ${entry.path}: resolves outside the recipe directory`,
      )
    }
    // Run `statSync` + `readFileSync` against the canonical target
    // rather than the lexical pathname. This narrows the
    // observation window: a swap on the lexical `filePath` alone
    // (the entry pointed at by `recipe.yaml`) no longer redirects
    // the bounded reader, because the canonical path captured here
    // has already been resolved end-to-end. This does NOT close
    // the broader TOCTOU race against the canonical target itself
    // — an attacker who can write to the resolved file between the
    // `realpath` call here and the `readFileSync` below can still
    // redirect the read by mutating the resolved entry. Closing
    // that wider race requires an fd-based open/fstat/read pipeline,
    // which is a parser-wide I/O refactor and is intentionally out
    // of scope for this PR (see PR description `## Out of Scope`).
    // The recipe-parser threat model in v0.2.x assumes the recipe
    // upload directory is staged by KovitoBoard itself prior to
    // parsing, so a concurrent attacker cannot reach the canonical
    // entries during the parse window; this hardening is defence
    // in depth on top of that staging guarantee.
    const stat = fs.statSync(canonicalFile)
    // L-R4: per-file ceiling, checked on stat metadata so an
    // oversized artifact never reaches readFileSync.
    checkParserLimit({
      limit: 'MAX_ARTIFACT_FILE_BYTES',
      limitValue: MAX_ARTIFACT_FILE_BYTES,
      actualValue: stat.size,
      httpStatus: 413,
      recipeId: metadata.recipeId,
      extraFields: { artifactPath: entry.path },
    })
    // L-R2: cumulative total from stat metadata so a wide tree of
    // many medium-sized artifacts cannot drain the walk before the
    // running total trips the cap.
    checkParserLimit({
      limit: 'MAX_RECIPE_TOTAL_BYTES',
      limitValue: MAX_RECIPE_TOTAL_BYTES,
      actualValue: totalBytes + stat.size,
      httpStatus: 413,
      recipeId: metadata.recipeId,
      extraFields: { artifactPath: entry.path },
    })
    totalBytes += stat.size
    const content = fs.readFileSync(canonicalFile, 'utf-8')
    // utf-8 round-trip: `Buffer.byteLength(content, 'utf-8')`
    // matches `stat.size` for every well-formed input. We surface
    // the decoded count to keep the historical contract on
    // ArtifactWithContent.sizeBytes; the DoS enforcement above
    // already used the on-disk size as the source of truth.
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
    capture,
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
  // L-R2: the .md envelope holds yaml + inline artifact bodies, so
  // the file total is the meaningful ceiling here (spec §5.1 row
  // L-R2 explicitly names the Markdown file). L-R1 is
  // directory-only and does not apply to .md recipes. Checked on
  // stat metadata BEFORE readFileSync so a hostile multi-GiB .md
  // recipe never lands in memory.
  const stat = fs.statSync(filePath)
  checkParserLimit({
    limit: 'MAX_RECIPE_TOTAL_BYTES',
    limitValue: MAX_RECIPE_TOTAL_BYTES,
    actualValue: stat.size,
    httpStatus: 413,
    extraFields: { sourcePath: filePath },
  })

  const content = fs.readFileSync(filePath, 'utf-8')

  const { data, content: body } = matter(content)

  rejectAuthorTrustLevel(data, filePath)

  const metadata = extractMetadata(data)
  const rawArtifacts: ArtifactEntry[] = extractArtifactEntries(data.artifacts, metadata.recipeId)
  const menu: RecipeMenuEntry[] = extractMenuEntries(data.menu)
  const instruction: string | undefined = typeof data.instruction === 'string' ? data.instruction : undefined
  if (instruction !== undefined) {
    checkInstructionLength(instruction, metadata.recipeId)
  }
  const api = extractApiSection(data.api, metadata.recipeId)
  const capture = extractCaptureSection(data.capture, metadata.recipeId)

  // Parse artifact contents from markdown body
  const artifactContents = parseArtifactSections(body)
  const artifacts: ArtifactWithContent[] = rawArtifacts.map((entry) => {
    const key = `artifacts/${entry.path}`
    const fileContent = artifactContents.get(key)
    if (fileContent === undefined) {
      throw new Error(`Artifact content not found in markdown body: ## ${key}`)
    }
    const sizeBytes = Buffer.byteLength(fileContent, 'utf-8')
    // L-R4: per-file ceiling. L-R2 already passed on the envelope,
    // but a single oversized inline artifact still needs explicit
    // rejection so the route layer can emit a precise log line.
    checkParserLimit({
      limit: 'MAX_ARTIFACT_FILE_BYTES',
      limitValue: MAX_ARTIFACT_FILE_BYTES,
      actualValue: sizeBytes,
      httpStatus: 413,
      recipeId: metadata.recipeId,
      extraFields: { artifactPath: entry.path },
    })
    return {
      ...entry,
      content: fileContent,
      sizeBytes,
    }
  })

  const recipe: ParsedRecipe = {
    metadata,
    artifacts,
    menu,
    instruction,
    api,
    capture,
    hash: '',
    sourceFormat: 'markdown',
    sourcePath: filePath,
  }
  recipe.hash = computeRecipeHash(recipe)
  return recipe
}

/**
 * Reject `trustLevel` declarations from author-controlled recipe YAML.
 *
 * Defense against T-3-1 (trust marker forgery) from the trust-marker
 * handoff v1.1 §8.2: a malicious or honest-but-mistaken recipe author
 * must not be able to write `trustLevel: 'code-trusted'` (or any
 * other value) into `recipe.yaml` and have the trust-marker UI
 * present the recipe as authority-verified. The authoritative source
 * of `RecipeManifest.trustLevel` is server-controlled: KovitoHub
 * signature verification (v0.3.0 → `'code-trusted'`), developer
 * sideload assignment (v0.3.0 → `'code-trusted (sideloaded)'`), or
 * grandfather migration (v0.2.x → `'unknown'`). The parser closes
 * the front door by failing fast on any author-written declaration.
 *
 * @see recipe-system.md v1.4 §6.10.3 (RecipeManifest.trustLevel)
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §8.2 (T-3-1)
 */
function rejectAuthorTrustLevel(data: Record<string, unknown>, sourcePath: string): void {
  if (!Object.prototype.hasOwnProperty.call(data, 'trustLevel')) return
  // The forbidden field is fully attacker-controlled (it came out of
  // `gray-matter`'s YAML decode of the recipe file). Logging the raw
  // value would let a hostile recipe smuggle arbitrary content into
  // operator log files or inflate the log line itself; the violation
  // itself is the diagnostic signal, not the chosen literal.
  recipeLogger.warn(
    { sourcePath, declaredType: typeof data.trustLevel },
    'recipe.yaml declared a trustLevel field; rejecting (trust marker forgery defence). ' +
      'trustLevel is server-assigned (KovitoHub signature / sideload / grandfather migration) — ' +
      'authors must not declare it in recipe.yaml.',
  )
  throw new Error(
    'recipe.yaml must not declare "trustLevel": this field is server-assigned ' +
      '(via KovitoHub signature verification, developer sideload, or grandfather ' +
      'migration). Remove it and let the install path assign the value.',
  )
}

/** Format constraint for `recipeId` (DEC-024 D-8 / spec §3.3). */
const RECIPE_ID_PATTERN = /^[A-Za-z0-9_\-./@]+$/

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
  // L-R7: cap on name length. Applied before the rest of the
  // metadata pipeline so an oversized name never reaches log lines
  // or UI hints unredacted. `data.name.length` counts UTF-16 code
  // units (JavaScript's native String length), not Unicode code
  // points or grapheme clusters — a name made entirely of astral
  // characters (e.g. emoji) therefore admits ~64 visible characters
  // before tripping the 128 limit. The byte / memory cost of the
  // string scales with code units, so the UTF-16 unit count is the
  // right axis for the DoS-resistance ceiling.
  checkParserLimit({
    limit: 'MAX_RECIPE_NAME_LENGTH',
    limitValue: MAX_RECIPE_NAME_LENGTH,
    actualValue: data.name.length,
    httpStatus: 400,
  })
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
  // L-R5: recipeId length ceiling (security-limits v1.1 — tightened
  // from the legacy 256-char check that lived inline before the
  // SSOT migration). Applied AFTER both branches resolve so the
  // synthesized fallback id (`deriveRecipeIdFromName(name)`) is
  // gated by the same ceiling as an explicit `recipeId` from the
  // recipe.yaml — without this, a 128-char `name` could produce a
  // 128-char fallback id that bypasses L-R5 entirely.
  // We intentionally do NOT attach the raw recipeId to the warn
  // record: a hostile recipe.yaml could put a 500 KiB recipeId in
  // (still inside the L-R1 yaml cap), and echoing the full string
  // into the log line would re-introduce the attacker-driven log
  // amplification path the L-R5 check is supposed to close. The
  // `actualValue` (length) alone is enough for operators to triage.
  checkParserLimit({
    limit: 'MAX_RECIPE_ID_LENGTH',
    limitValue: MAX_RECIPE_ID_LENGTH,
    actualValue: recipeId.length,
    httpStatus: 400,
  })

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
function extractArtifactEntries(
  artifacts: unknown,
  recipeId?: string,
): ArtifactEntry[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('Recipe must have at least one artifact')
  }
  // L-R3: cap on artifact entry count.
  checkParserLimit({
    limit: 'MAX_RECIPE_ARTIFACTS',
    limitValue: MAX_RECIPE_ARTIFACTS,
    actualValue: artifacts.length,
    httpStatus: 400,
    recipeId,
  })

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

    // Reject path escapes at the YAML-parse entry so a malicious
    // recipe cannot pull arbitrary project files into
    // `artifact.content` (supplementary review §S3 / recipe
    // artifact-path traversal). Three independent gates are needed
    // because `normalize` preserves `..` segments and a
    // `join(dirPath, '../../.env')` would otherwise resolve outside
    // the recipe directory:
    //
    //   1. Absolute paths (`/etc/passwd`, `C:\\...`) — a directory
    //      recipe's artifacts are always relative to the recipe
    //      directory; an absolute path is a structural rejection.
    //   2. Any path component that normalizes to `..` — this catches
    //      both leading `..` (`../../.env`) and interior `..` after
    //      a long prefix (`a/../../b`). Checking only the normalized
    //      string with `startsWith('../')` would miss the leading
    //      `./` form on Windows separators, so we split on both
    //      POSIX and Windows separators and reject any `..` segment
    //      regardless of position.
    //   3. The directory parser also runs a `realpath` containment
    //      check on the joined path before any `fs.readFileSync` —
    //      that final gate closes the symlink-escape variant where
    //      `entry.path` itself contains no `..`.
    // Reject empty / whitespace-only paths up front. Without this
    // guard `normalize('')` collapses to `'.'`, which represents the
    // recipe directory itself and would otherwise be read as if it
    // were an artifact file, leaving a regular-file mismatch to fall
    // out of `fs.readFileSync` as an opaque OS error.
    if (entry.path.trim() === '') {
      throw new Error(`Artifact ${i}: "path" must not be empty`)
    }
    // Check both POSIX and Windows absolute-path shapes regardless
    // of host platform. `path.isAbsolute()` is host-dependent, so on
    // a Linux deployment it would not flag `C:\\secret.txt` or
    // `\\\\server\\share\\x`. Recipes are portable artifacts that
    // may be authored on any OS, so the absolute-path rejection
    // must agree on every host.
    if (pathPosix.isAbsolute(entry.path) || pathWin32.isAbsolute(entry.path)) {
      throw new Error(`Artifact ${i}: "path" must be a relative path inside the recipe directory`)
    }
    const normalizedPath = normalize(entry.path)
    // An input like `'.'`, `'./'`, or `'.\\'` represents the recipe
    // directory itself rather than a file inside it. `normalize`
    // keeps the trailing separator on `'./'` (POSIX) and `'.\\'`
    // (Windows), so strip a trailing slash before comparing. Reject
    // here so the parser fails with a deterministic validation
    // message instead of the downstream `readFileSync`
    // ENOENT/EISDIR surface.
    const strippedTail = normalizedPath.replace(/[/\\]+$/, '')
    if (strippedTail === '.' || strippedTail === '') {
      throw new Error(`Artifact ${i}: "path" must point to a file inside the recipe directory`)
    }
    const segments = normalizedPath.split(/[/\\]/)
    if (segments.some((segment) => segment === '..')) {
      throw new Error(`Artifact ${i}: "path" must not contain ".." segments`)
    }
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
 * Test whether `child` resolves to `parent` itself or a path strictly
 * inside `parent`. Both arguments must already be canonicalised via
 * `realpath` — this helper does not normalise separators or follow
 * symlinks. Used by `parseDirectoryRecipe` to confirm that each
 * artifact file lands inside the recipe directory even after
 * symlinks are resolved.
 */
function isPathWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(parentWithSep)
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
 * Extract and validate the optional `capture:` block from YAML data.
 *
 * Returns `undefined` when the recipe does not declare any capture
 * requirement. When present the block MUST shape as
 *
 *   capture:
 *     requires:
 *       - a11y
 *       - exposed-context
 *
 * with `requires` being a non-empty array whose entries belong to the
 * closed {@link CAPTURE_KIND_VALUES} enum. Any deviation throws so the
 * upload route returns a 400 rather than silently accepting a recipe
 * the runtime guard cannot honour.
 *
 * @see recipe-system.md v1.4 §6.10.1
 */
function extractCaptureSection(
  captureData: unknown,
  recipeId?: string,
): RecipeCaptureSection | undefined {
  if (captureData === undefined || captureData === null) {
    return undefined // capture: not specified is allowed (no capture API in use)
  }

  if (typeof captureData !== 'object' || Array.isArray(captureData)) {
    throw new Error('Invalid capture section: capture must be an object')
  }

  const obj = captureData as Record<string, unknown>
  const rawRequires = obj.requires

  if (rawRequires === undefined || rawRequires === null) {
    throw new Error('Invalid capture section: capture.requires is required when capture is declared')
  }
  if (!Array.isArray(rawRequires)) {
    throw new Error('Invalid capture section: capture.requires must be an array')
  }

  // Empty array means "the section is declared but no kinds are
  // requested". Treat it as a parse error: an empty section conveys no
  // information and is almost always a recipe-authoring mistake. The
  // recipe author should omit the `capture:` block entirely instead.
  if (rawRequires.length === 0) {
    throw new Error('Invalid capture section: capture.requires must not be empty')
  }

  // Bound the size of the array so a recipe cannot dump a huge list of
  // duplicates / invalid strings before the per-entry check runs. The
  // closed enum has only two members today; 16 leaves comfortable
  // headroom for the values v0.3.0 might add without admitting an
  // unbounded list. We keep the ceiling tight rather than reusing
  // MAX_PERMISSION_ENTRIES (which is sized for scope lists) because
  // the kind enum and the scope enum evolve independently.
  const MAX_CAPTURE_ENTRIES = 16
  if (rawRequires.length > MAX_CAPTURE_ENTRIES) {
    throw new Error(
      `Invalid capture section: capture.requires must contain at most ${MAX_CAPTURE_ENTRIES} entries ` +
        `(got ${rawRequires.length})`,
    )
  }

  const seen = new Set<CaptureKindValue>()
  const requires: CaptureKindValue[] = []
  for (let i = 0; i < rawRequires.length; i++) {
    const entry = rawRequires[i]
    if (typeof entry !== 'string') {
      throw new Error(
        `Invalid capture section: capture.requires[${i}] must be a string`,
      )
    }
    if (!(CAPTURE_KIND_VALUES as readonly string[]).includes(entry)) {
      throw new Error(
        `Invalid capture section: capture.requires[${i}] "${entry}" is not a valid capture kind ` +
          `(allowed: ${CAPTURE_KIND_VALUES.join(', ')})`,
      )
    }
    const kind = entry as CaptureKindValue
    if (seen.has(kind)) {
      // Duplicates carry no extra meaning at the runtime guard layer
      // but would inflate the install-warning UI with phantom rows.
      // Reject so the recipe author has to clean the list up.
      throw new Error(
        `Invalid capture section: capture.requires[${i}] "${entry}" is duplicated`,
      )
    }
    seen.add(kind)
    requires.push(kind)
  }

  // recipeId is captured here as a parameter so future limit-style
  // checks (e.g. logging the offending recipe) match the rest of the
  // parser's error shape. Today no limit-style check applies, but
  // keeping the signature consistent avoids a churny diff later.
  void recipeId
  return { requires }
}

/**
 * Extract and validate the api: section from YAML data (optional field).
 *
 * Returns undefined if the api: section is not present.
 * Throws an error if present but invalid.
 *
 * @see recipe-system.md §12-4-1 (block conditions)
 */
function extractApiSection(
  apiData: unknown,
  recipeId?: string,
): RecipeApiSection | undefined {
  if (apiData === undefined || apiData === null) {
    return undefined // api: not specified is allowed (recipe without handlers)
  }

  // L-R9: cap on declared permission entries. Run before the shape
  // validator so a scope-flood payload is rejected before any
  // per-entry walk.
  if (apiData !== null && typeof apiData === 'object' && !Array.isArray(apiData)) {
    const maybeScopes = (apiData as Record<string, unknown>).scopes
    if (Array.isArray(maybeScopes)) {
      checkParserLimit({
        limit: 'MAX_PERMISSION_ENTRIES',
        limitValue: MAX_PERMISSION_ENTRIES,
        actualValue: maybeScopes.length,
        httpStatus: 400,
        recipeId,
      })
    }
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
 * L-R8: cap on `recipe.instruction` body. Extracted so the same
 * limit check applies to both directory and Markdown recipe formats.
 */
function checkInstructionLength(instruction: string, recipeId?: string): void {
  const bytes = Buffer.byteLength(instruction, 'utf-8')
  checkParserLimit({
    limit: 'MAX_INSTRUCTION_BYTES',
    limitValue: MAX_INSTRUCTION_BYTES,
    actualValue: bytes,
    httpStatus: 413,
    recipeId,
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
