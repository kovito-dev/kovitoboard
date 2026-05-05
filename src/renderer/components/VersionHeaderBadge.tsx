/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { t } from '../i18n'
import type { UseVersionInfoResult } from '../hooks/useVersionInfo'

/**
 * VersionHeaderBadge — header-resident warning chip
 * (`v0.1.0-version-display.md` §2.2 / §5.3).
 *
 * Surfaces version-related warnings the user should notice without
 * opening the popover. Fires only on:
 *   - Claude Code out-of-range (best-effort stays in popover only)
 *   - KB outdated (a newer release tag exists)
 *
 * Fail-silent: cache failures, "unknown" tier, and disabled mode
 * never render a badge — the spec is explicit about not promoting
 * "we couldn't reach upstream" into a warning.
 *
 * Click action: invokes `onClick` so the parent (TitleBar) can open
 * the StatusIndicator popover that hosts the matching VersionPanel.
 */

interface VersionHeaderBadgeProps {
  versionInfo: UseVersionInfoResult
  onClick: () => void
}

export function VersionHeaderBadge({ versionInfo, onClick }: VersionHeaderBadgeProps) {
  const { data, loading } = versionInfo
  if (loading || !data) return null

  const { kb, claudeCode, config } = data
  if (config.disabledBy !== null) return null

  const claudeOutOfRange = claudeCode.tier === 'out-of-range' && claudeCode.detected !== null
  const kbOutdated = !kb.isUpToDate && kb.latestFetchSucceeded && kb.latest !== null

  const warnings: string[] = []
  if (claudeOutOfRange) warnings.push('claude-out-of-range')
  if (kbOutdated) warnings.push('kb-outdated')

  if (warnings.length === 0) return null

  const label =
    warnings.length === 1
      ? warnings[0] === 'claude-out-of-range'
        ? t('version.header.warning.outOfRange')
        : t('version.header.warning.kbOutdated', { latest: kb.latest ?? '?' })
      : t('version.header.warning.multiple', { count: warnings.length })

  return (
    <button
      type="button"
      data-testid="version-header-badge"
      data-warnings={warnings.join(',')}
      onClick={onClick}
      title={label}
      className="
        flex items-center gap-1 px-2 py-1 rounded-md
        bg-amber-500/20 text-amber-200 border border-amber-400/30
        hover:bg-amber-500/30 transition-colors
        text-[11px] font-medium max-w-[200px] md:max-w-[260px]
      "
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  )
}
