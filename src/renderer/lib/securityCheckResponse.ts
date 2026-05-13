/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Shared response shape + fail-closed builder for the
 * `/api/security/settings-check` channel.
 *
 * Extracted so the StepSecurity wizard step and the
 * SecurityRecommendationsToast cannot drift out of sync (CodeX
 * attempt 8 — duplicated fail-closed contract). Both surfaces are
 * meant to render the same recommendation channel — one as an inline
 * onboarding step, one as a post-onboarding portal toast — so any
 * shape change must apply uniformly.
 */
import type { SettingsCheckResult } from '../../shared/setting-types'

export interface SecurityCheckResponse {
  result: SettingsCheckResult
  suppressToast: boolean
  dismissExpiresAt: string | null
}

/**
 * Runtime guard for `SecurityCheckResponse` payloads received from
 * `/api/security/settings-check`. Used by both the toast and the
 * onboarding step to reject shape-drifted JSON (e.g. server version
 * skew, transient proxy that returns HTML, hand-crafted attacker
 * response) before the consumer reads downstream fields like
 * `result.overallOk` — without the guard a payload like `{}` or a
 * truncated body would crash the renderer with a `Cannot read
 * properties of undefined` (CodeX attempt 27 — runtime type safety).
 */
export function isSecurityCheckResponse(value: unknown): value is SecurityCheckResponse {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.suppressToast !== 'boolean') return false
  if (v.dismissExpiresAt !== null && typeof v.dismissExpiresAt !== 'string') {
    return false
  }
  const result = v.result
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if (typeof r.overallOk !== 'boolean') return false
  if (typeof r.reason !== 'string') return false
  if (r.permissionMode === null || typeof r.permissionMode !== 'object') return false
  if (r.denyPattern === null || typeof r.denyPattern !== 'object') return false
  if (r.bypassMode === null || typeof r.bypassMode !== 'object') return false
  return true
}

/**
 * Build a synthetic fail-closed `SecurityCheckResponse` so a fetch
 * failure surfaces the same "settings could not be read" UX as a
 * server-reported fail-closed result. Hiding the surface on fetch
 * failure would violate the recommendation channel's intent: an
 * outage of /api/security/* must NOT silently dismiss the warning.
 */
export function buildFetchFailureResponse(): SecurityCheckResponse {
  return {
    result: {
      permissionMode: {
        current: '__unreadable__',
        recommended: 'default',
        ok: false,
      },
      denyPattern: {
        hasKovitoboardDeny: false,
        ok: false,
        remediation: 'Review your Claude Code settings manually.',
      },
      bypassMode: { active: false, ok: false },
      overallOk: false,
      reason: 'read-error',
      settingsFilePath: null,
    },
    suppressToast: false,
    dismissExpiresAt: null,
  }
}
