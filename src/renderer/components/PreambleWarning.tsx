/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * PreambleWarning — banner that wraps content sections sourced from
 * untrusted origins (handoff v1.1 §3.5).
 *
 * Use cases (v0.2.x):
 *   - Recipe pages that render API response bodies coming from
 *     `window.kb.capture.a11y(...)` or `window.kb.capture.exposeContext(...)`
 *     are content-untrusted from the app perspective (`fromApp`).
 *   - Recipe pages that render arbitrary user-pasted text without
 *     sanitization should wrap that block in `fromUserPaste` so a
 *     screen reader user has the same contextual cue a sighted
 *     reader gets from the color band.
 *
 * v0.2.x scope note: recipes shipped today do not all wrap their
 * untrusted sections in PreambleWarning yet. This component is the
 * reusable building block recipe authors / future KB-managed
 * surfaces opt into. Honest-claim acknowledgement (handoff D-C /
 * industry obs 3): L3 markers are a weak signal. They do not stop
 * a recipe that ignores the wrapper, and they are not a substitute
 * for the L2 capture opt-in (`recipe-system.md` v1.5 §6.10.6) or
 * the L5 KB-trusted handler boundary.
 *
 * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.5
 * @see prompt-injection-threat-model.md v1.0 §2 (trust axis vocabulary)
 * @stable v0.2.0
 */

import type { ReactElement, ReactNode } from 'react'
import { t } from '../i18n'

/**
 * Origin of the wrapped content. The renderer maps each value onto
 * the localized banner text + severity color.
 *   - `fromApp`         → yellow (low severity — the recipe author
 *                          is the trust authority for the message
 *                          itself, but a remote-controlled response
 *                          could ride along).
 *   - `fromUserPaste`   → orange (medium severity — user-attacker
 *                          model: a paste action can launder content
 *                          across trust boundaries).
 *   - `fromUnknown`     → orange (medium severity — explicit fallback
 *                          when the origin cannot be classified;
 *                          stays louder than `fromApp` to err on the
 *                          side of caution).
 */
export type PreambleSource =
  | { kind: 'fromApp'; appId: string }
  | { kind: 'fromUserPaste' }
  | { kind: 'fromUnknown' }

interface PreambleWarningProps {
  /** Origin of the wrapped content. */
  source: PreambleSource
  /** Wrapped content. Rendered after the banner. */
  children: ReactNode
}

interface SourcePresentation {
  border: string
  banner: string
  text: string
  message: string
}

function presentationFor(source: PreambleSource): SourcePresentation {
  switch (source.kind) {
    case 'fromApp':
      return {
        border: 'border-yellow-400',
        banner: 'bg-yellow-50 dark:bg-yellow-900/30',
        text: 'text-yellow-800 dark:text-yellow-100',
        message: t('trust.preamble.fromApp', { appId: source.appId }),
      }
    case 'fromUserPaste':
      return {
        border: 'border-orange-400',
        banner: 'bg-orange-50 dark:bg-orange-900/30',
        text: 'text-orange-800 dark:text-orange-100',
        message: t('trust.preamble.fromUserPaste'),
      }
    case 'fromUnknown':
      return {
        border: 'border-orange-400',
        banner: 'bg-orange-50 dark:bg-orange-900/30',
        text: 'text-orange-800 dark:text-orange-100',
        message: t('trust.preamble.fromUnknown'),
      }
  }
}

export function PreambleWarning({
  source,
  children,
}: PreambleWarningProps): ReactElement {
  const presentation = presentationFor(source)
  return (
    <section
      data-preamble-source={source.kind}
      className={`rounded-md border ${presentation.border}`}
    >
      <header
        role="note"
        className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium ${presentation.banner} ${presentation.text}`}
      >
        <span aria-hidden="true">⚠</span>
        <span>{presentation.message}</span>
      </header>
      <div className="px-3 py-2">{children}</div>
    </section>
  )
}
