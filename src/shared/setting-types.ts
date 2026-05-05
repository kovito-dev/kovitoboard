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
}
