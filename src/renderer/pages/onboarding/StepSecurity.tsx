/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * StepSecurity — onboarding step that surfaces Claude Code recommended-
 * settings violations for non-onboarded users (spec
 * `onboarding-scenarios.md` v1.2 §9.5; handoff
 * `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 * §3.4).
 *
 * Rubber-stamp prevention (handoff §3.4.2 / spec §9.5.2.3 / threat-
 * model §4.3.3):
 *   - Checkboxes are stacked vertically (no horizontal layout that
 *     invites a "tick everything in one swipe" gesture).
 *   - Each row has its own "Why?" link that opens a modal explaining
 *     the recommendation; no "Approve All" button.
 *   - The acknowledge checkbox uses the spec label "I have reviewed
 *     these recommendations" so the user must opt in explicitly.
 */
import { useEffect, useState, useCallback } from 'react'
import { kbFetch } from '../../lib/kbFetch'
import { t } from '../../i18n'
import {
  type SecurityCheckResponse,
  buildFetchFailureResponse,
} from '../../lib/securityCheckResponse'

interface StepSecurityProps {
  onNext: () => void
  onBack: () => void
}

type WhyKey = 'permissionMode' | 'denyPattern' | 'bypassMode' | null

export function StepSecurity({ onNext, onBack }: StepSecurityProps) {
  const [state, setState] = useState<SecurityCheckResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [whyOpen, setWhyOpen] = useState<WhyKey>(null)

  useEffect(() => {
    let cancelled = false
    kbFetch('/api/security/settings-check')
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`)
        return r.json()
      })
      .then((data: SecurityCheckResponse) => {
        if (!cancelled) setState(data)
      })
      .catch(() => {
        // Fail-closed: when the server-side check itself failed to
        // reach us, render the fail-closed banner + acknowledge flow
        // so the user can still proceed once they confirm they will
        // review the settings manually. Previously a fetch error
        // kept the wizard in a perpetual loading state with Next
        // disabled (CodeX review attempt 1).
        if (!cancelled) setState(buildFetchFailureResponse())
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleNext = useCallback(() => {
    if (!acknowledged && state && !state.result.overallOk) return
    onNext()
  }, [acknowledged, state, onNext])

  // Allow Next without an explicit acknowledge when everything is OK
  // — otherwise force the user to tick the box.
  const allOk = state?.result.overallOk === true
  const failClosed = state?.result.reason !== 'ok' && state !== null
  const nextEnabled = allOk || acknowledged

  return (
    <div data-testid="onboarding-step-security" className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
          {t('onboarding.security.title')}
        </h2>
        <p className="text-[var(--text-dim)]">
          {t('onboarding.security.subtitle')}
        </p>
      </div>

      {state === null ? (
        <div className="text-[var(--text-dim)] text-sm">
          {t('onboarding.complete.preparing')}
        </div>
      ) : allOk ? (
        <div
          data-testid="security-all-ok"
          className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 p-3 text-emerald-900 dark:text-emerald-100"
        >
          ✓ {t('onboarding.security.allOk')}
        </div>
      ) : failClosed ? (
        <div
          data-testid="security-fail-closed"
          className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-400 dark:border-amber-700 p-3 text-amber-900 dark:text-amber-100"
        >
          ⚠ {t('onboarding.security.failClosed')}
        </div>
      ) : (
        <>
          <p className="text-sm text-[var(--text-dim)]">
            {t('onboarding.security.intro')}
          </p>
          <div className="flex flex-col gap-3">
            <SecurityRow
              testId="row-permissionMode"
              label={t('onboarding.security.permissionMode.label')}
              description={t('onboarding.security.permissionMode.description')}
              violated={!state.result.permissionMode.ok}
              severity="high"
              onWhy={() => setWhyOpen('permissionMode')}
            />
            <SecurityRow
              testId="row-denyPattern"
              label={t('onboarding.security.denyPattern.label')}
              description={t('onboarding.security.denyPattern.description')}
              violated={!state.result.denyPattern.ok}
              severity="medium"
              onWhy={() => setWhyOpen('denyPattern')}
            />
            <SecurityRow
              testId="row-bypassMode"
              label={t('onboarding.security.bypassMode.label')}
              description={t('onboarding.security.bypassMode.description')}
              violated={!state.result.bypassMode.ok}
              severity="high"
              onWhy={() => setWhyOpen('bypassMode')}
            />
          </div>
        </>
      )}

      {!allOk && state !== null && (
        <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            data-testid="security-acknowledge"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t('onboarding.security.acknowledge')}</span>
        </label>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          {t('onboarding.back')}
        </button>
        <button
          type="button"
          data-testid="security-next"
          onClick={handleNext}
          disabled={!nextEnabled}
          className="px-4 py-2 rounded-md bg-[var(--onboarding-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('onboarding.next')}
        </button>
      </div>

      {whyOpen !== null && (
        <WhyModal whyKey={whyOpen} onClose={() => setWhyOpen(null)} />
      )}
    </div>
  )
}

interface SecurityRowProps {
  testId: string
  label: string
  description: string
  violated: boolean
  severity: 'high' | 'medium'
  onWhy: () => void
}

function SecurityRow({
  testId,
  label,
  description,
  violated,
  severity,
  onWhy,
}: SecurityRowProps) {
  const accentClass = violated
    ? severity === 'high'
      ? 'border-red-400 dark:border-red-700 bg-red-50 dark:bg-red-950/40'
      : 'border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40'
    : 'border-[var(--border)]'
  return (
    <div
      data-testid={testId}
      className={`rounded-lg border p-3 text-sm flex flex-col gap-1 ${accentClass}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-[var(--text-primary)]">
          {violated ? '✗' : '✓'} {label}
        </span>
        <button
          type="button"
          onClick={onWhy}
          className="text-xs underline text-[var(--text-dim)] hover:text-[var(--text-primary)]"
        >
          {t('onboarding.security.why')}
        </button>
      </div>
      <p className="text-xs text-[var(--text-dim)]">{description}</p>
    </div>
  )
}

interface WhyModalProps {
  whyKey: Exclude<WhyKey, null>
  onClose: () => void
}

function WhyModal({ whyKey, onClose }: WhyModalProps) {
  const description =
    whyKey === 'permissionMode'
      ? t('onboarding.security.permissionMode.description')
      : whyKey === 'denyPattern'
        ? t('onboarding.security.denyPattern.description')
        : t('onboarding.security.bypassMode.description')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border)] p-6 max-w-md mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-[var(--text-primary)] mb-3">
          {t('onboarding.security.whyModal.heading')}
        </h3>
        <p className="text-sm text-[var(--text-primary)] mb-3">{description}</p>
        <p className="text-xs text-[var(--text-dim)] mb-2">
          {t('onboarding.security.whyModal.responsibility')}
        </p>
        <p className="text-xs text-[var(--text-dim)] mb-4">
          {t('onboarding.security.whyModal.ruleOfTwo')}
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {t('onboarding.security.whyModal.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
