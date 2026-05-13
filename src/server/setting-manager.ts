/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard settings file (.kovitoboard/setting.json) read/write.
 *
 * Designed to receive a FileAccessLayer.
 * Validation is implemented manually (without zod).
 */
import { lazyChildLogger } from './logger'

const settingLog = lazyChildLogger('setting-manager')
import { join } from 'path'
import { getKovitoboardDir } from './paths'
import type { FileAccessLayer } from './fs-layer'
import type { KovitoboardSetting } from '../shared/setting-types'

const SETTING_FILENAME = 'setting.json'

/** Return the path to .kovitoboard/setting.json */
export function getSettingPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), SETTING_FILENAME)
}

/** Read the settings file. Returns null if the file does not exist */
export function readSetting(fs: FileAccessLayer): KovitoboardSetting | null {
  const settingPath = getSettingPath(fs)
  if (!fs.existsSync(settingPath)) return null

  try {
    const raw = fs.readFileSync(settingPath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>

    // 1.0 -> 1.1 migration: backfill project.path with process.cwd()
    if (data.version === '1.0') {
      data.version = '1.1'
      const project = (data.project ?? {}) as Record<string, unknown>
      project.path = project.path ?? process.cwd()
      data.project = project
      try {
        writeSetting(fs, data as unknown as KovitoboardSetting)
        settingLog.info('[setting-manager] Migrated setting.json: 1.0 -> 1.1')
      } catch (writeErr) {
        settingLog.warn({ err: writeErr }, '[setting-manager] Migration write-back failed')
      }
    }

    if (!validateSetting(data)) {
      settingLog.warn('[setting-manager] Invalid setting file, returning null')
      return null
    }
    return data
  } catch (err) {
    settingLog.error({ err }, '[setting-manager] Failed to read setting:')
    return null
  }
}

/** Write the settings data as JSON */
export function writeSetting(fs: FileAccessLayer, data: KovitoboardSetting): void {
  const settingPath = getSettingPath(fs)

  // Create .kovitoboard/ directory if it does not exist
  const dir = getKovitoboardDir(fs)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Atomic replace: setting.json is read on every boot; a partial
  // write would invalidate onboarding state and force a recovery flow.
  fs.writeFileAtomic(settingPath, JSON.stringify(data, null, 2) + '\n')
}

/** Manual validation (without zod) */
export function validateSetting(data: unknown): data is KovitoboardSetting {
  if (data === null || typeof data !== 'object') return false

  const obj = data as Record<string, unknown>

  // version
  if (obj.version !== '1.1') return false

  // user
  if (obj.user === null || typeof obj.user !== 'object') return false
  const user = obj.user as Record<string, unknown>
  if (typeof user.displayName !== 'string') return false
  if (user.avatar !== null && typeof user.avatar !== 'string') return false

  // project
  if (obj.project === null || typeof obj.project !== 'object') return false
  const project = obj.project as Record<string, unknown>
  if (typeof project.name !== 'string') return false
  if (typeof project.description !== 'string') return false
  if (typeof project.path !== 'string') return false
  if (project.path.length === 0) return false

  // locale
  if (obj.locale !== 'ja' && obj.locale !== 'en') return false

  // onboarding
  if (obj.onboarding === null || typeof obj.onboarding !== 'object') return false
  const onboarding = obj.onboarding as Record<string, unknown>
  if (onboarding.completedAt !== null && typeof onboarding.completedAt !== 'string') return false
  if (typeof onboarding.wizardVersion !== 'string') return false
  // `securityRecommendationsReviewedAt` is optional; only validate type
  // when present so older setting files without the field continue to
  // load. Spec handoff v1.1 §3.4.3.
  if (
    onboarding.securityRecommendationsReviewedAt !== undefined &&
    typeof onboarding.securityRecommendationsReviewedAt !== 'string'
  ) {
    return false
  }

  // ambientSidebar (optional, DEC-020 / EU8)
  if (obj.ambientSidebar !== undefined) {
    if (obj.ambientSidebar === null || typeof obj.ambientSidebar !== 'object') return false
    const amb = obj.ambientSidebar as Record<string, unknown>
    // pinned: Record<string, string | null>
    if (amb.pinned === null || typeof amb.pinned !== 'object') return false
    for (const v of Object.values(amb.pinned as Record<string, unknown>)) {
      if (v !== null && typeof v !== 'string') return false
    }
    // globalDefault: string | null
    if (amb.globalDefault !== null && typeof amb.globalDefault !== 'string') return false
    // openByDefault: boolean
    if (typeof amb.openByDefault !== 'boolean') return false
  }

  // versionCheck (optional, v0.1.0-version-display.md §3.3)
  if (obj.versionCheck !== undefined) {
    if (obj.versionCheck === null || typeof obj.versionCheck !== 'object') return false
    const vc = obj.versionCheck as Record<string, unknown>
    if (typeof vc.enabled !== 'boolean') return false
    if (typeof vc.ttlHours !== 'number') return false
    if (!Number.isFinite(vc.ttlHours) || vc.ttlHours < 1 || vc.ttlHours > 168) return false
  }

  // claudeMdGuidance (optional, claude-md-guidance-injection.md §7.1).
  // Both inner fields are optional; we accept the struct as long as the
  // present fields have the right type. Missing struct == defaults
  // (`disabled = false`, no `lastInjectedAt`).
  if (obj.claudeMdGuidance !== undefined) {
    if (obj.claudeMdGuidance === null || typeof obj.claudeMdGuidance !== 'object') {
      return false
    }
    const cmg = obj.claudeMdGuidance as Record<string, unknown>
    if (cmg.disabled !== undefined && typeof cmg.disabled !== 'boolean') return false
    if (cmg.lastInjectedAt !== undefined && typeof cmg.lastInjectedAt !== 'string') {
      return false
    }
  }

  // claudeCodeSettingsWarning (optional, handoff v1.1 §3.5 / §8.2 T-2-3).
  // The struct persists the user's dismiss decision so we can honor a
  // 24-hour cooldown across restarts. We only verify the shape here;
  // the temporal bounds check (T-2-3 mitigation, `dismissedAt <= now +
  // 24h`) is enforced at consumption time in
  // `claude-code-settings-check.ts` so that a future-dated value
  // injected directly into the file cannot keep the warning suppressed
  // indefinitely.
  if (obj.claudeCodeSettingsWarning !== undefined) {
    if (
      obj.claudeCodeSettingsWarning === null ||
      typeof obj.claudeCodeSettingsWarning !== 'object'
    ) {
      return false
    }
    const cw = obj.claudeCodeSettingsWarning as Record<string, unknown>
    if (typeof cw.dismissedAt !== 'string') return false
    if (cw.dismissedResult === null || typeof cw.dismissedResult !== 'object') {
      return false
    }
    const dr = cw.dismissedResult as Record<string, unknown>
    // Minimum required shape — the consumer (check helper) is the
    // canonical interpreter; we just reject obviously-malformed
    // structures so other reads do not crash later.
    if (typeof dr.overallOk !== 'boolean') return false
    if (typeof dr.reason !== 'string') return false
    if (dr.permissionMode === null || typeof dr.permissionMode !== 'object') return false
    if (dr.denyPattern === null || typeof dr.denyPattern !== 'object') return false
    if (dr.bypassMode === null || typeof dr.bypassMode !== 'object') return false
    // CodeX attempt 11 — defense-in-depth: a persisted dismiss
    // snapshot is only meaningful when it captures a non-fail-closed
    // check result. Reject saved records whose `reason !== 'ok'` so a
    // crafted file cannot keep an "unreadable settings" warning
    // suppressed across reads. The HTTP dismiss endpoint already
    // refuses to write such a record server-side; this validator
    // closes the equivalent loophole for direct on-disk edits.
    if (dr.reason !== 'ok') return false
  }

  return true
}
