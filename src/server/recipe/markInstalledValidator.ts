/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Validation for `POST /api/recipes/:recipeId/mark-installed`.
 *
 * Split out as a pure function so the request shape can be unit
 * tested without standing up an Express app. The handler in
 * `src/server/index.ts` translates the result into either a 4xx
 * response or a successful manifest persist + history append.
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.3
 */
import type { ApiSection } from './apiTypes.js'
import { isValidScope, validateApiSection, parseApiSection } from './apiTypes.js'
import type { Scope } from '../handlers/types.js'
import { MAX_APP_ID_LENGTH } from '../../shared/security-limits'

/** Mirrors the v2.0 install request body in the spec. */
export interface MarkInstalledBody {
  appId: string
  approvedScopes: Scope[]
  recipeVersion: string
  recipeSource: 'sample' | 'import' | 'url'
  recipeHash: string
  /**
   * One-shot nonce the server minted at `/api/recipes/install`. The
   * agent echoes it back here so the handler can match the
   * mark-installed call to its corresponding install session and
   * verify the approvedScopes / recipeHash were not tampered with.
   * Format mirrors `KB_LAUNCH_TOKEN`: 32 lowercase hex characters
   * (16 bytes from `crypto.randomBytes`).
   */
  installNonce: string
  api?: ApiSection
}

/** Same hex shape as `KB_LAUNCH_TOKEN` — 16 bytes encoded as hex. */
const INSTALL_NONCE_PATTERN = /^[0-9a-f]{32}$/

export type MarkInstalledValidation =
  | { ok: true; value: MarkInstalledBody }
  | { ok: false; status: 400 | 404; error: string }

/**
 * Format constraint for `appId` (mirrors the collision-avoidance API
 * in `app-id-collision.ts`). The total length cap derives from the
 * shared `MAX_APP_ID_LENGTH` SSOT in `src/shared/security-limits.ts`
 * so any future tightening of L-R6 stays in lockstep with the regex:
 *   - one mandatory leading lowercase letter
 *   - up to `MAX_APP_ID_LENGTH - 1` trailing `[a-z0-9-]` characters
 *
 * Computed once at module load — RegExp construction is cheap but the
 * validator is called on every mark-installed request.
 */
const APP_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${MAX_APP_ID_LENGTH - 1}}$`,
)

/**
 * Format constraint for the URL `:recipeId` segment. Mirrors the
 * server-side `RECIPE_ID_PATTERN` used by the recipe parser.
 */
const RECIPE_ID_URL_PATTERN = /^[A-Za-z0-9_\-./@]+$/

/**
 * Run the validation pipeline for `POST /api/recipes/:recipeId/mark-installed`.
 *
 * Order is shaped so the most user-actionable errors surface first:
 *   1. URL `:recipeId` shape — 404 because the route param is
 *      effectively a path segment that has to round-trip.
 *   2. Body field types — 400 each, in declaration order.
 *   3. The optional `api` section validator runs last so missing
 *      required fields above never get masked by an api-shape
 *      complaint.
 */
export function validateMarkInstalledRequest(
  recipeIdParam: unknown,
  body: unknown,
): MarkInstalledValidation {
  if (typeof recipeIdParam !== 'string' || !RECIPE_ID_URL_PATTERN.test(recipeIdParam)) {
    return {
      ok: false,
      status: 404,
      error: 'recipeId path parameter is missing or malformed',
    }
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' }
  }
  const obj = body as Record<string, unknown>

  const { appId, approvedScopes, recipeVersion, recipeSource, recipeHash, installNonce, api } = obj

  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
    return {
      ok: false,
      status: 400,
      error: 'appId must match /^[a-z][a-z0-9-]{0,63}$/',
    }
  }

  if (!Array.isArray(approvedScopes) || !approvedScopes.every(isValidScope)) {
    return {
      ok: false,
      status: 400,
      error: 'approvedScopes must be an array of valid scope names',
    }
  }

  if (typeof recipeVersion !== 'string' || recipeVersion.length === 0) {
    return { ok: false, status: 400, error: 'recipeVersion must be a non-empty string' }
  }

  if (
    recipeSource !== 'sample' &&
    recipeSource !== 'import' &&
    recipeSource !== 'url'
  ) {
    return {
      ok: false,
      status: 400,
      error: 'recipeSource must be one of: sample, import, url',
    }
  }

  if (typeof recipeHash !== 'string' || recipeHash.length === 0) {
    return { ok: false, status: 400, error: 'recipeHash must be a non-empty string' }
  }

  if (typeof installNonce !== 'string' || !INSTALL_NONCE_PATTERN.test(installNonce)) {
    return {
      ok: false,
      status: 400,
      error:
        'installNonce must be a 32-character lowercase hex string ' +
        '(supplied by /api/recipes/install at handover time)',
    }
  }

  let apiSection: ApiSection | undefined
  if (api !== undefined && api !== null) {
    const apiError = validateApiSection(api)
    if (apiError) {
      return { ok: false, status: 400, error: `Invalid api section: ${apiError}` }
    }
    apiSection = parseApiSection(api as Record<string, unknown>)
  }

  return {
    ok: true,
    value: {
      appId,
      approvedScopes: approvedScopes as Scope[],
      recipeVersion,
      recipeSource,
      recipeHash,
      installNonce,
      api: apiSection,
    },
  }
}
