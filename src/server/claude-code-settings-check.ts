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
 * Sentinel returned when `permissionMode` is a string Claude Code does
 * not document. Substituting a fixed token before the value is echoed
 * into the toast / `server.log` keeps a hostile settings file from
 * injecting an arbitrarily large unsupported value into the DOM or
 * the log stream (CodeX attempt 10 — input validation / resource
 * exhaustion).
 */
const PERMISSION_MODE_INVALID = '__invalid__'

/**
 * Documented Claude Code permission modes. Mirrors the Anthropic
 * upstream contract (`docs.anthropic.com/en/docs/claude-code/settings`).
 * Any other string is normalized to `PERMISSION_MODE_INVALID` before
 * being returned in `SettingsCheckResult.permissionMode.current`.
 */
const SUPPORTED_PERMISSION_MODES = new Set<string>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
])

/**
 * Normalize a raw permissionMode string into a value that is safe to
 * render and log. Known modes pass through; anything else collapses
 * to the `__invalid__` sentinel (CodeX attempt 10).
 */
function normalizePermissionMode(raw: string): string {
  if (SUPPORTED_PERMISSION_MODES.has(raw)) return raw
  return PERMISSION_MODE_INVALID
}

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
 * when the realpath lands somewhere other than one of the two
 * explicitly trusted destinations:
 *
 *   1. anywhere inside the project tree — the common case, including
 *      intra-project symlinks (test fixtures under `/tmp`, CI
 *      workspaces under `/runner/_work`, etc.).
 *   2. exactly `${home}/.claude/settings.json` — to support the
 *      pattern where a project links its `.claude/settings.json` to
 *      the user-level shared config.
 *
 * Earlier revisions accepted any realpath under `${home}`, but CodeX
 * attempt 8 pointed out that this lets an untrusted project widen the
 * read scope to arbitrary JSON files in the user's home (e.g. a
 * symlink to `~/.ssh/config.json`). The narrower whitelist here
 * preserves the legitimate use case while restoring the T-2-1
 * boundary.
 */
/**
 * When `realpathSync()` throws (typically `ENOENT`), we must
 * distinguish two cases:
 *
 *   (a) the candidate directory entry does NOT exist at all → the
 *       settings file is simply missing; not a fail-closed
 *       condition.
 *   (b) the candidate IS a symlink but the target is broken → this
 *       is a structural path-resolution failure and must be
 *       reported as `rejected: true` so the rest of the check
 *       fail-closes (CodeX attempt 12 — path validation gap).
 *
 * We use `lstatSync()` (which does NOT follow symlinks) to make
 * this distinction. An `ENOENT` from `lstatSync()` means the entry
 * really is absent; a successful `lstatSync()` with
 * `isSymbolicLink === true` means we are looking at a broken link.
 */
function classifyRealpathFailure(
  fs: FileAccessLayer,
  candidate: string
): { path: null; rejected: boolean } {
  try {
    const lst = fs.lstatSync(candidate)
    if (lst.isSymbolicLink) {
      return { path: null, rejected: true }
    }
    // Non-symlink entry exists but realpath still failed — treat as
    // rejected (something else is wrong with the path).
    return { path: null, rejected: true }
  } catch (err) {
    // CodeX attempt 14 — only a strict `ENOENT` means "no such
    // entry"; anything else (EACCES / EPERM / EIO / EMFILE etc) is
    // a real I/O failure that must fail closed. A blanket catch
    // would let a permission-denied home directory degrade into the
    // dismissible "missing settings" branch and weaken the T-2-2
    // posture.
    const code = isNodeError(err) ? err.code : undefined
    if (code === 'ENOENT') {
      return { path: null, rejected: false }
    }
    return { path: null, rejected: true }
  }
}

/** Narrow an unknown thrown value to a Node.js errno-style error. */
function isNodeError(value: unknown): value is { code?: string } {
  return typeof value === 'object' && value !== null && 'code' in value
}

function resolveProjectSettingsPath(
  fs: FileAccessLayer,
  projectRoot: string,
  home: string
): { path: string | null; rejected: boolean } {
  const candidate = join(projectRoot, '.claude', 'settings.json')
  // CodeX attempt 12 — drive resolution directly through
  // `realpathSync` so a broken symlink fails closed instead of
  // silently masquerading as "no settings file". The `lstat`-based
  // classifier below distinguishes a missing entry from a broken
  // link.
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    return classifyRealpathFailure(fs, candidate)
  }
  const userClaudePath = join(home, '.claude', 'settings.json')
  const withinScope =
    isWithin(resolved, projectRoot) || resolved === userClaudePath
  if (!withinScope) {
    return { path: null, rejected: true }
  }
  // The regular-file gate is enforced inside `readFileBoundedSync()`
  // against the open fd (CodeX attempt 18). Path-level lstat is no
  // longer used here so a TOCTOU swap between `lstat` and `open`
  // cannot turn a regular file into a FIFO mid-flight.
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
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    return classifyRealpathFailure(fs, candidate)
  }
  // CodeX attempt 13 — narrow the user-level whitelist to the
  // canonical Claude Code settings path. Previously any realpath
  // under `$HOME` was accepted, which let a `~/.claude/settings.json`
  // symlink redirect KB to an unrelated JSON file in the home
  // directory (e.g. `~/configs/some-other-app.json`). Only the
  // canonical destination matches the documented Claude Code surface.
  if (resolved !== candidate) {
    return { path: null, rejected: true }
  }
  // Regular-file gate is enforced inside `readFileBoundedSync` on
  // the open fd (CodeX attempt 18).
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
    if (value.permissions.deny !== undefined) {
      if (!Array.isArray(value.permissions.deny)) return false
      // Every entry must be a string. Mixed-type arrays such as
      // `[".kovitoboard/", {}]` previously slipped through and were
      // silently filtered by `mergeSettings()`, which could surface
      // as `overallOk: true` instead of the intended fail-closed
      // schema mismatch (CodeX attempt 9 — incomplete schema
      // validation).
      for (const entry of value.permissions.deny) {
        if (typeof entry !== 'string') return false
      }
    }
  }
  return true
}

/**
 * Read + JSON.parse a settings file with a fail-closed posture.
 *
 * Uses `fs.readFileBoundedSync` so the 1 MiB cap is enforced against
 * the actual file size on the open file descriptor BEFORE any bytes
 * are buffered. This fixes two earlier weaknesses noted by CodeX
 * reviews:
 *
 *   - **TOCTOU race** (attempt 16): an earlier revision called
 *     `statSync(path)` and then `readFileSync(path)` on the same
 *     path, leaving a window where a repo-controlled file could be
 *     swapped or grown between the two syscalls. The bounded reader
 *     opens once and stats the same fd, so no second lookup happens.
 *   - **Memory bound DoS** (attempt 17): an alternative revision
 *     read the entire file first and only checked size afterwards,
 *     which still let a multi-gigabyte target consume RAM before
 *     rejection. The bounded reader returns `{ oversized: true }`
 *     after `fstat` and never loads the body.
 */
function readAndParse(
  fs: FileAccessLayer,
  path: string
): { ok: true; value: ClaudeCodeRawSettings } | { ok: false; reason: SettingsCheckReason } {
  let read: ReturnType<FileAccessLayer['readFileBoundedSync']>
  try {
    read = fs.readFileBoundedSync(path, SETTINGS_FILE_SIZE_LIMIT_BYTES)
  } catch {
    return { ok: false, reason: 'read-error' }
  }
  if (read.oversized) {
    return { ok: false, reason: 'file-too-large' }
  }
  if (read.notRegular) {
    // Same `path-resolution-rejected` surface as a symlink escape:
    // structurally we could not interpret the entry, so the toast
    // shows the fail-closed banner (CodeX attempt 18 — TOCTOU file
    // validation).
    return { ok: false, reason: 'path-resolution-rejected' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.content)
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
 * Merge the project-level over user-level Claude Code settings.
 *
 * Mirrors the Anthropic-documented Claude Code precedence contract
 * (https://docs.anthropic.com/en/docs/claude-code/settings):
 *
 *   - **Scalar fields** (`permissionMode`): project-level overrides
 *     user-level. When the project file omits the key, the user-level
 *     value is consulted; when neither is set, KB falls back to the
 *     documented default `'default'`. A present-but-blank string is
 *     NOT treated as "unset" — it propagates and is then normalized
 *     to `__invalid__` (CodeX attempt 12 / 13). The result is
 *     subsequently fed through `normalizePermissionMode()` so an
 *     unknown literal cannot widen the surface that reaches the
 *     toast / `server.log`.
 *   - **Array-valued fields** (`permissions.deny`): user-level and
 *     project-level entries are merged into a **union** (set
 *     semantics). A project-level deny list never silently shrinks
 *     the user-level deny set. The union is then matched against
 *     the whole-`.kovitoboard/` form whitelist in
 *     `denyCoversKovitoboard()`.
 *
 * Pattern compilation / enforcement of the deny entries themselves
 * is Claude Code's responsibility (handoff §4 responsibility
 * boundary); KB only checks structural intent, not effective match.
 */
function mergeSettings(
  user: ClaudeCodeRawSettings | null,
  project: ClaudeCodeRawSettings | null
): { permissionMode: string; deny: string[] } {
  const permissionMode = (() => {
    // CodeX attempt 12 — a present-but-blank `permissionMode` (e.g.
    // `""` or whitespace only) is NOT equivalent to "unset". Claude
    // Code may interpret a blank string differently from omitting
    // the key entirely, and silently falling back to the documented
    // `'default'` would let a malformed config look compliant. Pass
    // any present string through to `normalizePermissionMode`, which
    // collapses unknown values (including blanks) to the
    // `__invalid__` sentinel before they reach the UI / log layer.
    const projectMode = project?.permissionMode
    if (typeof projectMode === 'string') return projectMode
    const userMode = user?.permissionMode
    if (typeof userMode === 'string') return userMode
    // Truly unset (no key in either file) → Claude Code's documented
    // default is `"default"`.
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
 * Decide whether a Claude Code deny entry actually covers the *entire*
 * `.kovitoboard/` directory tree.
 *
 * Accepts only the whole-tree forms documented in the user-facing
 * recommendation:
 *
 *   - `.kovitoboard`             (bare directory — deny the whole dir)
 *   - `.kovitoboard/`            (trailing slash variant)
 *   - `.kovitoboard/**`          (recursive glob)
 *
 * Each form may be wrapped in a Claude Code action prefix such as
 * `Read(...)`, `Bash(...)`, or `Edit(...)`; the wrapper is stripped
 * before matching.
 *
 * Rejects:
 *   - absolute-path rules like `/tmp/.kovitoboard/**` (CodeX
 *     attempt 4 — overly permissive deny matching),
 *   - parent-traversal rules (`../.kovitoboard/...`),
 *   - unrelated entries that merely contain the substring
 *     `.kovitoboard` (e.g. `apps/cool.kovitoboard-helper`),
 *   - **and any descendant-only pattern** such as
 *     `.kovitoboard/cache/**` or `.kovitoboard/state.json`. Those
 *     leave the rest of `.kovitoboard/` writable and therefore do
 *     not satisfy the recommendation copy in the toast / wizard
 *     (CodeX attempt 10 — scope validation).
 *
 * Pattern compilation / actual enforcement remains Claude Code's
 * responsibility (spec §4 responsibility boundary); this function
 * only verifies that the user has expressed an intent to deny the
 * whole `.kovitoboard/` tree.
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
      stripped === '.kovitoboard/**'
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
  // The helper itself is intentionally side-effect free with respect
  // to logging — failure logging is owned by `logCheckResult()` so
  // GET /api/security/settings-check (which calls this helper per
  // request) cannot grow server.log unboundedly when the user has a
  // persistent fail-closed config (CodeX attempt 9 — log
  // amplification / resource exhaustion).
  if (userResolved.rejected || projectResolved.rejected) {
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
      return failClosedResult(r.reason, userResolved.path)
    }
    userSettings = r.value
  }
  if (projectResolved.path !== null) {
    const r = readAndParse(fs, projectResolved.path)
    if (!r.ok) {
      // Intentionally no log here — failure logging is centralized
      // in logCheckResult() (CodeX attempt 9 — log amplification).
      return failClosedResult(r.reason, projectResolved.path)
    }
    projectSettings = r.value
  }

  const merged = mergeSettings(userSettings, projectSettings)
  // Normalize the raw permissionMode against the documented Claude
  // Code whitelist BEFORE deriving the OK / bypass flags or
  // surfacing the value back to the renderer. Unknown values collapse
  // to the `__invalid__` sentinel so a hostile (or simply stale)
  // settings file cannot inject an arbitrarily large unsupported
  // string into the toast / server.log (CodeX attempt 10).
  const normalizedPermissionMode = normalizePermissionMode(merged.permissionMode)
  const permissionModeOk = normalizedPermissionMode === 'default'
  const bypassActive = normalizedPermissionMode === 'bypassPermissions'
  const hasKovitoboardDeny = denyCoversKovitoboard(merged.deny)

  const overallOk = permissionModeOk && hasKovitoboardDeny && !bypassActive

  // Surface the project-level path when both exist (it is the more
  // specific override surface); fall back to the user-level path.
  const effectivePath = projectResolved.path ?? userResolved.path

  return {
    permissionMode: {
      current: normalizedPermissionMode,
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
    // Fail-closed reason — emit a single structural-failure entry
    // here so logging stays centralized (CodeX attempt 9 — log
    // amplification). The supervisor call sites (`index.ts` startup +
    // watcher rerun) dedupe via signature comparison, so a steady-
    // state fail-closed config no longer hot-loops the log.
    log.warn(
      {
        event: 'claude-code-settings-check-failed',
        reason: result.reason,
        settingsFilePath: result.settingsFilePath,
      },
      'Claude Code settings could not be loaded'
    )
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
  // Fail-closed states must never be dismissable, regardless of what
  // is recorded in `claudeCodeSettingsWarning`. The HTTP dismiss
  // route already refuses to *create* such a record server-side, but
  // a locally crafted `.kovitoboard/setting.json` (for example a
  // recipe with write access that injects a matching snapshot) could
  // otherwise still suppress the warning here. Short-circuit before
  // the snapshot comparison so the "unreadable settings cannot be
  // dismissed" guarantee holds end-to-end (CodeX attempt 11 —
  // warning suppression bypass).
  if (current.reason !== 'ok') {
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
 * the re-check (CodeX attempt 3 — resource exhaustion watcher scope).
 *
 * When the anchor-only watcher observes a `.claude` creation event, it
 * immediately attaches a follow-up watcher rooted at the new
 * `.claude/` directory. This is the runtime upgrade path that CodeX
 * attempt 6 required: without it, a `settings.json` created inside the
 * just-materialized `.claude/` directory would never trigger a
 * re-check until the next KB restart. The follow-up watcher uses the
 * same `settings.json`-only basename filter as the eager path.
 */
export function watchSettingsDirectories(
  fs: FileAccessLayer,
  projectRoot: string,
  onMutation: () => void,
  homeOverride?: string
): WatchHandle | null {
  const home = homeOverride ?? homedir()
  const projectAbs = resolve(projectRoot)

  // Collect handles in one array so the consumer can close them all
  // through a single composite handle, including watchers that were
  // attached lazily after the initial pass.
  const handles: WatchHandle[] = []

  function attachClaudeDirWatcher(claudeDir: string): void {
    const expectedSettingsPath = join(claudeDir, 'settings.json')
    try {
      const handle = fs.watch(
        claudeDir,
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
          // CodeX attempt 19 — require an *exact* match against the
          // canonical `<claudeDir>/settings.json` so a nested
          // `<claudeDir>/projects/<id>/settings.json` (which chokidar
          // would still surface even at depth 0 if a sub-tree is
          // recursive) cannot retrigger reruns / log churn.
          if (path !== expectedSettingsPath) return
          try {
            onMutation()
          } catch (err) {
            log.error(
              { err, event: event.type },
              'Settings directory mutation handler threw; ignoring'
            )
          }
        },
        // Limit the watch to the immediate children of `.claude/` so
        // unrelated subtrees do not balloon the watch set.
        { depth: 0 },
      )
      handles.push(handle)
    } catch (err) {
      log.warn({ err, dir: claudeDir }, 'Failed to install .claude/ watcher')
    }
  }

  function attachAnchorWatcher(anchor: string, expectedChild: string): void {
    let upgraded = false
    try {
      const handle = fs.watch(
        anchor,
        (event) => {
          if (event.type === 'error') {
            log.warn({ err: event.error }, 'Settings anchor watcher reported error')
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
          if (basename !== expectedChild) return

          // Anchor-level events are settings-relevant by definition
          // here, so always notify before considering the upgrade.
          try {
            onMutation()
          } catch (err) {
            log.error(
              { err, event: event.type },
              'Settings anchor handler threw; ignoring'
            )
          }

          // Upgrade path: when `.claude` is first created (addDir /
          // add), attach a per-`.claude` watcher so subsequent
          // `settings.json` mutations inside it are observed without
          // requiring a KB restart. We only upgrade once to keep the
          // watcher set bounded even if chokidar replays the event.
          if (upgraded) return
          if (event.type !== 'addDir' && event.type !== 'add') return
          const claudeDir = join(anchor, expectedChild)
          if (!fs.existsSync(claudeDir)) return
          upgraded = true
          attachClaudeDirWatcher(claudeDir)
        },
        { depth: 0 }
      )
      handles.push(handle)
    } catch (err) {
      log.warn({ err, dir: anchor }, 'Failed to install settings anchor watcher')
    }
  }

  for (const anchor of [home, projectAbs]) {
    const claudeDir = join(anchor, '.claude')
    if (fs.existsSync(claudeDir)) {
      attachClaudeDirWatcher(claudeDir)
    } else if (fs.existsSync(anchor)) {
      attachAnchorWatcher(anchor, '.claude')
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
