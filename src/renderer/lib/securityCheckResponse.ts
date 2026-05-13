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
