/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * TrustMarker — badge surfacing the active recipe's trust-axis
 * value (handoff v1.1 §3.2 / §3.3) on top of every recipe page.
 *
 * Visual contract:
 *   - `KB-trusted`               → blue   (KB core; recipes never
 *                                   carry this value, but the path
 *                                   exists so the type-level union
 *                                   stays unified — see TrustContext)
 *   - `code-trusted`             → green  (KovitoHub signed publisher,
 *                                   v0.3.0)
 *   - `code-trusted (sideloaded)`→ orange (developer sideload path,
 *                                   v0.3.0)
 *   - `unknown`                  → gray   (grandfather migration —
 *                                   v0.2.x default)
 *
 * For `unknown` the marker also surfaces a "Re-install via
 * KovitoHub (v0.3.0) to verify" hint that nudges grandfather
 * recipes onto the signed track without forcing the user into a
 * re-consent flow today.
 *
 * Partial defence acknowledgement: the L3 marker is a weak signal
 * (handoff D-C / industry obs 3). It is not a substitute for L5
 * KB-trusted boundaries or L2 capture opt-in; it makes the trust
 * state visible so users can correlate suspicious behaviour with the
 * recipe's authority.
 *
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.1〜§3.3
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis vocabulary)
 * @stable v0.2.0
 */

import type { ReactElement } from 'react'
import type { TrustLevelValue } from '../../shared/recipe-types'
import { t } from '../i18n'

interface TrustMarkerProps {
  /**
   * Trust-axis value for the active recipe. `null` hides the badge
   * (the unmanaged-extension / KB-core case — same answer the
   * menu-entries API returns when no manifest is registered).
   */
  level: TrustLevelValue | null
  /**
   * Optional override for the screen-reader description. Defaults to
   * the localized trust-level label so the announcement stays in sync
   * with what is rendered.
   */
  ariaLabelOverride?: string
}

/**
 * Tailwind classes per trust-axis value. Kept colocated so the spec
 * → CSS mapping is a single grep target.
 *
 * `border-` carries the dominant color so the badge stays readable
 * on both light and dark themes (the page background underneath is
 * theme-controlled).
 */
const PRESENTATION: Record<
  TrustLevelValue,
  {
    border: string
    bg: string
    text: string
    labelKey:
      | 'trust.level.kbTrusted'
      | 'trust.level.codeTrusted'
      | 'trust.level.codeTrustedSideloaded'
      | 'trust.level.unknown'
  }
> = {
  'KB-trusted': {
    border: 'border-blue-500',
    bg: 'bg-blue-50 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-200',
    labelKey: 'trust.level.kbTrusted',
  },
  'code-trusted': {
    border: 'border-emerald-500',
    bg: 'bg-emerald-50 dark:bg-emerald-900/30',
    text: 'text-emerald-700 dark:text-emerald-200',
    labelKey: 'trust.level.codeTrusted',
  },
  'code-trusted (sideloaded)': {
    border: 'border-orange-500',
    bg: 'bg-orange-50 dark:bg-orange-900/30',
    text: 'text-orange-700 dark:text-orange-200',
    labelKey: 'trust.level.codeTrustedSideloaded',
  },
  unknown: {
    border: 'border-slate-400',
    bg: 'bg-slate-50 dark:bg-slate-700/40',
    text: 'text-slate-600 dark:text-slate-200',
    labelKey: 'trust.level.unknown',
  },
}

export function TrustMarker({
  level,
  ariaLabelOverride,
}: TrustMarkerProps): ReactElement | null {
  if (level === null) return null
  const style = PRESENTATION[level]
  const label = t(style.labelKey)
  const ariaLabel =
    ariaLabelOverride ?? t('trust.marker.ariaLabel', { label })
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      data-trust-level={level}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${style.border} ${style.bg} ${style.text}`}
    >
      <span aria-hidden="true">●</span>
      <span>{label}</span>
      {level === 'unknown' && (
        <a
          href="https://github.com/kovito-dev/kovitoboard/discussions"
          target="_blank"
          rel="noreferrer noopener"
          className="ml-1 underline-offset-2 hover:underline"
        >
          {t('trust.unknown.reinstall')}
        </a>
      )}
    </span>
  )
}
