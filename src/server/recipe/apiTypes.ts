/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe API section type definitions (declarative handler model).
 *
 * Defines types for the recipe.yaml api: section, install manifest,
 * and call declarations used by the dispatcher.
 *
 * @see recipe-system.md §12-4 (install approval)
 * @see recipe-system.md §12-5 (dispatcher flow)
 * @stable v0.1.0
 */

import type { CategoryAHandlerName, Scope } from '../handlers/types.js'
import { HANDLER_REQUIRED_SCOPES } from '../handlers/types.js'

// =========================================
// recipe.yaml api: section
// =========================================

/**
 * A single entry in recipe.yaml api.calls[].
 * The frontend invokes it via callId, and the dispatcher routes it to the handler.
 *
 * @example
 * ```yaml
 * api:
 *   calls:
 *     - id: list-intel-reports
 *       handler: list-files
 *       args:
 *         path: intel/
 *     - id: read-intel-report
 *       handler: read-file
 *       args:
 *         path: "${input.path}"
 * ```
 *
 * @see recipe-system.md §12-5-1
 */
export interface HandlerCallDeclaration {
  /** Unique call ID (FE: window.kb.call(id, input)) */
  id: string
  /** Handler name to invoke */
  handler: CategoryAHandlerName
  /**
   * Static or template arguments.
   * `${input.xxx}` placeholders are resolved at runtime with the input provided by the frontend.
   */
  args?: Record<string, unknown>
}

/**
 * The complete api: section of recipe.yaml.
 *
 * @example
 * ```yaml
 * api:
 *   scopes:
 *     - project-read
 *     - own-data
 *   calls:
 *     - id: list-intel-reports
 *       handler: list-files
 *       args:
 *         path: intel/
 * ```
 *
 * @see recipe-system.md §12-2, §12-3
 */
export interface ApiSection {
  /** Scopes required by this recipe */
  scopes: Scope[]
  /** Handler call declarations */
  calls: HandlerCallDeclaration[]
}

// =========================================
// Install manifest
// =========================================

/**
 * Manifest for an installed recipe.
 * Stored at: `.kovitoboard/recipes-installed/{appId}/manifest.json`.
 *
 * Note that the directory key is the **appId** (KB-local identifier),
 * not the `recipeId` (recipe author's identifier). The two are
 * distinct from v0.1.0 onward (DEC-024 D-8): the same recipe can be
 * installed multiple times under different `appId`s, each with its
 * own manifest, while sharing the same `recipeId` lineage.
 *
 * @see recipe-system.md §12-5-1, §13
 * @see docs/specs/v0.1.0-app-id-and-manifest.md §3.5
 */
export interface RecipeManifest {
  /**
   * KB-local app identifier — the directory name under
   * `recipes-installed/`, the dispatcher cache key, the
   * `app/<appId>/` directory key, and the `app/data/<appId>/` data
   * root. Unique within a KovitoBoard project (see
   * `POST /api/apps/check-id-availability`).
   */
  appId: string
  /**
   * The recipe author's immutable identifier (from `recipe.yaml`'s
   * `recipeId` field). Preserved here so the manifest can answer
   * "which recipe is this app derived from" without rereading
   * `recipe.yaml`.
   */
  recipeId: string
  /**
   * The `version` field from `recipe.yaml` at install time. Renamed
   * from the legacy `version` to disambiguate from the project /
   * KovitoBoard versions also tracked elsewhere.
   */
  recipeVersion: string
  /** SHA-256 hash of the recipe content */
  hash: string
  /** Installation timestamp (ISO 8601) */
  installedAt: string
  /** User-approved scopes (identical to api.scopes; v0.1.0 uses bulk approval) */
  approvedScopes: Scope[]
  /** Recipe API declarations (transcribed from recipe.yaml) */
  api: ApiSection
}

// =========================================
// Dispatcher types
// =========================================

/**
 * Handler call request from frontend to backend.
 * Sent as the payload of a kb-call WebSocket message.
 * @see recipe-system.md §12-5-2
 */
export interface KbCallRequest {
  /** Request ID (assigned by frontend, used to correlate with response) */
  requestId: string
  /**
   * KB-local app identifier — the dispatcher routes by this. The
   * recipe's own `recipeId` is captured on the active manifest and
   * is not part of the wire request (DEC-024 D-1).
   */
  appId: string
  /** Call ID (api.calls[].id) */
  callId: string
  /** Input values passed from the frontend */
  input: Record<string, unknown>
}

/**
 * Handler call response from backend to frontend.
 * Returned as the payload of a kb-call-response WebSocket message.
 * @see recipe-system.md §12-5-2
 */
export interface KbCallResponse {
  /** Request ID (matches KbCallRequest.requestId) */
  requestId: string
  /** Handler execution result */
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
}

// =========================================
// Validation helpers
// =========================================

/** Type guard to check whether a value is a valid scope name */
const VALID_SCOPES = new Set<string>([
  'project-read',
  'project-write',
  'agents-read',
  'skills-read',
  'claude-md-read',
  'kb-data-read',
  'own-data',
])

export function isValidScope(value: unknown): value is Scope {
  return typeof value === 'string' && VALID_SCOPES.has(value)
}

/** Type guard to check whether a value is a valid Category A handler name */
const VALID_HANDLER_NAMES = new Set<string>([
  'list-files',
  'read-file',
  'write-file',
  'kv-get',
  'kv-set',
  'kv-list',
  'kv-delete',
  'notify',
  'export-file',
])

export function isValidHandlerName(value: unknown): value is CategoryAHandlerName {
  return typeof value === 'string' && VALID_HANDLER_NAMES.has(value)
}

/**
 * Validate the api: section of recipe.yaml.
 * Verifies that a parsed object conforms to the ApiSection shape.
 *
 * @returns null if valid, error message string if invalid
 * @see recipe-system.md §12-4-1 (block conditions)
 */
export function validateApiSection(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null // api: not specified is allowed (recipe without handlers)
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'api: must be an object'
  }

  const obj = raw as Record<string, unknown>

  // scopes validation
  if (!Array.isArray(obj.scopes)) {
    return 'api.scopes must be an array'
  }
  for (const scope of obj.scopes) {
    if (!isValidScope(scope)) {
      return `api.scopes contains invalid scope: "${String(scope)}"`
    }
  }

  // calls validation
  if (!Array.isArray(obj.calls)) {
    return 'api.calls must be an array'
  }
  const seenIds = new Set<string>()
  const declaredScopes = new Set(obj.scopes as string[])

  for (let i = 0; i < obj.calls.length; i++) {
    const call = obj.calls[i] as Record<string, unknown>
    if (typeof call !== 'object' || call === null || Array.isArray(call)) {
      return `api.calls[${i}] must be an object`
    }

    // id
    if (typeof call.id !== 'string' || call.id.length === 0) {
      return `api.calls[${i}].id must be a non-empty string`
    }
    if (seenIds.has(call.id)) {
      return `api.calls[${i}].id "${call.id}" is duplicated`
    }
    seenIds.add(call.id)

    // handler
    if (!isValidHandlerName(call.handler)) {
      return `api.calls[${i}].handler "${String(call.handler)}" is not a valid Category A handler`
    }

    // args (optional)
    if (call.args !== undefined && (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args))) {
      return `api.calls[${i}].args must be an object if specified`
    }

    // Static integrity check: verify handler's required scopes are included in declared scopes
    // §12-4-1: block if handler's required scope is not declared in api.scopes
    const handlerName = call.handler as CategoryAHandlerName
    const requiredScopes = HANDLER_REQUIRED_SCOPES[handlerName]

    // Skip handlers that require no scopes (notify, export-file)
    if (requiredScopes.length > 0) {
      const hasMatchingScope = requiredScopes.some((s: Scope) => declaredScopes.has(s))
      if (!hasMatchingScope) {
        return `api.calls[${i}] handler "${handlerName}" requires one of [${requiredScopes.join(', ')}] but api.scopes declares [${[...declaredScopes].join(', ')}]`
      }
    }
  }

  return null
}

/**
 * Cast a validated raw object to the ApiSection type.
 * Only use after validateApiSection() has returned null.
 */
export function parseApiSection(raw: Record<string, unknown>): ApiSection {
  return {
    scopes: raw.scopes as Scope[],
    calls: (raw.calls as Array<Record<string, unknown>>).map((c) => ({
      id: c.id as string,
      handler: c.handler as CategoryAHandlerName,
      args: c.args as Record<string, unknown> | undefined,
    })),
  }
}
