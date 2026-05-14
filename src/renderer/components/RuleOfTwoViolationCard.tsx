/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * RuleOfTwoViolationCard — presentation block for the bypass-mode
 * Rule of Two violation surface. Reused from both StepSecurity (the
 * onboarding wizard) and SecurityRecommendationsToast (the post-
 * onboarding startup warn). Self-contained on the visual side; the
 * accept / dismiss controls are injected via `children` so each surface
 * keeps its own state machine.
 *
 * Handoff: `v02x-phase1-rule-of-two-warning-implementation-request.md`
 * v1.1 §3.2 + §3.3 + §3.6 + §8.4 (Invariant I-5..I-8 + D-D..D-F).
 *
 * Spec SSOT:
 *   - `prompt-injection-threat-model.md` v1.0 §4
 *   - `onboarding-scenarios.md` v1.2 §9.5.3.3
 *   - `trust-prompt-relay.md` v1.3 §10.5.3
 *
 * Rendering responsibilities:
 *   - Title + violation description (3/3 line up)
 *   - Three element rows (A) untrusted input / (B) sensitive data /
 *     (C) external state with the KB-context annotation per element
 *   - "→ HITL required" consequence line
 *   - "Change to default mode" guidance link rendered more prominently
 *     than the accept affordance (D-E rubber-stamp prevention — the
 *     safer path is visually framed as the default)
 *   - "Why?" link that the caller wires to a RuleOfTwoExplanation modal
 *     so the modal-opened-once gate stays under the caller's control
 *
 * Out of scope for this component:
 *   - Accept checkbox state (callers own it: StepSecurity drives a
 *     per-row acknowledgement; SecurityRecommendationsToast does not
 *     accept here, the dismiss button stays disabled for bypass).
 *   - `event.isTrusted` enforcement (handled by the caller's accept
 *     checkbox handler so the card stays presentation-only).
 *   - `permissionMode` / `denyPattern` row rendering (the caller picks
 *     whether to surface them alongside this card or not).
 */
import type { ReactNode } from 'react'
import { t } from '../i18n'

interface RuleOfTwoViolationCardProps {
  /**
   * Invoked when the user clicks the "Why is Rule of Two important?"
   * link. The caller wires this to open a RuleOfTwoExplanation modal
   * and is responsible for tracking the modal-opened state if it uses
   * that as an accept-gate signal (T-4-2 mitigation).
   */
  onOpenWhy: () => void
  /**
   * Optional accept-affordance block injected by the caller. Rendered
   * after the "Change to default mode" guidance so the safer path
   * stays visually prominent (D-E rubber-stamp prevention rationale).
   * Pass `null` when the surface only needs to surface the warning
   * without an accept control (e.g. SecurityRecommendationsToast where
   * the Dismiss button is intentionally disabled while bypass is
   * active per I-7 / I-8).
   */
  children?: ReactNode
  /** Optional test-id so each mount surface keeps unique automation hooks. */
  testId?: string
}

export function RuleOfTwoViolationCard({
  onOpenWhy,
  children,
  testId = 'rule-of-two-violation-card',
}: RuleOfTwoViolationCardProps) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border-2 border-red-400 dark:border-red-700 bg-red-50 dark:bg-red-950/40 p-4 text-sm flex flex-col gap-3"
      role="alert"
      aria-labelledby={`${testId}-title`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div
            id={`${testId}-title`}
            className="font-bold text-red-900 dark:text-red-100 mb-1"
          >
            ⚠ {t('ruleOfTwo.violation.title')}
          </div>
          <div className="text-xs text-red-800 dark:text-red-200">
            {t('ruleOfTwo.violation.description')}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <ElementRow
          testId={`${testId}-element-untrustedInput`}
          marker="✓"
          label={t('ruleOfTwo.violation.element.untrustedInput')}
          annotation={t('ruleOfTwo.violation.elementStructurallyRequired')}
        />
        <ElementRow
          testId={`${testId}-element-sensitiveData`}
          marker="✓"
          label={t('ruleOfTwo.violation.element.sensitiveData')}
          annotation={t('ruleOfTwo.violation.elementClaudeAccess')}
        />
        <ElementRow
          testId={`${testId}-element-externalState`}
          marker="✓"
          label={t('ruleOfTwo.violation.element.externalState')}
          annotation={t('ruleOfTwo.violation.elementBypassConsequence')}
        />
      </div>

      <div className="font-medium text-red-900 dark:text-red-100 text-xs">
        {t('ruleOfTwo.violation.consequence')}
      </div>

      {/*
       * D-E rubber-stamp prevention: the safer path ("Change to default
       * mode") is framed as the default action. It links to Anthropic's
       * Claude Code settings docs so the user has an immediate, off-
       * ramp from bypass mode without having to dig through menus.
       */}
      <div className="flex flex-col gap-2">
        <a
          href="https://docs.anthropic.com/en/docs/claude-code/settings"
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${testId}-change-mode-link`}
          className="inline-block px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium text-center"
        >
          {t('ruleOfTwo.violation.changeMode')}
        </a>
        <button
          type="button"
          data-testid={`${testId}-why-link`}
          onClick={onOpenWhy}
          className="text-xs underline text-red-800 dark:text-red-200 hover:text-red-900 dark:hover:text-red-100 self-start"
        >
          {t('ruleOfTwo.violation.why')}
        </button>
      </div>

      {children}
    </div>
  )
}

interface ElementRowProps {
  testId: string
  marker: string
  label: string
  annotation: string
}

function ElementRow({ testId, marker, label, annotation }: ElementRowProps) {
  return (
    <div
      data-testid={testId}
      className="flex items-baseline gap-2 text-red-900 dark:text-red-100"
    >
      <span aria-hidden="true">{marker}</span>
      <span className="font-medium">{label}</span>
      <span className="text-red-700 dark:text-red-300">— {annotation}</span>
    </div>
  )
}
