/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent creation and update logic.
 *
 * - createAgentFromTemplate: Create a new agent from a template
 * - createAgentFromScratch: Create a new agent from raw user-supplied
 *   metadata (no template; AA-3 scope)
 * - updateAgentSections: Partially update structured fields of an existing agent
 */

import { serverLogger } from './logger'
import { join } from 'path'
import matter from 'gray-matter'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'
import { getAgentTemplateContent } from './template-reader'

/** Options for createAgentFromTemplate */
export interface CreateAgentOptions {
  /** Template ID (e.g. "kovito-concierge") */
  templateId: string
  /** Agent ID (used as filename, e.g. "my-agent") */
  agentId: string
  /** Display name (set in frontmatter displayName) */
  displayName?: string
  /** Locale */
  locale?: 'ja' | 'en'
  /** Customization values for structured fields */
  customizations?: {
    personality?: string
    toneSample?: string
    extraInstructions?: string
  }
}

/** Return value of createAgentFromTemplate */
export interface CreateAgentResult {
  success: boolean
  /** Absolute path of the created file */
  filePath?: string
  error?: string
}

/** Validate an agent ID */
export function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && id.length <= 64
}

/**
 * Create an agent definition file from a template.
 *
 * Flow:
 * 1. Load the template
 * 2. Replace markers (if customization values are provided)
 * 3. Add displayName to frontmatter if specified
 * 4. Write to .claude/agents/{agentId}.md
 * 5. Create .claude/agents/ if it does not exist
 */
export function createAgentFromTemplate(
  fs: FileAccessLayer,
  options: CreateAgentOptions,
): CreateAgentResult {
  const { templateId, agentId, displayName, locale = 'ja', customizations } = options

  // Validation
  if (!isValidAgentId(agentId)) {
    return { success: false, error: 'Invalid agent ID. Use alphanumeric, hyphens, underscores (max 64 chars).' }
  }

  // Load template
  const templateContent = getAgentTemplateContent(fs, templateId, locale)
  if (!templateContent) {
    return { success: false, error: `Template not found: ${templateId}` }
  }

  // Separate frontmatter and body
  const { data: frontmatterData, content: bodyContent } = matter(templateContent)

  // Add displayName to frontmatter
  if (displayName) {
    frontmatterData.displayName = displayName
  }

  // Marker-based replacement
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

  // Rebuild frontmatter
  const finalContent = matter.stringify(processedBody, frontmatterData)

  // Ensure .claude/agents/ directory exists
  const projectRoot = resolveProjectRoot(fs)
  const agentsDir = join(projectRoot, '.claude', 'agents')
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }

  // Check if a file with the same name already exists
  const filePath = join(agentsDir, `${agentId}.md`)
  if (fs.existsSync(filePath)) {
    return { success: false, error: `Agent already exists: ${agentId}` }
  }

  // Write to file
  try {
    fs.writeFileSync(filePath, finalContent, 'utf-8')
    return { success: true, filePath }
  } catch (err) {
    serverLogger.error({ err }, '[agent-writer] Failed to write agent file:')
    return { success: false, error: 'Failed to write agent file' }
  }
}

/**
 * AA-3: options for `createAgentFromScratch`. Mirrors the editable
 * fields exposed by AD-3's `StructuredFieldEditor` so the create
 * path covers the same metadata an existing agent can be edited
 * to. Markers (`KB:PERSONALITY` / `KB:TONE_SAMPLE` /
 * `KB:EXTRA_INSTRUCTIONS`) are *not* injected on scratch creation —
 * the user can opt in later via AD-2's inject-markers banner.
 */
export interface CreateScratchAgentOptions {
  /** Agent ID (used as filename, e.g. "my-agent"). */
  agentId: string
  /** Display name written into the frontmatter. */
  displayName: string
  /**
   * Frontmatter `description`. Empty string is rejected — AD-3 makes
   * this optional on edit, but a from-scratch agent without a
   * description has no way to surface its purpose in the agent
   * picker, so we require something here. The validation lives in
   * `agent-write-routes.ts` so the server returns a 400 instead of
   * the writer producing a silently-empty file.
   */
  description: string
  /**
   * Free-form system prompt to use as the body of the agent file.
   * Required: a markdown body that motivates the agent's behaviour
   * is the whole point of "from scratch" — we do not generate
   * placeholder copy on the user's behalf because that would muddy
   * the agent's persona later.
   */
  systemPrompt: string
  /**
   * Optional Claude Code dist-tag (`sonnet` / `opus` / `haiku` /
   * `default`). Empty / undefined leaves the field off the
   * frontmatter; the runtime then falls back to the Claude Code
   * default. Validation lives in `agent-write-routes.ts`, mirroring
   * the AD-3 update path.
   */
  model?: string
  /**
   * Optional theme color (`#RGB` / `#RRGGBB`). Empty / undefined
   * leaves the field off the frontmatter, mirroring AD-3.
   */
  themeColor?: string
}

/**
 * AA-3: build an agent definition file from raw user-supplied
 * metadata. The file shape mirrors what `createAgentFromTemplate`
 * produces (frontmatter + markdown body) so downstream readers
 * (`agent-reader.parseAgentDefinition`, the chat UI) cannot tell
 * the two creation paths apart.
 *
 * Differences from the template path:
 *   - No marker block by default (the user can inject one later).
 *   - `name` frontmatter mirrors the agentId for parity with
 *     `claude --agent <id>` lookups.
 *   - `description` / `model` / `themeColor` are passed through
 *     verbatim when present, omitted entirely when blank.
 */
export function createAgentFromScratch(
  fs: FileAccessLayer,
  options: CreateScratchAgentOptions,
): CreateAgentResult {
  const { agentId, displayName, description, systemPrompt, model, themeColor } = options

  if (!isValidAgentId(agentId)) {
    return { success: false, error: 'Invalid agent ID. Use alphanumeric, hyphens, underscores (max 64 chars).' }
  }

  // Trim once so the validation messages match what we ultimately
  // write to disk; matter.stringify keeps the values verbatim, so a
  // trailing newline in the prompt would otherwise produce two
  // blank lines after the frontmatter delimiter.
  const trimmedDisplay = displayName.trim()
  const trimmedDescription = description.trim()
  const trimmedPrompt = systemPrompt.trim()

  if (trimmedDisplay.length === 0) {
    return { success: false, error: 'displayName is required' }
  }
  if (trimmedDescription.length === 0) {
    return { success: false, error: 'description is required' }
  }
  if (trimmedPrompt.length === 0) {
    return { success: false, error: 'systemPrompt is required' }
  }

  // Build the frontmatter object incrementally so blank optional
  // fields stay off the file entirely — gray-matter would otherwise
  // emit `model: ""` lines which the reader treats as "explicitly
  // cleared" rather than "never set".
  const frontmatter: Record<string, string> = {
    name: agentId,
    displayName: trimmedDisplay,
    description: trimmedDescription,
  }
  if (typeof model === 'string' && model.trim().length > 0) {
    frontmatter.model = model.trim()
  }
  if (typeof themeColor === 'string' && themeColor.trim().length > 0) {
    frontmatter.themeColor = themeColor.trim()
  }

  // matter.stringify takes the body first (no trailing newline,
  // we add one) and the frontmatter object second.
  const finalContent = matter.stringify(`${trimmedPrompt}\n`, frontmatter)

  // Ensure .claude/agents/ directory exists. Same handling as the
  // template path; duplicated rather than extracted because
  // testing the helper across both paths is more valuable than
  // saving four lines.
  const projectRoot = resolveProjectRoot(fs)
  const agentsDir = join(projectRoot, '.claude', 'agents')
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }

  const filePath = join(agentsDir, `${agentId}.md`)
  if (fs.existsSync(filePath)) {
    return { success: false, error: `Agent already exists: ${agentId}` }
  }

  try {
    fs.writeFileSync(filePath, finalContent, 'utf-8')
    return { success: true, filePath }
  } catch (err) {
    serverLogger.error({ err }, '[agent-writer] Failed to write scratch agent file:')
    return { success: false, error: 'Failed to write agent file' }
  }
}

/** Options for updateAgentSections */
export interface UpdateAgentOptions {
  /** Display name change (undefined = no change) */
  displayName?: string
  /**
   * Q3 / AD-3: frontmatter `description` field. Empty string removes
   * the field; undefined leaves the existing value untouched. Same
   * semantics as `displayName` so the editor can clear stale text.
   */
  description?: string
  /**
   * Q3 / AD-3: frontmatter `model` field. Accepted values are the
   * Claude Code dist-tags ("sonnet" / "opus" / "haiku" / "default").
   * Empty string clears the field so Claude Code falls back to its
   * configured default.
   */
  model?: string
  /**
   * Q3 / AD-3: frontmatter `themeColor` field. Hex string ("#RRGGBB")
   * the renderer reads from `AgentInfo.color`. New field — older
   * agents without it fall back to the viewer.config.json color or
   * the default neutral grey.
   */
  themeColor?: string
  /** Customization values for structured fields */
  sections?: {
    personality?: string
    toneSample?: string
    extraInstructions?: string
  }
}

/** Return value of updateAgentSections */
export interface UpdateAgentResult {
  success: boolean
  error?: string
}

/** Extracted marker section contents */
export interface ExtractedSections {
  /** Whether markers exist */
  hasMarkers: boolean
  /** displayName from frontmatter (undefined if not set) */
  displayName?: string
  /** Q3 / AD-3: frontmatter description (undefined if not set) */
  description?: string
  /** Q3 / AD-3: frontmatter model (undefined if not set) */
  model?: string
  /** Q3 / AD-3: frontmatter themeColor (undefined if not set) */
  themeColor?: string
  personality?: string
  toneSample?: string
  extraInstructions?: string
}

/**
 * Partially update structured fields of an existing agent.
 *
 * - Files with markers: replace only the matching sections
 * - Files without markers (manually created / legacy): return an error (do not corrupt)
 * - displayName change: update the `displayName` field in frontmatter via gray-matter
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

    // If section updates are requested, verify marker presence
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

    // Update displayName
    if (options.displayName !== undefined) {
      if (options.displayName.trim() === '') {
        // Remove displayName field if the value is empty
        delete frontmatterData.displayName
      } else {
        frontmatterData.displayName = options.displayName
      }
    }

    // Q3 / AD-3: description / model / themeColor — same empty-clears
    // semantics as displayName so the editor can wipe stale values.
    if (options.description !== undefined) {
      const trimmed = options.description.trim()
      if (trimmed === '') delete frontmatterData.description
      else frontmatterData.description = options.description
    }
    if (options.model !== undefined) {
      const trimmed = options.model.trim()
      if (trimmed === '') delete frontmatterData.model
      else frontmatterData.model = trimmed
    }
    if (options.themeColor !== undefined) {
      const trimmed = options.themeColor.trim()
      if (trimmed === '') delete frontmatterData.themeColor
      else frontmatterData.themeColor = trimmed
    }

    // Marker-based section replacement
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
    serverLogger.error({ err }, '[agent-writer] Failed to update agent file:')
    return { success: false, error: 'Failed to update agent file' }
  }
}

/**
 * Extract the current values of structured fields from an agent file.
 * Used by the editing UI to display initial values.
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
      description: typeof frontmatterData.description === 'string' ? frontmatterData.description : undefined,
      model: typeof frontmatterData.model === 'string' ? frontmatterData.model : undefined,
      themeColor: typeof frontmatterData.themeColor === 'string' ? frontmatterData.themeColor : undefined,
      personality,
      toneSample,
      extraInstructions,
    }
  } catch {
    return null
  }
}

/** List of all marker names */
const MARKER_NAMES = ['PERSONALITY', 'TONE_SAMPLE', 'EXTRA_INSTRUCTIONS'] as const

/**
 * Q2 / AD-2: append the structured-field marker block to an agent
 * file that does not already have it.
 *
 * The block is written at the end of the markdown body (after a blank
 * separator line) so existing prose is preserved verbatim. Each marker
 * pair starts with an HTML comment hint so a future user reading the
 * raw file can tell what KB expects to find inside.
 *
 * Idempotent: if any marker is already present, the call is rejected
 * with `alreadyHasMarkers` so the renderer never silently duplicates
 * the block. The frontmatter is preserved exactly (we only rewrite
 * the body via gray-matter's stringify path).
 */
export interface InjectMarkersResult {
  success: boolean
  /** True when the file already contained markers and nothing changed. */
  alreadyHasMarkers?: boolean
  error?: string
}

export function injectMarkerSections(
  fs: FileAccessLayer,
  agentId: string,
): InjectMarkersResult {
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

    const hasAnyMarker = MARKER_NAMES.some((name) =>
      bodyContent.includes(`<!-- KB:${name}_START -->`),
    )
    if (hasAnyMarker) {
      return { success: true, alreadyHasMarkers: true }
    }

    // Append the marker block. Two trailing newlines on the body
    // before the block keep the rendered markdown readable, then each
    // marker pair sits on its own paragraph with a placeholder hint
    // so users immediately understand what to type inside the block
    // when they switch to the editor.
    const trimmed = bodyContent.replace(/\s+$/, '')
    const markerBlock = MARKER_NAMES.map((name) => buildEmptyMarkerSection(name)).join('\n\n')
    const nextBody = `${trimmed}\n\n${markerBlock}\n`

    const finalContent = matter.stringify(nextBody, frontmatterData)
    fs.writeFileSync(filePath, finalContent, 'utf-8')
    return { success: true, alreadyHasMarkers: false }
  } catch (err) {
    serverLogger.error({ err }, '[agent-writer] Failed to inject markers:')
    return { success: false, error: 'Failed to inject markers' }
  }
}

/**
 * Build an empty marker section that the editing UI can later replace
 * via {@link replaceMarkerSection}. The placeholder comment between
 * the start/end markers gives users a hint without leaking into the
 * effective system prompt (Claude Code ignores HTML comments).
 */
function buildEmptyMarkerSection(markerName: string): string {
  const startMarker = `<!-- KB:${markerName}_START -->`
  const endMarker = `<!-- KB:${markerName}_END -->`
  // Lower-cased label for the placeholder comment so the hint reads
  // naturally even when the marker name is upper-cased for matching.
  const hint = markerName.toLowerCase().replace(/_/g, ' ')
  return `${startMarker}\n<!-- describe the agent's ${hint} here; KB will fill this in when you save the editor -->\n${endMarker}`
}

/**
 * Replace a section delimited by markers.
 *
 * Format:
 * <!-- KB:{NAME}_START -->
 * ... content ...
 * <!-- KB:{NAME}_END -->
 *
 * If the markers are not found, the content is returned unchanged.
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
 * Extract the content of a section delimited by markers.
 * Returns undefined if the markers do not exist.
 */
function extractSingleSection(content: string, markerName: string): string | undefined {
  const startMarker = `<!-- KB:${markerName}_START -->`
  const endMarker = `<!-- KB:${markerName}_END -->`

  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return undefined
  }

  // From right after the start marker tag to right before the end marker tag
  const sectionContent = content.substring(startIdx + startMarker.length, endIdx)

  // Strip leading and trailing newlines
  return sectionContent.replace(/^\n/, '').replace(/\n$/, '')
}
