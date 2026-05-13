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

const log = lazyChildLogger('security-routes')

export function createSecurityRouter(
  fs: FileAccessLayer,
  projectRoot: string
): Router {
  const router = Router()

  // GET /api/security/settings-check
  router.get('/settings-check', (_req, res) => {
    const result = checkClaudeCodeSettings(fs, projectRoot)
    const setting = readSetting(fs)
    const evaluation = evaluateDismiss(result, setting?.claudeCodeSettingsWarning)
    res.json({
      result,
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
    const evaluation = evaluateDismiss(current, updated.claudeCodeSettingsWarning)
    res.json({
      ok: true,
      suppressToast: evaluation.suppressToast,
      dismissExpiresAt: evaluation.effectiveExpiresAt,
    })
  })

  return router
}
