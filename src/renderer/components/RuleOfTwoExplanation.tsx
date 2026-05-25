/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * RuleOfTwoExplanation — reusable "Why is the Rule of Two important?"
 * modal that explains the (A) / (B) / (C) elements, why (A) and (B) are
 * structurally required in a KovitoBoard session, why blocking (C) via
 * HITL preserves the structural attack-precondition gap, and the
 * responsibility boundary between KovitoBoard (notice) and Anthropic /
 * Claude Code (detection + enforcement).
 *
 * Handoff: `v02x-phase1-rule-of-two-warning-implementation-request.md`
 * v1.1 §3.5 + §8.5.
 *
 * Spec SSOT:
 *   - `prompt-injection-threat-model.md` v1.0 §4 (responsibility boundary)
 *   - `onboarding-scenarios.md` v1.2 §9.5.3
 *   - `recipe-system.md` v1.4 §10.7.3 (install warning reactivation in v0.3.0)
 *
 * Usage contract:
 *   - Mounted from the bypass-mode Rule of Two row in StepSecurity
 *     (onboarding) and from SecurityRecommendationsToast (startup warn).
 *   - `onClose` is invoked when the user closes the modal — callers MAY
 *     use that as the signal that "the user has read the explanation at
 *     least once" to enable a downstream accept gate
 *     (T-4-2 / I-6 rubber-stamp prevention).
 *   - The modal does NOT decide whether bypass mode is active or which
 *     elements are violated — it is purely informational so it can be
 *     mounted from any surface (toast, onboarding, future install
 *     warning dialog in v0.3.0).
 */
import { t } from '../i18n'

interface RuleOfTwoExplanationProps {
  /** Invoked when the user closes the modal (backdrop click / Close button). */
  onClose: () => void
}

export function RuleOfTwoExplanation({ onClose }: RuleOfTwoExplanationProps) {
  return (
    <div
      data-testid="rule-of-two-explanation"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rule-of-two-modal-heading"
    >
      <div
        className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border)] p-6 max-w-xl mx-4 shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="rule-of-two-modal-heading"
          className="text-lg font-bold text-[var(--text-primary)] mb-3"
        >
          {t('ruleOfTwo.modal.heading')}
        </h3>
        <p className="text-sm text-[var(--text-primary)] mb-4">
          {t('ruleOfTwo.modal.intro')}
        </p>
        <div className="flex flex-col gap-3 mb-4">
          <ElementBlock
            testId="rule-of-two-element-untrustedInput"
            title={t('ruleOfTwo.modal.element.untrustedInput.title')}
            detail={t('ruleOfTwo.modal.element.untrustedInput.detail')}
          />
          <ElementBlock
            testId="rule-of-two-element-sensitiveData"
            title={t('ruleOfTwo.modal.element.sensitiveData.title')}
            detail={t('ruleOfTwo.modal.element.sensitiveData.detail')}
          />
          <ElementBlock
            testId="rule-of-two-element-externalState"
            title={t('ruleOfTwo.modal.element.externalState.title')}
            detail={t('ruleOfTwo.modal.element.externalState.detail')}
          />
        </div>
        <p className="text-sm text-[var(--text-primary)] mb-3">
          {t('ruleOfTwo.modal.kbContext')}
        </p>
        <p className="text-sm text-[var(--text-primary)] mb-3">
          {t('ruleOfTwo.modal.cBlockMeaning')}
        </p>
        <p className="text-xs text-[var(--text-dim)] mb-2">
          {t('ruleOfTwo.modal.hitl')}
        </p>
        <p className="text-xs text-[var(--text-dim)] mb-4">
          {t('ruleOfTwo.modal.boundary')}
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="rule-of-two-explanation-close"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {t('ruleOfTwo.modal.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ElementBlockProps {
  testId: string
  title: string
  detail: string
}

function ElementBlock({ testId, title, detail }: ElementBlockProps) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-[var(--border)] p-3 text-sm bg-[var(--bg-base)]"
    >
      <div className="font-medium text-[var(--text-primary)] mb-1">{title}</div>
      <p className="text-xs text-[var(--text-dim)]">{detail}</p>
    </div>
  )
}
