/**
 * Stable API: Recipe system type definitions.
 * Shared between server and renderer — no React/DOM dependencies.
 *
 * Stability classification:
 *   @stable  — ArtifactType, ArtifactEntry, RecipeMenuEntry
 *   @stable  — RecipeMetadata, ParsedRecipe (shape)
 *   @stable  — InspectionVerdict, InspectionResult (shape)
 *   @stable  — RecipeHistoryEntry (shape)
 *   @stable  — API request/response types
 *   @internal — Finding (individual fields may change)
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 */

// --- Artifact types ---

/** Allowed artifact types (v0.1.0: FE-only, 'api' is forbidden) */
export type ArtifactType = 'page' | 'style' | 'lib' | 'hook' | 'util'

/** Artifact entry from recipe YAML (path + type only) */
export interface ArtifactEntry {
  path: string
  type: ArtifactType
}

/** Artifact with full content (after parsing) */
export interface ArtifactWithContent extends ArtifactEntry {
  content: string
  sizeBytes: number
}

// --- Recipe metadata ---

export interface RecipeMetadata {
  name: string
  description: string
  version: string
  author?: string
  kovitoboard?: string
  tags?: string[]
}

/** Menu entry defined in recipe YAML */
export interface RecipeMenuEntry {
  id: string
  label: string
  icon: string
  page: string // relative path under app/, no extension
}

// --- Parsed recipe ---

export interface ParsedRecipe {
  metadata: RecipeMetadata
  artifacts: ArtifactWithContent[]
  menu: RecipeMenuEntry[]
  instruction?: string
  hash: string
  sourceFormat: 'directory' | 'markdown'
  sourcePath: string
}

// --- Security inspection ---

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'info'
export type InspectionVerdict = 'blocked' | 'warning' | 'caution' | 'safe'

export interface Finding {
  severity: FindingSeverity
  file: string
  line?: number
  description: string
  context?: string
}

export interface InspectionResult {
  verdict: InspectionVerdict
  findings: Finding[]
  remoteCheckSkipped?: boolean
  note?: string
}

// --- History ---

export interface RecipeHistoryEntry {
  id: string
  name: string
  version: string
  author?: string
  source: string
  hash: string
  appliedAt: string
  artifacts: string[]
  menu: string[]
}

// --- API request/response types ---

export interface RecipeParseRequest {
  source: string
}

export interface RecipeParseResponse {
  recipe: ParsedRecipe
  inspection: InspectionResult
}

export interface RecipeApplyRequest {
  recipe: ParsedRecipe
  inspection: InspectionResult
  agentId?: string
}

export interface RecipeApplyResponse {
  success: boolean
  historyId: string
  error?: string
}

export interface RecipeExportRequest {
  metadata: RecipeMetadata
  format: 'directory' | 'markdown'
  outputPath: string
}

export interface RecipeExportResponse {
  success: boolean
  outputPath: string
  error?: string
}

export interface AppScanResult {
  artifacts: Array<{ path: string; type: ArtifactType; sizeBytes: number }>
  menu: RecipeMenuEntry[]
  totalSize: number
}
