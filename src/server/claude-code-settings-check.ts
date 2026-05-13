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
 * Hard cap on the size of a Claude Code settings file we are willing
 * to read in one shot. CodeX attempt 2 flagged that an unbounded
 * `readFileSync` + `JSON.parse` on an attacker-controlled path can
 * stall the event loop or exhaust memory. 1 MiB is well above any
 * realistic settings file (the bundled Claude Code defaults are
 * < 10 KiB) and keeps the parse window cheap.
 */
const SETTINGS_FILE_SIZE_LIMIT_BYTES = 1024 * 1024

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

/** Check whether `child` is `parent` itself or a path inside `parent`. */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(parentWithSep)
}

/**
 * Resolve the project-level Claude Code settings file path, applying
 * `fs.realpathSync` so a `.claude` directory symlink that redirects
 * outside the project tree is rejected (T-2-1 mitigation).
 *
 * Returns `null` when the file does not exist. Sets `rejected: true`
 * when the realpath resolution escapes the project root *and* the
 * user's home directory — both anchors are valid origins for a real
 * `.claude` file (test fixtures live under `/tmp`, CI workspaces live
 * under `/runner/_work`, etc.), so the previous "must be under ~"
 * rule was too strict and broke legitimate installations. We still
 * reject when a symlink redirects to a third-party location that is
 * neither the project tree nor the user's home tree.
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
  // T-2-1: accept when the resolved path stays inside the project
  // tree (the common case, including symlinks within the project)
  // OR when it lands inside the user's home directory (a deliberate
  // user-level shared config). Reject any other redirection.
  if (!isWithin(resolved, projectRoot) && !isWithin(resolved, home)) {
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
  if (!isWithin(resolved, home)) {
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

/**
 * Validate the nested shape of a parsed settings file. The top-level
 * `JSON.parse` only confirms that we have an object; without this
 * check a repo-provided payload like
 * `{ "permissionMode": {}, "permissions": { "deny": [".kovitoboard/"] } }`
 * would slip past as `overallOk: true` because `mergeSettings()`
 * silently substitutes safe defaults for unexpected types (CodeX
 * attempt 4 — fail-open schema validation). We do NOT reject unknown
 * top-level keys — Claude Code adds new fields over time and KB only
 * inspects the recommended-settings subset — but the types of the
 * fields we *do* consult must match the Claude Code schema.
 */
function validateNestedShape(value: ClaudeCodeRawSettings): boolean {
  if (
    value.permissionMode !== undefined &&
    typeof value.permissionMode !== 'string'
  ) {
    return false
  }
  if (value.permissions !== undefined) {
    if (value.permissions === null || typeof value.permissions !== 'object') {
      return false
    }
    if (value.permissions.deny !== undefined && !Array.isArray(value.permissions.deny)) {
      return false
    }
  }
  return true
}

/**
 * Read + JSON.parse a settings file with a fail-closed posture.
 *
 * Enforces a 1 MiB size cap before the read so an attacker-controlled
 * path cannot stall the event loop or exhaust memory with a multi-MiB
 * JSON payload (CodeX attempt 2 — resource exhaustion). When `statSync`
 * itself throws we treat it as a generic read error so the caller
 * still surfaces the fail-closed warning surface.
 */
function readAndParse(
  fs: FileAccessLayer,
  path: string
): { ok: true; value: ClaudeCodeRawSettings } | { ok: false; reason: SettingsCheckReason } {
  try {
    const stat = fs.statSync(path)
    if (stat.size > SETTINGS_FILE_SIZE_LIMIT_BYTES) {
      return { ok: false, reason: 'file-too-large' }
    }
  } catch {
    return { ok: false, reason: 'read-error' }
  }
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
  const candidate = parsed as ClaudeCodeRawSettings
  if (!validateNestedShape(candidate)) {
    return { ok: false, reason: 'schema-mismatch' }
  }
  return { ok: true, value: candidate }
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

/**
 * Decide whether a Claude Code deny entry actually covers this KB
 * instance's project-local `.kovitoboard/` directory.
 *
 * Accepts only the recommended forms documented for project-relative
 * patterns:
 *
 *   - `.kovitoboard`             (bare directory)
 *   - `.kovitoboard/`            (trailing slash variant)
 *   - `.kovitoboard/**`          (recursive glob)
 *   - `.kovitoboard/<...>`       (any subpath inside)
 *
 * Each form may be wrapped in a Claude Code action prefix such as
 * `Read(...)`, `Bash(...)`, or `Edit(...)`; the wrapper is stripped
 * before matching.
 *
 * Rejects:
 *   - absolute-path rules like `/tmp/.kovitoboard/**` (CodeX
 *     attempt 4 — overly permissive deny matching),
 *   - parent-traversal rules (`../.kovitoboard/...`),
 *   - and unrelated entries that merely contain the substring
 *     `.kovitoboard` (e.g. `apps/cool.kovitoboard-helper`).
 *
 * Pattern compilation / actual enforcement remains Claude Code's
 * responsibility (spec §4 responsibility boundary); this function
 * only verifies that the user has expressed an intent that names
 * the KB state directory specifically.
 */
function denyCoversKovitoboard(deny: string[]): boolean {
  // Strip a single optional action wrapper like `Read(...)`.
  const ACTION_WRAPPER = /^[A-Za-z][A-Za-z0-9_-]*\((.*)\)$/
  for (const rawEntry of deny) {
    if (typeof rawEntry !== 'string') continue
    const m = ACTION_WRAPPER.exec(rawEntry.trim())
    const stripped = (m ? m[1] : rawEntry).trim()
    if (stripped.length === 0) continue
    // Reject anchored / traversal forms.
    if (stripped.startsWith('/') || stripped.startsWith('~')) continue
    if (stripped.startsWith('./')) continue
    if (stripped.startsWith('../')) continue
    if (
      stripped === '.kovitoboard' ||
      stripped === '.kovitoboard/' ||
      stripped === '.kovitoboard/**' ||
      stripped.startsWith('.kovitoboard/')
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
 * Optional ambient cooldown signals beyond the explicit dismiss state.
 * Currently honors `onboarding.securityRecommendationsReviewedAt` so a
 * user who just reviewed the Security recommendations step in the
 * wizard does not immediately re-encounter the same toast on
 * `/agents` (CodeX attempt 2 — cooldown regression).
 */
export interface DismissContext {
  warning?: ClaudeCodeSettingsWarning
  setting?: KovitoboardSetting | null
}

/**
 * Evaluate whether a persisted dismiss state suppresses the toast for
 * the current check result.
 *
 * Returns `{ suppressToast: false }` when bypass mode is active (T-2-3
 * I-8), when the snapshot does not match, when the cooldown window has
 * elapsed, or when the raw `dismissedAt` is invalid / future-dated
 * beyond `now + 24h`.
 *
 * The optional `context.setting` is accepted for API parity with the
 * route layer but is no longer used to short-circuit the dismiss
 * check via `securityRecommendationsReviewedAt`. The onboarding
 * acknowledgement now seeds a real `claudeCodeSettingsWarning`
 * dismiss record on completion (see `OnboardingPage.handleComplete`),
 * so the drift comparison below applies uniformly whether the
 * cooldown was started from the wizard or from the post-onboarding
 * toast (CodeX attempt 3 — stale security suppression).
 */
export function evaluateDismiss(
  current: SettingsCheckResult,
  warning: ClaudeCodeSettingsWarning | undefined,
  nowMs: number = Date.now(),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  context: Pick<DismissContext, 'setting'> = {}
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

/**
 * Build a dismiss record from a current check + clock.
 *
 * Strips `settingsFilePath` from the persisted snapshot — the path is
 * not used by `evaluateDismiss` matching and writing the user's
 * absolute home path into project-local `.kovitoboard/setting.json`
 * is an unnecessary information disclosure (CodeX attempt 2 —
 * sensitive path persistence).
 */
export function buildDismissRecord(
  current: SettingsCheckResult,
  nowMs: number = Date.now()
): ClaudeCodeSettingsWarning {
  return {
    dismissedAt: new Date(nowMs).toISOString(),
    dismissedResult: {
      ...current,
      settingsFilePath: null,
    },
  }
}

/**
 * Decide whether the supervisor should record the warning in
 * `server.log`. Skipped when the user already dismissed the warning
 * (within the cooldown window AND with no drift versus the recorded
 * snapshot) so we do not duplicate the surface in the startup log on
 * every restart. Bypass mode active always surfaces (I-8).
 */
export function shouldLogStartupWarning(
  result: SettingsCheckResult,
  setting: KovitoboardSetting | null,
  nowMs: number = Date.now()
): boolean {
  if (result.overallOk) return false
  if (result.bypassMode.active) return true // I-8 — always surface bypass
  const evaluation = evaluateDismiss(
    result,
    setting?.claudeCodeSettingsWarning,
    nowMs,
    { setting: setting ?? null },
  )
  return !evaluation.suppressToast
}

/**
 * Convenience: install a watcher on the effective settings file so a
 * runtime mutation (T-2-4) re-runs the check and notifies callers.
 *
 * Returns `null` when the watcher could not be installed (e.g. the
 * underlying `fs.watch` threw). When the settings file does not yet
 * exist, callers should use `watchSettingsDirectories` to monitor
 * both `~/.claude/` and `<projectRoot>/.claude/` so a settings file
 * that appears after startup is picked up without a restart.
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

/**
 * Watch the user-level and project-level surfaces so a settings file
 * that appears after KB startup is picked up the next time the check
 * runs.
 *
 * For each anchor (home, project root) we prefer to watch the
 * existing `.claude/` directory directly. When the `.claude` directory
 * does not exist yet — which is the typical state on a fresh box —
 * we fall back to watching the anchor itself at `depth: 0` and apply
 * a path filter so only the relevant `.claude` creation event triggers
 * the re-check. Without the filter the anchor watcher would react to
 * every unrelated home/project mutation and create avoidable CPU /
 * log churn (CodeX attempt 3 — resource exhaustion watcher scope).
 */
export function watchSettingsDirectories(
  fs: FileAccessLayer,
  projectRoot: string,
  onMutation: () => void,
  homeOverride?: string
): WatchHandle | null {
  const home = homeOverride ?? homedir()
  const projectAbs = resolve(projectRoot)

  interface Target {
    dir: string
    /**
     * When true, this watcher is monitoring the anchor itself (because
     * `.claude` does not exist yet) and must drop events for unrelated
     * siblings. When false, the watcher is rooted at `.claude/` so all
     * events are settings-relevant.
     */
    anchorOnly: boolean
    expectedChildName: string
  }

  const targets: Target[] = []
  for (const anchor of [home, projectAbs]) {
    const claudeDir = join(anchor, '.claude')
    if (fs.existsSync(claudeDir)) {
      targets.push({ dir: claudeDir, anchorOnly: false, expectedChildName: '.claude' })
    } else if (fs.existsSync(anchor)) {
      targets.push({ dir: anchor, anchorOnly: true, expectedChildName: '.claude' })
    }
  }

  const handles: WatchHandle[] = []
  for (const target of targets) {
    try {
      const handle = fs.watch(
        target.dir,
        (event) => {
          if (event.type === 'error') {
            log.warn({ err: event.error }, 'Settings directory watcher reported error')
            return
          }
          if (
            event.type !== 'add' &&
            event.type !== 'change' &&
            event.type !== 'unlink' &&
            event.type !== 'addDir'
          ) {
            return
          }
          const path = typeof event.path === 'string' ? event.path : ''
          const basename = path.split(/[/\\]/).pop() ?? ''
          if (target.anchorOnly) {
            // Anchor-only watchers see every direct child of the home /
            // project directory; restrict the callback to the
            // `.claude` entry to avoid churning on unrelated mutations.
            if (basename !== target.expectedChildName) return
          } else {
            // `.claude/`-rooted watchers see every entry inside the
            // directory; restrict the callback to `settings.json`
            // mutations so noisy or attacker-controlled siblings (for
            // example `.claude/projects/*.jsonl`) do not trigger
            // repeated re-checks + log emission (CodeX attempt 4 —
            // watcher-triggered log churn). `addDir` events without
            // a basename match are ignored for the same reason.
            if (basename !== 'settings.json') return
          }
          try {
            onMutation()
          } catch (err) {
            log.error(
              { err, event: event.type },
              'Settings directory mutation handler threw; ignoring'
            )
          }
        },
        // Limit anchor-level watchers to the immediate children of the
        // anchor (depth 0 = `path` itself + first-level entries). This
        // is the chokidar contract; the `.claude`-rooted watcher
        // intentionally omits the option so per-file mutations inside
        // it still fire.
        target.anchorOnly ? { depth: 0 } : undefined
      )
      handles.push(handle)
    } catch (err) {
      log.warn({ err, dir: target.dir }, 'Failed to install settings directory watcher')
    }
  }
  if (handles.length === 0) return null
  return {
    close: () => {
      for (const h of handles) {
        try {
          h.close()
        } catch {
          // best-effort
        }
      }
    },
  }
}

export { DISMISS_COOLDOWN_MS, UNREADABLE }
