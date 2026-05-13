/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Ambient Session Sidebar settings (DEC-020 v1.1 §2-4 / EU8).
 *
 * Per-app pinned agent assignments and sidebar preferences. Stored under
 * `ambientSidebar` in the KovitoBoard setting file. Treated as optional
 * for backward compatibility — older setting files predate this feature
 * and remain valid; the UI falls back to an empty configuration.
 *
 * Implementation notes (spec §2.5 "Kobi-prerequisite removal"):
 *   - Pinned agents are resolved dynamically via `GET /api/agents`. Do
 *     NOT hardcode `kovito-concierge` or any other agent ID anywhere.
 *   - When a pinned agent has been deleted, treat the entry as `null`
 *     (i.e. the picker falls back to the unselected state).
 */
export interface AmbientSidebarSetting {
  /**
   * Map of `appId` → pinned `agentId | null`. `null` records an
   * intentional "no pin yet" state for that screen so the UI can still
   * remember which app IDs the user has visited.
   *
   * `appId` resolution rules (spec §2.5):
   *   - Builtin screens: page identifier (`agents`, `recipes`, `settings`, …)
   *   - User extension apps (`/ext/<id>`): the extension `id`
   *   - Recipe screens: the recipe ID
   */
  pinned: Record<string, string | null>
  /** Fallback agent when no per-screen pin exists. `null` = no fallback. */
  globalDefault: string | null
  /** Whether the sidebar should start opened on app launch. Default false. */
  openByDefault: boolean
}

/**
 * Optional version-check settings (`v0.1.0-version-display.md` §3.3).
 * Lets the user disable the GitHub Releases poll without setting an
 * environment variable. Environment variable `KOVITO_NO_VERSION_CHECK=1`
 * always wins when set; this struct is the secondary, persistent
 * mechanism.
 */
export interface VersionCheckSetting {
  /** When false, the version-info module skips all external network
   *  calls and `/api/version/recheck` returns 403. Default true. */
  enabled: boolean
  /** Cache TTL for the GitHub Releases response, in hours. Default 24
   *  per spec §3.2. Min 1, max 168 (one week). */
  ttlHours: number
}

/**
 * Result of the Claude Code recommended-settings check
 * (`claude-code-settings-check.ts`, spec
 * `trust-prompt-relay.md` v1.3 §10.5 / `onboarding-scenarios.md`
 * v1.2 §9.5 / `logging-baseline.md` v1.4 §12.7).
 *
 * Reused as the runtime check output, the toast UI prop, and the
 * `claudeCodeSettingsWarning.dismissedResult` snapshot so that diff
 * detection can compare apples to apples.
 *
 * Threat coverage (handoff v1.1 §8):
 *   - T-2-1: `permissionMode.current` may carry a sentinel string
 *     `'__unreadable__'` when the file path resolved outside the
 *     user's home directory; the `reason` field on the surrounding
 *     result captures the structural fail-closed cause.
 *   - T-2-2: `reason` enumerates the structural failure mode so
 *     downstream redaction / UI can distinguish read-error from a
 *     genuine non-recommended value (fail-closed posture).
 */
export type SettingsCheckReason =
  | 'ok'
  | 'read-error'
  | 'parse-error'
  | 'schema-mismatch'
  | 'path-resolution-rejected'
  | 'file-too-large'

export interface SettingsCheckResult {
  /** `permissionMode` recommendation check (T-2-1 / T-2-2 covered) */
  permissionMode: {
    current: string
    recommended: 'default'
    ok: boolean
  }
  /** `.kovitoboard/` deny pattern check */
  denyPattern: {
    hasKovitoboardDeny: boolean
    ok: boolean
    remediation: string
  }
  /** `bypassPermissions` mode check */
  bypassMode: {
    active: boolean
    ok: boolean
  }
  /**
   * Aggregate verdict. `false` when any check item is non-recommended
   * OR when `reason !== 'ok'` (fail-closed for T-2-2).
   */
  overallOk: boolean
  /**
   * Structural cause when `overallOk` is false because of a read/parse
   * failure rather than a non-recommended setting value. Always `'ok'`
   * when the check completed normally (regardless of whether items are
   * recommended).
   */
  reason: SettingsCheckReason
  /**
   * Path that was inspected (after `fs.realpath` normalization for
   * T-2-1). Redacted via `buildLogRedactor()` when written to
   * `server.log` per spec `logging-baseline.md` v1.4 §12.7.
   */
  settingsFilePath: string | null
}

/**
 * Optional persistence of the Claude Code recommended-settings warning
 * dismiss state (handoff
 * `v02x-phase1-claude-code-recommended-settings-check-request.md`
 * v1.1 §3.5 / §8.2 T-2-3).
 *
 * Threat model (T-2-3):
 *   - `dismissedAt` is bounded server-side to `now + 24h` on read; any
 *     larger value (e.g. attacker-injected `'2099-01-01T00:00:00Z'`)
 *     is truncated by `claude-code-settings-check.ts` before being
 *     honored, so a forged future timestamp cannot permanently
 *     suppress the warning.
 *   - `dismissedResult` is matched against the *current* check result
 *     when deciding whether to re-surface the toast (any setting drift
 *     invalidates the dismiss state).
 *   - `bypassMode.active === true` is excluded from the dismiss
 *     contract: a user who is in bypass mode is re-surfaced every
 *     startup regardless of dismiss state (Invariant I-8).
 */
export interface ClaudeCodeSettingsWarning {
  /** ISO 8601 timestamp when the user dismissed the toast. */
  dismissedAt: string
  /**
   * Snapshot of the check result at dismiss time so that drift
   * detection can re-surface the toast when the user changes their
   * Claude Code settings between sessions.
   */
  dismissedResult: SettingsCheckResult
}

/**
 * Optional CLAUDE.md guidance-injection settings
 * (spec `claude-md-guidance-injection.md` v1.2 §7.1 SSOT).
 *
 * KovitoBoard injects a minimal guidance block into
 * `<projectRoot>/CLAUDE.md` exactly once when onboarding completes
 * (state transition `onboarding.completedAt: null → string`). The block
 * is wrapped between `<!-- KB:GUIDANCE_START -->` and
 * `<!-- KB:GUIDANCE_END -->` markers and points all agents at
 * `kovitoboard/docs/agent-ref/INDEX.md`.
 *
 * - `disabled`: when true, the injection is skipped entirely. The
 *   onboarding wizard exposes an opt-out checkbox that flips this flag
 *   before the settings PUT (spec §7.2).
 * - `lastInjectedAt`: timestamp recorded when the block was actually
 *   written (created or appended). Absent when the file already had
 *   the marker (no-op) or when injection failed.
 *
 * Both fields are optional and the whole struct may be omitted; the
 * server treats missing values as `disabled = false` / never injected.
 */
export interface ClaudeMdGuidanceSetting {
  /** When true, the onboarding-completion injection is skipped. */
  disabled?: boolean
  /** ISO 8601 UTC timestamp of the last successful injection. */
  lastInjectedAt?: string
}

/** Type definition for the KovitoBoard settings file (.kovitoboard/setting.json) */
export interface KovitoboardSetting {
  version: '1.1'
  user: {
    displayName: string
    avatar: string | null
  }
  project: {
    name: string
    description: string
    path: string  // Absolute path to the project root (DEC-009)
  }
  locale: 'ja' | 'en'
  onboarding: {
    completedAt: string | null
    wizardVersion: string
    /**
     * Historical: an earlier revision of the Phase 1 ② wizard
     * recorded the time at which the user reviewed the Security
     * recommendations step. The dismiss-cooldown logic now consumes
     * `claudeCodeSettingsWarning` directly (it carries the reviewed
     * snapshot for drift detection) and `securityRecommendationsReviewedAt`
     * is no longer read anywhere. The validator still accepts the
     * field for backward compatibility with older `setting.json`
     * files written before the migration, but new writes omit it
     * (CodeX attempt 13 — dead state).
     */
    securityRecommendationsReviewedAt?: string
  }
  /**
   * Optional logging settings (DEC-017). When omitted, KovitoBoard
   * applies defaults (retentionDays: 7).
   */
  logging?: {
    retentionDays?: number
  }
  /**
   * Optional Ambient Session Sidebar settings (DEC-020 / EU8). When
   * omitted, the sidebar UI mounts with empty pin map, no global
   * default, and `openByDefault = false`.
   */
  ambientSidebar?: AmbientSidebarSetting
  /**
   * Optional version-check settings (v0.1.0-version-display.md). When
   * omitted, version checking is enabled with a 24-hour cache TTL.
   */
  versionCheck?: VersionCheckSetting
  /**
   * Optional CLAUDE.md guidance-injection settings
   * (`claude-md-guidance-injection.md` v1.2 §7.1). When omitted, the
   * server applies defaults (`disabled = false`, no `lastInjectedAt`).
   */
  claudeMdGuidance?: ClaudeMdGuidanceSetting
  /**
   * Optional persisted dismiss state for the Claude Code recommended-
   * settings warning (handoff
   * `v02x-phase1-claude-code-recommended-settings-check-request.md`
   * v1.1 §3.5). Omitted when the user has never dismissed the toast.
   */
  claudeCodeSettingsWarning?: ClaudeCodeSettingsWarning
}
