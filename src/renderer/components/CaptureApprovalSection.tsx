/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Capture Capability Approval section for the recipe install warning
 * dialog (v0.2.0 Phase 1 prompt-injection ①).
 *
 * v0.2.x scope: the install flow is temporarily disabled (returns
 * 410 Gone) while the KovitoHub signed publisher model is being
 * prepared for v0.3.0. The dialog itself therefore does not render
 * today — this component is built ahead of that switch so the
 * v0.3.0 re-enable can plug it in without revisiting the opt-in
 * mechanism. See the implementation handoff in
 * `docs/design/handoffs/v02x-phase1-capture-optin-implementation-request.md`
 * §3.3.
 *
 * UX contract (`prompt-injection-threat-model.md` v1.0 §4.3 anti-
 * rubber-stamp integration strategy):
 *
 *   - Each capture kind is rendered as its own row with an
 *     independent checkbox (no "Approve all" shortcut).
 *   - Each row carries a "Why?" link that surfaces the explanation
 *     in a side panel; the explanation is opt-in and never replaces
 *     the user's deliberate consent.
 *   - The "Approve Selected" button is gated on the user touching
 *     at least one checkbox so an empty render does not double as
 *     a tacit "approve nothing" path.
 *
 * The component is intentionally framework-agnostic w.r.t. dialog
 * shell: it accepts `kinds` plus a controlled selection and emits
 * the user's chosen subset upward. The parent dialog owns the
 * surrounding chrome (cancel button, dialog framing).
 */
import { useState, type ReactElement } from 'react'
import { t } from '../i18n'
import type { CaptureKindValue } from '../../shared/recipe-types'
import { CAPTURE_KIND_VALUES } from '../../shared/recipe-types'

interface CaptureApprovalSectionProps {
  /**
   * Capture kinds the recipe declared in `recipe.yaml`'s
   * `capture.requires`. The render walks this list verbatim so a
   * recipe that did not declare a capture is rendered as an empty
   * fragment (the parent dialog can choose to hide the section
   * entirely in that case).
   */
  kinds: readonly CaptureKindValue[]
  /**
   * Currently-selected kinds. The parent owns the state so the
   * "Approve Selected" button can be enabled / disabled based on the
   * subset. The component itself only emits change events.
   */
  selected: ReadonlySet<CaptureKindValue>
  /** Called whenever a checkbox toggles. */
  onChange: (next: ReadonlySet<CaptureKindValue>) => void
}

/** Stable static check: the enum has at most this many entries. */
const KNOWN_KINDS: ReadonlySet<CaptureKindValue> = new Set(CAPTURE_KIND_VALUES)

export function CaptureApprovalSection({
  kinds,
  selected,
  onChange,
}: CaptureApprovalSectionProps): ReactElement | null {
  // Drop any unknown entries defensively. The recipe parser already
  // refuses values outside CAPTURE_KIND_VALUES at install time, but
  // a future relaxation upstream should not be able to silently
  // render an unlabeled checkbox here.
  const renderable = kinds.filter((k): k is CaptureKindValue => KNOWN_KINDS.has(k))
  if (renderable.length === 0) {
    return null
  }

  return (
    <section
      data-testid="capture-approval-section"
      className="border-t border-[var(--border-dim)] pt-4 mt-4 flex flex-col gap-3"
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-[var(--text-strong)]">
          {t('recipe.capture.title')}
        </h3>
        <p className="text-xs text-[var(--text-dim)]">
          {t('recipe.capture.description')}
        </p>
      </header>
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {renderable.map((kind) => (
          <CaptureRow
            key={kind}
            kind={kind}
            checked={selected.has(kind)}
            onToggle={(next) => {
              const updated = new Set(selected)
              if (next) {
                updated.add(kind)
              } else {
                updated.delete(kind)
              }
              onChange(updated)
            }}
          />
        ))}
      </ul>
    </section>
  )
}

interface CaptureRowProps {
  kind: CaptureKindValue
  checked: boolean
  onToggle: (next: boolean) => void
}

function CaptureRow({ kind, checked, onToggle }: CaptureRowProps): ReactElement {
  const [whyOpen, setWhyOpen] = useState(false)
  const labelKey = `recipe.capture.kind.${kind}` as const
  const whyKey = `recipe.capture.why.${kind}` as const

  return (
    <li
      className="flex flex-col gap-1 border border-[var(--border-dim)] rounded px-3 py-2"
      data-capture-row={kind}
    >
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.currentTarget.checked)}
          aria-describedby={`capture-why-${kind}`}
        />
        <span className="text-sm">{t(labelKey)}</span>
        <button
          type="button"
          className="ml-auto text-xs underline text-[var(--text-dim)] hover:text-[var(--text-strong)]"
          onClick={(e) => {
            // Prevent the outer label click from toggling the
            // checkbox when the user clicks the explanation control —
            // the two actions need to be independent so reading the
            // explanation never doubles as consent.
            e.preventDefault()
            e.stopPropagation()
            setWhyOpen((v) => !v)
          }}
        >
          {t('recipe.capture.whyLink')}
        </button>
      </label>
      {whyOpen && (
        <p
          id={`capture-why-${kind}`}
          className="text-xs text-[var(--text-dim)] pl-6"
        >
          {t(whyKey)}
        </p>
      )}
    </li>
  )
}
