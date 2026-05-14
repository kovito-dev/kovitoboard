/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * StepSecurity — onboarding step that surfaces Claude Code recommended-
 * settings violations for non-onboarded users (spec
 * `onboarding-scenarios.md` v1.2 §9.5; handoffs
 * `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 * §3.4 + `v02x-phase1-rule-of-two-warning-implementation-request.md`
 * v1.1 §3.2 + §3.5 + §8).
 *
 * Rubber-stamp prevention (handoff ② §3.4.2 / spec §9.5.2.3 / threat-
 * model §4.3, plus handoff ④ §8 D-E rule-of-two specifics):
 *   - Checkboxes are stacked vertically (no horizontal layout that
 *     invites a "tick everything in one swipe" gesture).
 *   - Each row has its own "Why?" link that opens a modal explaining
 *     the recommendation; no "Approve All" button.
 *   - When bypass mode is active, the bypass row is replaced by a
 *     prominent <RuleOfTwoViolationCard> with its own accept gate:
 *       - Accept stays disabled until the RuleOfTwoExplanation modal
 *         has been opened at least once (T-4-2 / I-6).
 *       - A minimum 2-second idle delay is enforced after the modal
 *         closes before accept enables (T-4-2 / D-E).
 *       - The accept handler refuses non-trusted (programmatic) click
 *         events via `event.isTrusted` (T-4-1 / I-6).
 *   - For non-bypass rows the legacy per-row acknowledge checkbox is
 *     retained — the rubber-stamp risk for those rows is already
 *     handled by separate `Why?` modals + per-row ack (handoff ② v1.1).
 *
 * Out of scope:
 *   - `window.kb` ambient API audit (T-4-1 b): already enforced at the
 *     bridge — see `installAmbientKbBridge.ts`, which only exposes
 *     `call` / `log` / `exposeContext`. No accept-state mutation API
 *     exists on the ambient surface, so DOM-level click automation is
 *     the only relevant attack and is mitigated by the
 *     `event.isTrusted` gate below + the App-level onboarding gate
 *     that refuses recipe page mounts before completion (T-4-1 a).
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { kbFetch } from '../../lib/kbFetch'
import { t } from '../../i18n'
import type { SettingsCheckResult } from '../../../shared/setting-types'
import {
  type SecurityCheckResponse,
  buildFetchFailureResponse,
  isSecurityCheckResponse,
} from '../../lib/securityCheckResponse'
import { RuleOfTwoExplanation } from '../../components/RuleOfTwoExplanation'
import { RuleOfTwoViolationCard } from '../../components/RuleOfTwoViolationCard'

interface StepSecurityProps {
  /**
   * Called when the user advances out of the Security step. The
   * `reviewedResult` argument carries the EXACT check result the user
   * acknowledged so the caller can persist it as the dismiss
   * snapshot. `null` is passed when the fetch failed (fail-closed
   * banner branch) — the caller should NOT seed a dismiss record in
   * that case because fail-closed states are non-dismissible by
   * design (CodeX attempt 11 — stale acknowledgement snapshot).
   */
  onNext: (reviewedResult: SettingsCheckResult | null) => void
  onBack: () => void
}

type WhyKey = 'permissionMode' | 'denyPattern' | 'bypassMode' | null

/**
 * Minimum idle time (ms) after the RuleOfTwoExplanation modal closes
 * before the bypass-mode accept checkbox enables. T-4-2 / D-E rubber-
 * stamp prevention: forces a "reading delay" so a user cannot ack the
 * modal-open + accept-tick combo in a single keystroke burst.
 */
const RULE_OF_TWO_ACCEPT_IDLE_MS = 2000

export function StepSecurity({ onNext, onBack }: StepSecurityProps) {
  const [state, setState] = useState<SecurityCheckResponse | null>(null)
  // Per-item acknowledgements (CodeX attempt 19 — security UX
  // regression). The wizard previously collapsed all violations into
  // a single shared checkbox, which let a user clear every warning
  // with one tick and defeated the rubber-stamp prevention intent
  // (handoff ② §3.4.2 / spec §9.5.2.3 / threat-model §4.3.3).
  const [acknowledged, setAcknowledged] = useState<{
    permissionMode: boolean
    denyPattern: boolean
    bypassMode: boolean
  }>({ permissionMode: false, denyPattern: false, bypassMode: false })
  const [whyOpen, setWhyOpen] = useState<WhyKey>(null)
  /**
   * Has the bypass-mode `RuleOfTwoExplanation` modal been opened at
   * least once during this onboarding session? T-4-2 / I-6 — accept
   * stays disabled until this flips to `true`.
   */
  const [ruleOfTwoEverOpened, setRuleOfTwoEverOpened] = useState(false)
  /**
   * Wall-clock timestamp at which the bypass-mode explanation modal
   * was last closed. The accept checkbox re-enables only after
   * `RULE_OF_TWO_ACCEPT_IDLE_MS` has elapsed since this moment
   * (T-4-2 / D-E reading-delay simulation).
   */
  const [ruleOfTwoClosedAt, setRuleOfTwoClosedAt] = useState<number | null>(null)
  /**
   * Live "now" tick. Updated only while the idle window is active so a
   * background interval does not keep firing for the rest of the
   * wizard's lifetime.
   */
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    let cancelled = false
    kbFetch('/api/security/settings-check')
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`)
        return r.json()
      })
      .then((data: unknown) => {
        if (cancelled) return
        // Runtime guard against shape-drifted payloads (CodeX
        // attempt 27 — runtime type safety). Mismatched shapes
        // collapse into the fail-closed banner so the wizard never
        // crashes on a malformed response.
        if (!isSecurityCheckResponse(data)) {
          setState(buildFetchFailureResponse())
          return
        }
        setState(data)
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

  // Schedule a single setNow() at the moment the idle window closes
  // so the `ruleOfTwoAcceptDisabled` memo flips to false without
  // burning a polling interval for the full delay (CodeX attempt 1 —
  // unnecessary timer churn). The timer is keyed solely on
  // `ruleOfTwoClosedAt`, so a second open-and-close of the modal
  // simply re-arms it without ever stacking handlers.
  useEffect(() => {
    if (ruleOfTwoClosedAt === null) return
    const remaining = RULE_OF_TWO_ACCEPT_IDLE_MS - (Date.now() - ruleOfTwoClosedAt)
    if (remaining <= 0) {
      setNow(Date.now())
      return
    }
    const id = setTimeout(() => {
      setNow(Date.now())
    }, remaining)
    return () => clearTimeout(id)
  }, [ruleOfTwoClosedAt])

  const bypassActive = state?.result.bypassMode.active === true
  const ruleOfTwoAcceptDisabled = useMemo(() => {
    if (!bypassActive) return false
    if (!ruleOfTwoEverOpened) return true
    // Re-opening the explanation modal must re-disable the accept
    // affordance so the "open / read / close / wait 2 s / accept" gate
    // is re-armed on every cycle (CodeX attempt 2 — ack gate bypass).
    // Without this branch a user could open the modal once, satisfy
    // the 2 s window, then re-open it later and still tick accept
    // because the timer never re-armed.
    if (whyOpen === 'bypassMode') return true
    if (ruleOfTwoClosedAt === null) return true
    return now - ruleOfTwoClosedAt < RULE_OF_TWO_ACCEPT_IDLE_MS
  }, [bypassActive, ruleOfTwoEverOpened, whyOpen, ruleOfTwoClosedAt, now])

  // Gate the Next button on per-item acknowledgement of EVERY
  // violated row (CodeX attempt 19). A row that is already OK does
  // not need a tick, so the user only needs to acknowledge what they
  // are accepting risk on. The fail-closed banner branch keeps its
  // own single-item gate via the legacy boolean below because there
  // is no per-row violation to render.
  const allOk = state?.result.overallOk === true
  const failClosed = state?.result.reason !== 'ok' && state !== null
  const allRequiredAcknowledged = (() => {
    if (!state) return false
    if (allOk) return true
    if (failClosed) return acknowledged.permissionMode // reuse one box for the banner branch
    const violations: Array<'permissionMode' | 'denyPattern' | 'bypassMode'> = []
    if (!state.result.permissionMode.ok) violations.push('permissionMode')
    if (!state.result.denyPattern.ok) violations.push('denyPattern')
    if (!state.result.bypassMode.ok) violations.push('bypassMode')
    return violations.every((row) => acknowledged[row])
  })()
  const nextEnabled = allRequiredAcknowledged

  const handleNext = useCallback(() => {
    if (!nextEnabled) return
    // Hand off the exact snapshot the user just acknowledged so the
    // dismiss record reflects the reviewed state, not whatever the
    // settings file happens to look like at completion time (CodeX
    // attempt 11 — stale acknowledgement snapshot). Fail-closed
    // results bypass the dismiss seed by passing `null`.
    const reviewed: SettingsCheckResult | null = state?.result.reason === 'ok'
      ? state.result
      : null
    onNext(reviewed)
  }, [nextEnabled, state, onNext])

  /**
   * T-4-1 / I-6 — refuse synthetic / programmatic click events for the
   * bypass-mode accept checkbox. The ambient `window.kb` API does not
   * expose accept-state mutation (see `installAmbientKbBridge.ts`), but
   * a recipe page running in the same renderer realm could still
   * dispatch a synthetic event. `event.isTrusted` distinguishes
   * user-initiated activations.
   *
   * Defense in depth (CodeX attempt 1 — client-side gate bypass):
   * re-validate the "modal opened + 2s idle" prerequisites here even
   * though the rendered `disabled` attribute already blocks the
   * click. A future refactor or DOM-level re-enable must not be able
   * to flip the accept state without re-passing the same gate.
   */
  const handleBypassAccept = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.nativeEvent.isTrusted) {
        // Surface nothing to the user — a synthetic event indicates a
        // programmatic mutation attempt, not a legitimate accident.
        return
      }
      if (ruleOfTwoAcceptDisabled) {
        // Re-check the gate at the state-mutation site rather than
        // trusting the DOM disabled prop alone (defense in depth).
        return
      }
      setAcknowledged((prev) => ({ ...prev, bypassMode: event.target.checked }))
    },
    [ruleOfTwoAcceptDisabled],
  )

  function setRowAck(row: 'permissionMode' | 'denyPattern' | 'bypassMode', next: boolean): void {
    setAcknowledged((prev) => ({ ...prev, [row]: next }))
  }

  const openRuleOfTwoModal = useCallback(() => {
    setWhyOpen('bypassMode')
    // Re-arm the idle gate on every open. The disabled memo above
    // already keys off `whyOpen === 'bypassMode'` for the modal-open
    // phase; clearing the closed timestamp here ensures the 2 s idle
    // re-arms cleanly the instant the modal closes again, so the
    // cycle is "open / read / close / wait / accept" on every
    // re-entry, never a single-shot satisfy.
    setRuleOfTwoClosedAt(null)
    // Re-arm the acknowledgement state as well. Without this, a user
    // who already ticked accept once could re-open the modal, close
    // it, and the Next button would stay enabled because
    // `acknowledged.bypassMode` survived — defeating the
    // "open / read / close / wait / accept" cycle that the gate is
    // supposed to enforce on every re-entry.
    setAcknowledged((prev) => ({ ...prev, bypassMode: false }))
  }, [])

  const closeWhyModal = useCallback(() => {
    if (whyOpen === 'bypassMode') {
      setRuleOfTwoEverOpened(true)
      const closedAt = Date.now()
      setRuleOfTwoClosedAt(closedAt)
      setNow(closedAt)
    }
    setWhyOpen(null)
  }, [whyOpen])

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
            {bypassActive ? (
              <RuleOfTwoViolationCard
                testId="onboarding-rule-of-two"
                onOpenWhy={openRuleOfTwoModal}
              >
                <label
                  className={`flex items-start gap-2 text-xs mt-1 text-red-900 dark:text-red-100 ${
                    ruleOfTwoAcceptDisabled ? 'opacity-60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid="onboarding-rule-of-two-accept"
                    checked={acknowledged.bypassMode}
                    disabled={ruleOfTwoAcceptDisabled}
                    onChange={handleBypassAccept}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span>{t('ruleOfTwo.violation.accept')}</span>
                    {ruleOfTwoAcceptDisabled && (
                      <span
                        data-testid="onboarding-rule-of-two-accept-hint"
                        className="text-[10px] text-red-700 dark:text-red-300"
                      >
                        {t('ruleOfTwo.violation.acceptDisabledHint')}
                      </span>
                    )}
                  </span>
                </label>
              </RuleOfTwoViolationCard>
            ) : (
              <SecurityRow
                testId="row-bypassMode"
                label={t('onboarding.security.bypassMode.label')}
                description={t('onboarding.security.bypassMode.description')}
                violated={!state.result.bypassMode.ok}
                severity="high"
                acknowledged={acknowledged.bypassMode}
                onAcknowledgeChange={(v) => setRowAck('bypassMode', v)}
                onWhy={() => setWhyOpen('bypassMode')}
              />
            )}
            <SecurityRow
              testId="row-permissionMode"
              label={t('onboarding.security.permissionMode.label')}
              description={t('onboarding.security.permissionMode.description')}
              violated={!state.result.permissionMode.ok}
              severity="high"
              acknowledged={acknowledged.permissionMode}
              onAcknowledgeChange={(v) => setRowAck('permissionMode', v)}
              onWhy={() => setWhyOpen('permissionMode')}
            />
            <SecurityRow
              testId="row-denyPattern"
              label={t('onboarding.security.denyPattern.label')}
              description={t('onboarding.security.denyPattern.description')}
              violated={!state.result.denyPattern.ok}
              severity="medium"
              acknowledged={acknowledged.denyPattern}
              onAcknowledgeChange={(v) => setRowAck('denyPattern', v)}
              onWhy={() => setWhyOpen('denyPattern')}
            />
          </div>
        </>
      )}

      {failClosed && (
        // Fail-closed branch retains a single acknowledgement because
        // there are no per-row violations to check off — the banner
        // covers the structural read failure as a whole.
        <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            data-testid="security-acknowledge"
            checked={acknowledged.permissionMode}
            onChange={(e) => setRowAck('permissionMode', e.target.checked)}
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

      {whyOpen === 'bypassMode' ? (
        <RuleOfTwoExplanation onClose={closeWhyModal} />
      ) : whyOpen !== null ? (
        <WhyModal whyKey={whyOpen} onClose={() => setWhyOpen(null)} />
      ) : null}
    </div>
  )
}

interface SecurityRowProps {
  testId: string
  label: string
  description: string
  violated: boolean
  severity: 'high' | 'medium'
  acknowledged: boolean
  onAcknowledgeChange: (next: boolean) => void
  onWhy: () => void
}

function SecurityRow({
  testId,
  label,
  description,
  violated,
  severity,
  acknowledged,
  onAcknowledgeChange,
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
      {violated && (
        // Per-item acknowledgement (CodeX attempt 19). Each violated
        // row gets its own checkbox so a single tick cannot clear all
        // warnings at once.
        <label className="flex items-start gap-2 text-xs mt-1 text-[var(--text-primary)]">
          <input
            type="checkbox"
            data-testid={`${testId}-acknowledge`}
            checked={acknowledged}
            onChange={(e) => onAcknowledgeChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t('onboarding.security.acknowledge')}</span>
        </label>
      )}
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
