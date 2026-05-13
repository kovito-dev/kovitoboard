/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Claude Code recommended-settings check.
 *
 * Spec SSOT:
 *   - `onboarding-scenarios.md` v1.2 §9.5 — common UX SSOT
 *   - `trust-prompt-relay.md` v1.3 §10.5 — startup warn channel
 *   - `logging-baseline.md` v1.4 §12.7 — log redaction policy
 *   - `prompt-injection-threat-model.md` v1.0 §4 — responsibility boundary
 *
 * Handoff:
 *   - `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 *
 * Threat coverage (handoff §8.2):
 *   - T-2-1: `fs.realpath` normalization + home-directory bound check
 *     reject project `.claude` symlinks that escape `~`.
 *   - T-2-2: read / parse / schema-mismatch fail closed
 *     (`overallOk: false` + `reason` enum). A failed read does NOT
 *     return `ok: true`.
 *   - T-2-3: dismiss state `dismissedAt` is bounded server-side to
 *     `now + 24h`; bypass mode active is excluded from the dismiss
 *     contract so the toast re-surfaces every startup.
 *   - T-2-4: a single `fs.watch` is started by the supervisor against
 *     the effective settings file path so runtime mutations re-run the
 *     check and re-broadcast the warning.
 *
 * Responsibility boundary (spec §4): KB does NOT implement deny pattern
 * detection or enforcement. KB's role is limited to (a) reading the
 * recommended-settings shape, (b) surfacing a notice when the user's
 * Claude Code configuration does not match the recommended values, and
 * (c) recording a redacted structured log entry. Pattern detection /
 * blocking is delegated to Anthropic upstream (Claude Code).
 */
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import type { FileAccessLayer, WatchHandle } from './fs-layer'
import { lazyChildLogger } from './logger'
import type {
  SettingsCheckResult,
  SettingsCheckReason,
  ClaudeCodeSettingsWarning,
  KovitoboardSetting,
} from '../shared/setting-types'

const log = lazyChildLogger('claude-code-settings-check')

/** 24 hours in milliseconds — used as the dismiss cooldown ceiling. */
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Sentinel returned when the inspected settings file cannot be read,
 * parsed, or normalized. Surfaces in `permissionMode.current` so the
 * UI / log layer can distinguish a structural failure from a real
 * non-recommended value.
 */
const UNREADABLE = '__unreadable__'

/**
 * Build a fail-closed `SettingsCheckResult` for a structural failure
 * (T-2-2 mitigation). All check items report `ok: false` so the caller
 * surfaces the warning, and the `reason` field carries the structural
 * cause.
 */
function failClosedResult(
  reason: SettingsCheckReason,
  settingsFilePath: string | null
): SettingsCheckResult {
  return {
    permissionMode: { current: UNREADABLE, recommended: 'default', ok: false },
    denyPattern: {
      hasKovitoboardDeny: false,
      ok: false,
      remediation:
        'Add ".kovitoboard/" to permissions.deny in your Claude Code settings.',
    },
    bypassMode: { active: false, ok: false },
    overallOk: false,
    reason,
    settingsFilePath,
  }
}

/**
 * Resolve the project-level Claude Code settings file path, applying
 * `fs.realpathSync` so a `.claude` directory symlink that escapes the
 * user's home directory is rejected (T-2-1 mitigation).
 *
 * Returns `null` when the file does not exist or when realpath escapes
 * the home directory.
 */
function resolveProjectSettingsPath(
  fs: FileAccessLayer,
  projectRoot: string,
  home: string
): { path: string | null; rejected: boolean } {
  const candidate = join(projectRoot, '.claude', 'settings.json')
  if (!fs.existsSync(candidate)) {
    return { path: null, rejected: false }
  }
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    // ENOENT (broken symlink) or permission denied — treat as path
    // resolution failure rather than fail-open.
    return { path: null, rejected: true }
  }
  // T-2-1: require the resolved canonical path to remain under the
  // user's home directory. Trailing separator on both sides prevents
  // an unrelated `~user-evil/...` path from looking like a prefix
  // match of `~user`.
  const homeWithSep = home.endsWith(sep) ? home : home + sep
  if (resolved !== home && !resolved.startsWith(homeWithSep)) {
    return { path: null, rejected: true }
  }
  return { path: resolved, rejected: false }
}

/**
 * Resolve the user-level Claude Code settings file path.
 *
 * `~/.claude/settings.json` is always under the home directory by
 * construction, so the same realpath check is applied defensively but
 * generally completes without rejecting.
 */
function resolveUserSettingsPath(
  fs: FileAccessLayer,
  home: string
): { path: string | null; rejected: boolean } {
  const candidate = join(home, '.claude', 'settings.json')
  if (!fs.existsSync(candidate)) {
    return { path: null, rejected: false }
  }
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    return { path: null, rejected: true }
  }
  const homeWithSep = home.endsWith(sep) ? home : home + sep
  if (resolved !== home && !resolved.startsWith(homeWithSep)) {
    return { path: null, rejected: true }
  }
  return { path: resolved, rejected: false }
}

interface ClaudeCodeRawSettings {
  permissionMode?: unknown
  permissions?: {
    deny?: unknown
  }
}

/** Read + JSON.parse a settings file with a fail-closed posture. */
function readAndParse(
  fs: FileAccessLayer,
  path: string
): { ok: true; value: ClaudeCodeRawSettings } | { ok: false; reason: SettingsCheckReason } {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    return { ok: false, reason: 'read-error' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'parse-error' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'schema-mismatch' }
  }
  return { ok: true, value: parsed as ClaudeCodeRawSettings }
}

/**
 * Merge the project-level over user-level Claude Code settings. Mirrors
 * the Claude Code precedence: project values override user values for
 * scalars (`permissionMode`); array-valued fields (`permissions.deny`)
 * take the union so a project-level deny list does not silently shrink
 * the effective deny set.
 */
function mergeSettings(
  user: ClaudeCodeRawSettings | null,
  project: ClaudeCodeRawSettings | null
): { permissionMode: string; deny: string[] } {
  const permissionMode = (() => {
    const projectMode = project?.permissionMode
    if (typeof projectMode === 'string' && projectMode.length > 0) return projectMode
    const userMode = user?.permissionMode
    if (typeof userMode === 'string' && userMode.length > 0) return userMode
    // Claude Code's documented default is "default" when unspecified.
    return 'default'
  })()
  const denySet = new Set<string>()
  for (const candidate of [user?.permissions?.deny, project?.permissions?.deny]) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === 'string') denySet.add(entry)
      }
    }
  }
  return { permissionMode, deny: Array.from(denySet) }
}

/** Heuristic match for `.kovitoboard/` coverage in the deny array. */
function denyCoversKovitoboard(deny: string[]): boolean {
  for (const entry of deny) {
    const normalized = entry.replace(/^Read\(/i, '').replace(/\)$/, '').trim()
    if (
      normalized === '.kovitoboard' ||
      normalized === '.kovitoboard/' ||
      normalized === './.kovitoboard' ||
      normalized.startsWith('.kovitoboard/') ||
      normalized.includes('/.kovitoboard/') ||
      normalized.endsWith('/.kovitoboard') ||
      normalized.endsWith('/.kovitoboard/**') ||
      normalized.endsWith('.kovitoboard/**')
    ) {
      return true
    }
  }
  return false
}

/**
 * Run the recommended-settings check against the live Claude Code
 * configuration. Pure with respect to filesystem reads via the injected
 * `FileAccessLayer` and `homedir()` override (for tests).
 *
 * Threat coverage: T-2-1 (path traversal / symlink), T-2-2 (fail-closed).
 */
export function checkClaudeCodeSettings(
  fs: FileAccessLayer,
  projectRoot: string,
  homeOverride?: string
): SettingsCheckResult {
  const home = homeOverride ?? homedir()
  const homeAbs = resolve(home)
  const projectAbs = resolve(projectRoot)

  const userResolved = resolveUserSettingsPath(fs, homeAbs)
  const projectResolved = resolveProjectSettingsPath(fs, projectAbs, homeAbs)

  // T-2-1: any symlink escape rejects the entire check, fail-closed.
  if (userResolved.rejected || projectResolved.rejected) {
    log.warn(
      {
        event: 'claude-code-settings-check-failed',
        reason: 'path-resolution-rejected',
        userRejected: userResolved.rejected,
        projectRejected: projectResolved.rejected,
      },
      'Claude Code settings path resolution rejected (symlink escape or broken link)'
    )
    return failClosedResult(
      'path-resolution-rejected',
      projectResolved.path ?? userResolved.path
    )
  }

  // If neither location has a settings file, Claude Code is running on
  // its built-in defaults. permissionMode defaults to 'default' (OK)
  // and the deny list is empty (NOT ok — surface a remediation hint).
  let userSettings: ClaudeCodeRawSettings | null = null
  let projectSettings: ClaudeCodeRawSettings | null = null

  if (userResolved.path !== null) {
    const r = readAndParse(fs, userResolved.path)
    if (!r.ok) {
      log.warn(
        {
          event: 'claude-code-settings-check-failed',
          reason: r.reason,
          settingsFilePath: userResolved.path,
        },
        'Claude Code user settings could not be loaded'
      )
      return failClosedResult(r.reason, userResolved.path)
    }
    userSettings = r.value
  }
  if (projectResolved.path !== null) {
    const r = readAndParse(fs, projectResolved.path)
    if (!r.ok) {
      log.warn(
        {
          event: 'claude-code-settings-check-failed',
          reason: r.reason,
          settingsFilePath: projectResolved.path,
        },
        'Claude Code project settings could not be loaded'
      )
      return failClosedResult(r.reason, projectResolved.path)
    }
    projectSettings = r.value
  }

  const merged = mergeSettings(userSettings, projectSettings)
  const permissionModeOk = merged.permissionMode === 'default'
  const bypassActive = merged.permissionMode === 'bypassPermissions'
  const hasKovitoboardDeny = denyCoversKovitoboard(merged.deny)

  const overallOk = permissionModeOk && hasKovitoboardDeny && !bypassActive

  // Surface the project-level path when both exist (it is the more
  // specific override surface); fall back to the user-level path.
  const effectivePath = projectResolved.path ?? userResolved.path

  return {
    permissionMode: {
      current: merged.permissionMode,
      recommended: 'default',
      ok: permissionModeOk,
    },
    denyPattern: {
      hasKovitoboardDeny,
      ok: hasKovitoboardDeny,
      remediation:
        'Add ".kovitoboard/" to permissions.deny in your Claude Code settings.',
    },
    bypassMode: {
      active: bypassActive,
      ok: !bypassActive,
    },
    overallOk,
    reason: 'ok',
    settingsFilePath: effectivePath,
  }
}

/**
 * Emit a redacted structured log entry summarizing the warning state.
 *
 * Redaction is applied automatically by `buildLogRedactor()` via
 * `formatters.log` (`logging-baseline.md` v1.4 §9.3 / §12.7), so this
 * helper does NOT need to manually mask the `settingsFilePath` or
 * other values. Failure-mode entries are emitted at the call site of
 * `checkClaudeCodeSettings()` so that the structural cause is
 * captured even when the success-path summary cannot run.
 */
export function logCheckResult(result: SettingsCheckResult): void {
  if (result.overallOk) {
    log.debug(
      {
        event: 'claude-code-settings-check-passed',
        settingsFilePath: result.settingsFilePath,
      },
      'Claude Code recommended settings check passed'
    )
    return
  }
  if (result.reason !== 'ok') {
    // Already logged by `checkClaudeCodeSettings()`.
    return
  }
  const surfaces: Array<'permissionMode' | 'denyPattern' | 'bypassMode'> = []
  if (!result.permissionMode.ok) surfaces.push('permissionMode')
  if (!result.denyPattern.ok) surfaces.push('denyPattern')
  if (!result.bypassMode.ok) surfaces.push('bypassMode')
  for (const setting of surfaces) {
    const currentValue =
      setting === 'permissionMode'
        ? result.permissionMode.current
        : setting === 'denyPattern'
          ? String(result.denyPattern.hasKovitoboardDeny)
          : String(result.bypassMode.active)
    const recommendation =
      setting === 'permissionMode'
        ? 'default'
        : setting === 'denyPattern'
          ? 'include .kovitoboard/ in permissions.deny'
          : 'disable bypassPermissions'
    log.warn(
      {
        event: 'claude-code-settings-warning',
        setting,
        currentValue,
        recommendation,
        settingsFilePath: result.settingsFilePath,
      },
      'Claude Code settings have non-recommended values'
    )
  }
}

/**
 * Compare two check results structurally to decide whether the dismiss
 * state from a previous session still represents the current warning
 * (T-2-3 mitigation). Drift on any surfaced check item invalidates the
 * dismiss; `bypassMode.active === true` always invalidates so the
 * toast re-surfaces (Invariant I-8).
 */
function dismissSnapshotMatchesCurrent(
  dismissed: SettingsCheckResult,
  current: SettingsCheckResult
): boolean {
  if (current.bypassMode.active) return false
  return (
    dismissed.permissionMode.current === current.permissionMode.current &&
    dismissed.permissionMode.ok === current.permissionMode.ok &&
    dismissed.denyPattern.ok === current.denyPattern.ok &&
    dismissed.bypassMode.active === current.bypassMode.active &&
    dismissed.overallOk === current.overallOk &&
    dismissed.reason === current.reason
  )
}

/** Description of how the dismiss state applies to a current check result. */
export interface DismissEvaluation {
  /** Whether the toast should be hidden right now. */
  suppressToast: boolean
  /**
   * Effective ISO timestamp that callers should treat as the dismiss
   * boundary. Capped server-side to `dismissedAtRaw + 24h` so future-
   * dated injections cannot extend the cooldown indefinitely (T-2-3).
   */
  effectiveExpiresAt: string | null
}

/**
 * Evaluate whether a persisted dismiss state suppresses the toast for
 * the current check result.
 *
 * Returns `{ suppressToast: false }` when bypass mode is active (T-2-3
 * I-8), when the snapshot does not match, when the cooldown window has
 * elapsed, or when the raw `dismissedAt` is invalid / future-dated
 * beyond `now + 24h`.
 */
export function evaluateDismiss(
  current: SettingsCheckResult,
  warning: ClaudeCodeSettingsWarning | undefined,
  nowMs: number = Date.now()
): DismissEvaluation {
  if (current.overallOk) {
    return { suppressToast: true, effectiveExpiresAt: null }
  }
  if (current.bypassMode.active) {
    // I-8: bypass mode active re-surfaces unconditionally.
    return { suppressToast: false, effectiveExpiresAt: null }
  }
  if (!warning) return { suppressToast: false, effectiveExpiresAt: null }
  const dismissedAt = Date.parse(warning.dismissedAt)
  if (!Number.isFinite(dismissedAt)) {
    return { suppressToast: false, effectiveExpiresAt: null }
  }
  // T-2-3: cap the effective dismiss timestamp to `now + 24h` so an
  // attacker-injected far-future value collapses to a normal cooldown
  // window. We compute the cap from the *current* time, not the
  // recorded dismiss time, so values past `now` are clamped to `now`
  // before adding the cooldown.
  const effectiveDismissedAt = Math.min(dismissedAt, nowMs)
  const expiresAt = effectiveDismissedAt + DISMISS_COOLDOWN_MS
  if (expiresAt <= nowMs) {
    return { suppressToast: false, effectiveExpiresAt: null }
  }
  if (!dismissSnapshotMatchesCurrent(warning.dismissedResult, current)) {
    return { suppressToast: false, effectiveExpiresAt: null }
  }
  return {
    suppressToast: true,
    effectiveExpiresAt: new Date(expiresAt).toISOString(),
  }
}

/** Convenience: build a dismiss record from a current check + clock. */
export function buildDismissRecord(
  current: SettingsCheckResult,
  nowMs: number = Date.now()
): ClaudeCodeSettingsWarning {
  return {
    dismissedAt: new Date(nowMs).toISOString(),
    dismissedResult: current,
  }
}

/**
 * Decide whether the supervisor should record the warning in
 * `server.log`. Skipped when the user already reviewed the warning
 * during onboarding within the cooldown window so we do not duplicate
 * the surface in the noisy startup log on every restart.
 */
export function shouldLogStartupWarning(
  result: SettingsCheckResult,
  setting: KovitoboardSetting | null,
  nowMs: number = Date.now()
): boolean {
  if (result.overallOk) return false
  if (result.bypassMode.active) return true // I-8 — always surface bypass
  const reviewedAt = setting?.onboarding?.securityRecommendationsReviewedAt
  if (reviewedAt) {
    const reviewedMs = Date.parse(reviewedAt)
    if (Number.isFinite(reviewedMs) && nowMs - reviewedMs < DISMISS_COOLDOWN_MS) {
      return false
    }
  }
  return true
}

/**
 * Convenience: install a watcher on the effective settings file so a
 * runtime mutation (T-2-4) re-runs the check and notifies callers.
 *
 * Returns `null` when there is no path to watch (no settings file at
 * either location yet). Callers should re-attach the watcher after a
 * subsequent check finds a path.
 */
export function watchSettingsFile(
  fs: FileAccessLayer,
  path: string,
  onMutation: () => void
): WatchHandle | null {
  try {
    return fs.watch(path, (event) => {
      if (event.type === 'change' || event.type === 'add' || event.type === 'unlink') {
        try {
          onMutation()
        } catch (err) {
          log.error(
            { err, event: event.type },
            'Settings file mutation handler threw; ignoring'
          )
        }
      } else if (event.type === 'error') {
        log.warn({ err: event.error }, 'Settings file watcher reported error')
      }
    })
  } catch (err) {
    log.warn({ err, path }, 'Failed to install settings file watcher')
    return null
  }
}

export { DISMISS_COOLDOWN_MS, UNREADABLE }
