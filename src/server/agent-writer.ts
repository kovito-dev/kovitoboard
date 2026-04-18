/**
 * Agent creation and update logic.
 *
 * - createAgentFromTemplate: Create a new agent from a template
 * - updateAgentSections: Partially update structured fields of an existing agent
 */

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
    console.error('[agent-writer] Failed to write agent file:', err)
    return { success: false, error: 'Failed to write agent file' }
  }
}

/** Options for updateAgentSections */
export interface UpdateAgentOptions {
  /** Display name change (undefined = no change) */
  displayName?: string
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
    console.error('[agent-writer] Failed to update agent file:', err)
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
