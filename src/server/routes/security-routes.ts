/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Security API router — Claude Code recommended-settings check + dismiss.
 *
 * GET  /api/security/settings-check   — Return the current check result
 *                                       plus whether the toast should
 *                                       currently be suppressed by the
 *                                       persisted dismiss state.
 * POST /api/security/dismiss          — Persist the user's dismiss
 *                                       decision (24h cooldown).
 *
 * Spec:
 *   - `trust-prompt-relay.md` v1.3 §10.5
 *   - `onboarding-scenarios.md` v1.2 §9.5
 *   - `logging-baseline.md` v1.4 §12.7
 *
 * Handoff:
 *   - `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 */
import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import {
  checkClaudeCodeSettings,
  evaluateDismiss,
  buildDismissRecord,
} from '../claude-code-settings-check'
import { readSetting, writeSetting } from '../setting-manager'
import { lazyChildLogger } from '../logger'
import type { SettingsCheckResult } from '../../shared/setting-types'

const log = lazyChildLogger('security-routes')

/**
 * Strip `settingsFilePath` before returning a result to the renderer.
 * The renderer does not need the absolute path (it only renders the
 * three recommendation rows + the dismiss button), and the same PR
 * already treats the path as sensitive enough to strip from the
 * persisted `claudeCodeSettingsWarning.dismissedResult`. Returning
 * the path through the API would leak the user's home directory /
 * username to any caller of /api/security/settings-check, which
 * defeats the redaction posture (CodeX attempt 7 — information
 * disclosure).
 */
function publicResult(result: SettingsCheckResult): SettingsCheckResult {
  return { ...result, settingsFilePath: null }
}

export function createSecurityRouter(
  fs: FileAccessLayer,
  projectRoot: string
): Router {
  const router = Router()

  // GET /api/security/settings-check
  router.get('/settings-check', (_req, res) => {
    const result = checkClaudeCodeSettings(fs, projectRoot)
    const setting = readSetting(fs)
    // Pass the latest setting so `onboarding.securityRecommendationsReviewedAt`
    // also counts toward the dismiss cooldown — without it a user who
    // just acknowledged the inline Security step would be re-greeted
    // by the toast on `/agents` (CodeX attempt 2).
    const evaluation = evaluateDismiss(
      result,
      setting?.claudeCodeSettingsWarning,
      Date.now(),
      { setting },
    )
    res.json({
      result: publicResult(result),
      suppressToast: evaluation.suppressToast,
      dismissExpiresAt: evaluation.effectiveExpiresAt,
    })
  })

  // POST /api/security/dismiss
  router.post('/dismiss', (_req, res) => {
    const setting = readSetting(fs)
    if (!setting) {
      res.status(409).json({
        error: 'setting.json not found; cannot persist dismiss state',
      })
      return
    }
    const current = checkClaudeCodeSettings(fs, projectRoot)
    // If the warning was already resolved, dismiss is a no-op — return
    // the cleared state so the client knows to hide the toast.
    if (current.overallOk) {
      res.json({ ok: true, suppressToast: true, dismissExpiresAt: null })
      return
    }
    // I-8: bypass mode active must always re-surface, refuse to record
    // a dismiss that would imply silencing it.
    if (current.bypassMode.active) {
      res.status(409).json({
        error:
          'bypass mode active cannot be dismissed (Rule of Two violation, HITL required)',
      })
      return
    }
    // Fail-closed warnings (read-error / parse-error / schema-mismatch
    // / path-resolution-rejected / file-too-large) describe a
    // structural inability to read the user's Claude Code settings.
    // A dismiss in that state would suppress the "Settings could not
    // be read — please review manually" banner without the underlying
    // condition being addressed, which contradicts the UI affordance
    // that already disables the Dismiss button for this case. Refuse
    // server-side too so a custom client cannot bypass the gate
    // (CodeX attempt 5 — server-side enforcement gap).
    if (current.reason !== 'ok') {
      res.status(409).json({
        error: `dismiss refused: settings check is in fail-closed state (${current.reason})`,
      })
      return
    }
    const updated = {
      ...setting,
      claudeCodeSettingsWarning: buildDismissRecord(current),
    }
    try {
      writeSetting(fs, updated)
    } catch (err) {
      log.error({ err }, 'Failed to persist dismiss state')
      res.status(500).json({ error: 'Failed to persist dismiss state' })
      return
    }
    const evaluation = evaluateDismiss(
      current,
      updated.claudeCodeSettingsWarning,
      Date.now(),
      { setting: updated },
    )
    res.json({
      ok: true,
      suppressToast: evaluation.suppressToast,
      dismissExpiresAt: evaluation.effectiveExpiresAt,
    })
  })

  return router
}
