/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe handler system — core type definitions.
 *
 * Centrally manages input/output schemas for the 9 Category A handlers,
 * common response types, 7 scope types, and handler definition interfaces.
 *
 * @see recipe-system.md §12-2 (Category A handler set)
 * @see recipe-system.md §12-2-1 (input/output schemas)
 * @see recipe-system.md §12-3 (scope definitions)
 * @stable v0.1.0
 */

import type { TrustLevel } from '../recipe/apiTypes'

// =========================================
// Error codes
// =========================================

/**
 * Handler error codes (shared across all handlers).
 * @see recipe-system.md §12-2-1
 */
export type HandlerErrorCode =
  | 'ScopeViolation'    // Operation requires an undeclared scope
  | 'PathOutOfScope'    // Path is outside the scope's target area
  | 'PathForbidden'     // Matches hardcoded exclusion list (§12-3-1)
  | 'NotFound'          // Target does not exist
  | 'SizeExceeded'      // Size limit exceeded
  | 'RateLimited'       // Rate limit hit
  | 'InvalidArgs'       // Argument validation error
  | 'HandlerNotDeclared' // Undeclared call via api.calls[].id
  | 'Internal'          // Internal server error

// =========================================
// Response type
// =========================================

/**
 * Common handler response type (ok/error discriminated union).
 * @see recipe-system.md §12-2-1
 */
export type HandlerResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: HandlerErrorCode; message: string } }

// =========================================
// Response factory helpers
// =========================================

/** Creates a success response */
export function handlerOk<T>(data: T): HandlerResponse<T> {
  return { ok: true, data }
}

/** Creates an error response */
export function handlerError<T = never>(
  code: HandlerErrorCode,
  message: string,
): HandlerResponse<T> {
  return { ok: false, error: { code, message } }
}

// =========================================
// Scope
// =========================================

/**
 * Definition of 7 scope types.
 *
 * Represents permissions required for handler execution. Approved by
 * the user at install time.
 *
 * v0.2.x note (recipe-system.md v1.8 §6.5.3 final paragraph): the
 * write opt-in scopes `agents-write` / `skills-write` defined in
 * v1.8 §6.5.1 are intentionally **not** included here. The install
 * path is disabled in v0.2.x (recipe-system.md §10.6), so writes to
 * `.claude/agents/` / `.claude/skills/` stay uniformly blocked by
 * the exclusion table until v0.3.0 reintroduces the opt-in flow.
 *
 * @see recipe-system.md v1.8 §6.5
 */
export type Scope =
  | 'project-read'    // Read access under project root (excluding exclusion list)
  | 'project-write'   // Write access under project root (same exclusions)
  | 'agents-read'     // Read access under .claude/agents/
  | 'skills-read'     // Read access under .claude/skills/
  | 'claude-md-read'  // Read access to any nested CLAUDE.md / CLAUDE.local.md
  | 'kb-data-read'    // Read access under kovitoboard/data/
  | 'own-data'        // Read/write access under app/data/{appId}/

// =========================================
// Handler names
// =========================================

/**
 * Category A handler names (9 handlers provided in v0.1.0).
 * @see recipe-system.md §12-2
 */
export type CategoryAHandlerName =
  | 'list-files'
  | 'read-file'
  | 'write-file'
  | 'kv-get'
  | 'kv-set'
  | 'kv-list'
  | 'kv-delete'
  | 'notify'
  | 'export-file'

/**
 * Required scope mapping per handler name.
 * Each handler can be executed if at least one of the specified scopes is approved.
 * @see recipe-system.md §12-2 handler list
 */
export const HANDLER_REQUIRED_SCOPES: Record<CategoryAHandlerName, Scope[]> = {
  'list-files': ['project-read', 'project-write', 'agents-read', 'skills-read', 'claude-md-read', 'kb-data-read', 'own-data'],
  'read-file': ['project-read', 'project-write', 'agents-read', 'skills-read', 'claude-md-read', 'kb-data-read', 'own-data'],
  'write-file': ['project-write', 'own-data'],
  'kv-get': ['own-data'],
  'kv-set': ['own-data'],
  'kv-list': ['own-data'],
  'kv-delete': ['own-data'],
  'notify': [],    // No scope required (user-visible)
  'export-file': [], // No scope required (explicit user action involved)
}

// =========================================
// Handler definition interface
// =========================================

/**
 * Context provided to handlers at execution time.
 * Passed from the dispatcher to handler.execute().
 */
export interface HandlerContext {
  /** Root path of the target project */
  projectRoot: string
  /**
   * KB-local app identifier — the dispatcher cache key, the
   * `app/<appId>/` directory key, and the `app/data/<appId>/` data
   * root. **All own-data path resolution uses this.**
   * (recipe-system.md §13)
   */
  appId: string
  /**
   * The recipe author's immutable identifier (from `recipe.yaml`'s
   * `recipeId` field). Distinct from `appId`: multiple installed
   * apps can share the same `recipeId` (= "installed from the same
   * recipe"). Preserved on the context so handlers / audit logs can
   * track the recipe lineage independently of the app instance.
   */
  recipeId: string
  /** List of approved scopes for this recipe */
  approvedScopes: readonly Scope[]
  /**
   * Fully resolved absolute path computed by the dispatcher's scope
   * validator from the handler's `input.path` argument. Set only for
   * path-bound handlers (`list-files`, `read-file`, `write-file`)
   * and undefined for scope-only handlers. Path-bound handlers
   * **must** consume this value verbatim and **must not** re-derive
   * a path from `projectRoot + input.path`; doing so re-opens the
   * scope-escape gap that this field was added to close, and
   * widens the symlink-swap race window between scope validation
   * and the subsequent fs operation.
   */
  resolvedPath?: string
}

/**
 * Interface for handler implementations.
 * Each Category A handler exports an object conforming to this interface.
 */
export interface HandlerDef<TInput = unknown, TOutput = unknown> {
  /** Handler name (must match CategoryAHandlerName) */
  name: CategoryAHandlerName
  /** Scopes required to execute this handler (at least one must be approved) */
  requiredScopes: readonly Scope[]
  /** Validates input arguments. Returns null if valid, or an error message string */
  validate: (input: unknown) => string | null
  /** Executes the handler */
  execute: (
    input: TInput,
    context: HandlerContext,
  ) => Promise<HandlerResponse<TOutput>>
}

// =========================================
// Handler input/output types
// =========================================

// --- list-files ---
// @see recipe-system.md §12-2-1 list-files

export interface ListFilesInput {
  /** Target directory path (relative path based on scope) */
  path: string
  /** Recursive traversal. Default: false */
  recursive?: boolean
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  /** ISO 8601 */
  modifiedAt: string
}

export interface ListFilesOutput {
  entries: FileEntry[]
}

// --- read-file ---
// @see recipe-system.md §12-2-1 read-file

export interface ReadFileInput {
  /** Target file path */
  path: string
  /** Encoding. Default: "utf-8" */
  encoding?: 'utf-8' | 'base64'
}

export interface ReadFileOutput {
  content: string
  size: number
  encoding: 'utf-8' | 'base64'
}

// --- write-file ---
// @see recipe-system.md §12-2-1 write-file

export interface WriteFileInput {
  /** Destination path */
  path: string
  /** Content to write */
  content: string
  /** Encoding. Default: "utf-8" */
  encoding?: 'utf-8' | 'base64'
  /** Allow creation of intermediate directories. Default: false */
  createDirs?: boolean
}

export interface WriteFileOutput {
  /** Number of bytes written */
  written: number
}

// --- kv-get ---
// @see recipe-system.md §12-2-1 kv-get

export interface KvGetInput {
  key: string
}

export interface KvGetOutput {
  value: string | null
  existsAt?: string
}

// --- kv-set ---
// @see recipe-system.md §12-2-1 kv-set

export interface KvSetInput {
  key: string
  value: string
  /** TTL in seconds. Omitted means no expiration */
  ttlSeconds?: number
}

// kv-set only returns { ok: true } — no separate type needed (used as HandlerResponse<KvSetOk>)
export interface KvSetOk {
  ok: true
}

// --- kv-list ---
// @see recipe-system.md §12-2-1 kv-list

export interface KvListInput {
  /** Key prefix filter */
  prefix?: string
  /** Return limit. Default: 100, maximum: 1000 */
  limit?: number
}

export interface KvListOutput {
  keys: string[]
  hasMore: boolean
}

// --- kv-delete ---
// @see recipe-system.md §12-2-1 kv-delete

export interface KvDeleteInput {
  key: string
}

export interface KvDeleteOutput {
  /** Whether the key existed and was deleted */
  deleted: boolean
}

// --- notify ---
// @see recipe-system.md §12-2-1 notify

export interface NotifyInput {
  title: string
  body: string
  level?: 'info' | 'warning'
}

export interface NotifyOk {
  ok: true
}

// --- export-file ---
// @see recipe-system.md §12-2-1 export-file

export interface ExportFileInput {
  /** Suggested file name for the save dialog */
  suggestedName: string
  /** File content */
  content: string
  /** MIME type (browser-inferred when omitted) */
  mimeType?: string
  /** Encoding. Default: "utf-8" */
  encoding?: 'utf-8' | 'base64'
}

export interface ExportFileOutput {
  /** Whether the user approved the save */
  saved: boolean
  /** Saved file path (undefined if cancelled) */
  savedPath?: string
}

// =========================================
// Limits / constants
// =========================================

/**
 * Handler limits (corresponds to limits defined in recipe-system.md §12-2-1).
 */
export const HANDLER_LIMITS = {
  /** list-files: Maximum entries per response */
  LIST_FILES_MAX_ENTRIES: 1_000,
  /** list-files: Maximum recursion depth for own-data */
  LIST_FILES_MAX_DEPTH_OWN: 5,
  /** list-files: Maximum recursion depth for non-own-data */
  LIST_FILES_MAX_DEPTH_OTHER: 2,

  /** read-file: Maximum file size (10MB) */
  READ_FILE_MAX_SIZE: 10 * 1024 * 1024,
  /** write-file: Maximum write size (10MB) */
  WRITE_FILE_MAX_SIZE: 10 * 1024 * 1024,

  /** KV: Maximum key length (256 chars) */
  KV_KEY_MAX_LENGTH: 256,
  /** KV: Maximum value size (1MB) */
  KV_VALUE_MAX_SIZE: 1 * 1024 * 1024,
  /** KV: Maximum total store size (100MB) */
  KV_STORE_MAX_SIZE: 100 * 1024 * 1024,
  /** kv-list: Default limit */
  KV_LIST_DEFAULT_LIMIT: 100,
  /** kv-list: Maximum limit */
  KV_LIST_MAX_LIMIT: 1_000,

  /** notify: Maximum title length (100 chars) */
  NOTIFY_TITLE_MAX_LENGTH: 100,
  /** notify: Maximum body length (500 chars) */
  NOTIFY_BODY_MAX_LENGTH: 500,
  /** notify: Rate limit (per recipe, /min) */
  NOTIFY_RATE_LIMIT_PER_MIN: 10,

  /** export-file: Maximum content size (50MB) */
  EXPORT_FILE_MAX_SIZE: 50 * 1024 * 1024,

  /** Frontend-side timeout (30 seconds) */
  HANDLER_TIMEOUT_MS: 30_000,
} as const

// =========================================
// Hardcoded exclusion patterns
// =========================================

/**
 * Hardcoded exclusion patterns — documentation copy only.
 *
 * The authoritative, operation-aware table lives in
 * `scopeValidator.ts` (`EXCLUSIONS`). Individual handlers must not
 * check these — exclusion is enforced in one place.
 *
 * v1.8 (recipe-system.md §6.6, security-threat-model.md §S2/§S3/§S9):
 * the table is now operation-aware. The patterns below are listed
 * with their {block-mode} annotation so this file stays a quick
 * reference, but match logic is in scopeValidator.ts.
 *
 *   `.env` / `.env.*` / nested `.env*`        [read+write block]
 *   `.git` / `.git/**`                        [read+write block]
 *   `node_modules/**`                         [read+write block]
 *   `.claude/credentials*`                    [read+write block]
 *   `.claude/hooks/**`                        [read+write block, v1.8]
 *   `.claude/settings.json` / `.local.json`   [read+write block, v1.8]
 *   `.claude/commands/**`                     [read+write block, v1.8]
 *   `.claude/agents/**`                       [read+write block; read bypass via `agents-read`, v1.8]
 *   `.claude/skills/**`                       [read+write block; read bypass via `skills-read`, v1.8]
 *   any nested `CLAUDE.md` / `CLAUDE.local.md` [read+write block; read bypass via `claude-md-read`, v1.8]
 *
 * @see recipe-system.md v1.8 §6.6 (exclusion, operation-aware)
 * @see scopeValidator.ts `EXCLUSIONS` (authoritative table)
 */
export const HARDCODED_EXCLUSIONS = [
  '.env',
  '.env.*',
  '.git/**',
  'node_modules/**',
  '.claude/credentials*',
  '.claude/hooks/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/commands/**',
  '.claude/agents/** (read+write block; read bypass via agents-read)',
  '.claude/skills/** (read+write block; read bypass via skills-read)',
  'CLAUDE.md (any nested, read+write block; read bypass via claude-md-read)',
  'CLAUDE.local.md (any nested, read+write block; read bypass via claude-md-read)',
] as const

// =========================================
// Audit log types
// =========================================

/**
 * Trust-axis value persisted on every handler-call audit entry.
 *
 * Superset of {@link TrustLevel} with an extra `'context-missing'`
 * sentinel for the manifest-load-failure / context-bypass paths.
 * Conflating those failure modes with the grandfather `'unknown'`
 * value would lose attack-vector detection during forensic analysis
 * (T-3-4 in the v1.1 trust-marker handoff supplement).
 *
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis)
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §8.4 (I-8)
 * @stable v0.2.0
 */
export type AuditTrustLevel = TrustLevel | 'context-missing'

/** All audit-trust enum values, exported for validation helpers. */
export const AUDIT_TRUST_LEVELS: readonly AuditTrustLevel[] = [
  'KB-trusted',
  'code-trusted',
  'code-trusted (sideloaded)',
  'unknown',
  'context-missing',
] as const

/**
 * Schema for a single audit log entry.
 * Written in JSONL format to `app/data/{appId}/_audit.log`.
 * @see recipe-system.md §12-6 (future)
 */
export interface AuditLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string
  /**
   * KB-local app identifier — same key as the audit log directory
   * path. Required so a single audit log line can be attributed to
   * the specific app instance that produced it (multiple apps may
   * share a `recipeId`).
   */
  appId: string
  /** Recipe lineage id (from the active manifest's `recipeId`) */
  recipeId: string
  /** Call ID (api.calls[].id) */
  callId: string
  /** Handler name */
  handler: CategoryAHandlerName
  /** SHA-256 hash of arguments (raw arguments are not logged) */
  argsHash: string
  /** Response result: ok or error */
  result: 'ok' | 'error'
  /** Error code (only when result === 'error') */
  errorCode?: HandlerErrorCode
  /** Processing duration (ms) */
  durationMs: number
  /**
   * Trust-axis value captured at handler dispatch time (v0.2.0).
   *
   * Required field — TypeScript compile-time enforcement guarantees
   * every dispatch path threads the active manifest's `trustLevel`
   * (or the `'context-missing'` sentinel when no manifest could be
   * resolved) into the audit trail. Forensic analysis depends on the
   * distinction between `'unknown'` (grandfather recipe ran as
   * expected) and `'context-missing'` (manifest lookup failed, the
   * audit entry exists but no trust signal is available).
   *
   * @see recipe-system.md v1.4 §6.10.5 (audit log trust injection)
   * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §8 (T-3-4)
   * @stable v0.2.0
   */
  trust: AuditTrustLevel
}

/**
 * Audit log rotation settings.
 */
export const AUDIT_LOG_LIMITS = {
  /** Maximum file size (10MB) */
  MAX_SIZE: 10 * 1024 * 1024,
  /** Number of rotation generations */
  MAX_GENERATIONS: 3,
} as const
