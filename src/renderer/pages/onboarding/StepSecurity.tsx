/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * StepSecurity — onboarding step that surfaces Claude Code recommended-
 * settings violations for non-onboarded users (spec
 * `onboarding-scenarios.md` v1.6 §9.5.2.3; handoffs
 * `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 * §3.4 + `v02x-phase1-rule-of-two-warning-implementation-request.md`
 * v1.1 §3.2 + §3.5 + §8).
 *
 * Rubber-stamp prevention (handoff ② §3.4.2 / spec §9.5.2.3 v1.6 /
 * threat-model §4.3, plus handoff ④ §8 D-E rule-of-two specifics):
 *   - Checkboxes are stacked vertically (no horizontal layout that
 *     invites a "tick everything in one swipe" gesture).
 *   - Each row has its own "Why?" link that opens a modal explaining
 *     the recommendation; no "Approve All" button.
 *   - Each of the three recommendation BOXes carries its own
 *     individual acknowledgement checkbox INSIDE the BOX — see
 *     onboarding-scenarios.md v1.6 §9.5.2.3 normative pin. A single
 *     shared "I have reviewed these recommendations" checkbox at the
 *     wrapper level is explicitly banned: it makes one click defeat
 *     the per-recommendation review intent (CodeX attempt 19 / spec
 *     v1.3 → v1.4 escalate-revision). The "Next" gate is the AND of
 *     all three per-BOX acks on the violation path, so each
 *     recommendation always demands its own deliberate tick when a
 *     violation is present.
 *   - v1.5 exception clause 1 (allOk path, threat surface absent):
 *     when `overallOk === true && reason === 'ok'`, the green-banner
 *     branch renders no per-row BOX, so per-BOX ack is structurally
 *     unnecessary and Next enables immediately. The three-BOX gate
 *     only applies on the violation path (`overallOk === false &&
 *     reason === 'ok'`).
 *   - v1.6 exception clause 2 (failClosed path, block until fixed):
 *     when `reason !== 'ok'` (the structural settings read failed
 *     with one of `read-error` / `parse-error` / `schema-mismatch` /
 *     `path-resolution-rejected` / `file-too-large`), the amber-
 *     banner branch renders alone with a Recheck button. Next is
 *     fully disabled until the user repairs the settings file and
 *     a fresh fetch returns `reason: 'ok'`. The v1.5-era single-ack
 *     reuse of `acknowledged.permissionMode` was withdrawn — a
 *     promised "I will review settings manually" tick let the user
 *     wave through Phase 1 prompt-injection mitigation ② without
 *     any structural enforcement (PR #44 CodeX attempt 2 Finding 1
 *     / option δ' adopted 2026-05-19).
 *   - When bypass mode is active, the bypass row is replaced by a
 *     prominent <RuleOfTwoViolationCard> whose internal acknowledge-
 *     ment doubles as the bypassMode BOX's per-item ack and carries
 *     the existing accept gate:
 *       - Accept stays disabled until the RuleOfTwoExplanation modal
 *         has been opened at least once (T-4-2 / I-6).
 *       - A minimum 2-second idle delay is enforced after the modal
 *         closes before accept enables (T-4-2 / D-E).
 *       - The accept handler refuses non-trusted (programmatic) click
 *         events via `event.isTrusted` (T-4-1 / I-6).
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
import { useEffect, useMemo, useState, useCallback } from 'react'
import { kbFetch } from '../../lib/kbFetch'
import { t, type MessageKey } from '../../i18n'
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

/**
 * Local review state that must return to its initial values whenever
 * the user requests a fresh settings-check via the Recheck button
 * (spec onboarding-scenarios.md v1.6 §9.5.2.3 example clause 2 —
 * fail-closed path 4-state reset rule).
 *
 * Exported as a pure factory so the reset contract can be unit-tested
 * without spinning up React. The handler in `StepSecurity` consumes
 * this shape via individual `setX(...)` calls; centralising the
 * source of truth here means a future change cannot silently drop
 * one of the four fields and leave a bypass-mode T-4-1 / T-4-2 /
 * I-6 gate carry-over escape in place.
 */
export interface StepSecurityResetState {
  acknowledged: { permissionMode: false; denyPattern: false; bypassMode: false }
  ruleOfTwoEverOpened: false
  ruleOfTwoClosedAt: null
  whyOpen: null
}

/**
 * Build the canonical "fresh local review state" snapshot used after
 * a Recheck. All four fields the spec §9.5.2.3 4-state reset rule
 * names must appear here; tests assert literal-`false`/`null` so the
 * factory cannot drift away from the spec.
 */
export function createStepSecurityResetState(): StepSecurityResetState {
  return {
    acknowledged: { permissionMode: false, denyPattern: false, bypassMode: false },
    ruleOfTwoEverOpened: false,
    ruleOfTwoClosedAt: null,
    whyOpen: null,
  }
}

/**
 * Pure loader for `/api/security/settings-check`. Returns a normalised
 * `SecurityCheckResponse` either way:
 *
 *   - happy path: server JSON that passes the `isSecurityCheckResponse`
 *     runtime guard;
 *   - shape-drifted JSON, non-2xx response, or thrown fetch error:
 *     `buildFetchFailureResponse()` — a synthetic fail-closed payload.
 *
 * Cancellation is the caller's responsibility (CodeX attempt 3 —
 * duplicated async flow). The initial-mount call site in
 * `StepSecurity` wraps the returned promise in a local `cancelled`
 * flag so a strict-mode double-mount or a fast unmount cannot land a
 * stale `setState`; the Recheck call site relies on the spec v1.6
 * §9.5.2.3 in-flight semantics instead — the Recheck button is
 * structurally unmounted on `setState(null)`, so a second concurrent
 * invocation cannot reach this loader.
 */
async function fetchSettingsCheck(): Promise<SecurityCheckResponse> {
  try {
    const r = await kbFetch('/api/security/settings-check')
    if (!r.ok) throw new Error(`status ${r.status}`)
    const data: unknown = await r.json()
    if (!isSecurityCheckResponse(data)) {
      return buildFetchFailureResponse()
    }
    return data
  } catch {
    return buildFetchFailureResponse()
  }
}

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
    fetchSettingsCheck().then((data) => {
      // Local cancellation gate: a strict-mode double-mount or a fast
      // unmount must not land a stale `setState`. The loader itself
      // is unconditional (cancellation is the caller's job, see the
      // helper's JSDoc), so we drop the result here when the effect
      // has already torn down.
      if (cancelled) return
      setState(data)
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

  // Gate the Next button per onboarding-scenarios.md v1.6 §9.5.2.3.
  // The wizard has three mutually exclusive states once the settings
  // check has resolved, and each has its own gate:
  //
  //   1. `allOk` (= `overallOk === true && reason === 'ok'`) — v1.5
  //      exception clause 1. The green banner renders alone; no per-
  //      row BOX exists, so per-BOX ack is structurally unnecessary
  //      and Next enables immediately. The rubber-stamp threat surface
  //      is absent (no violation to wave through), and the CodeX
  //      attempt 19 per-item ack reversal targeted "multiple
  //      violations flushed by one tick" — inapplicable here.
  //
  //   2. `failClosed` (= `reason !== 'ok'`) — v1.6 exception clause
  //      2. The amber banner + Recheck button renders alone with NO
  //      per-row BOX and NO acknowledgement. Next is *fully disabled*
  //      until the user repairs the settings file and a fresh fetch
  //      (driven by `handleRecheck`) returns `reason: 'ok'`. The v1.5
  //      single-ack reuse of `acknowledged.permissionMode` was
  //      withdrawn — a tick that just promises "I will review
  //      manually" let the user wave through Phase 1 prompt-injection
  //      mitigation ② without enforcement (PR #44 CodeX attempt 2
  //      Finding 1 / option δ' adopted 2026-05-19).
  //
  //   3. Violation path (= `overallOk === false && reason === 'ok'`) —
  //      the default. The three BOXes render, and Next enables only
  //      when every per-BOX ack is true. Mixed result states where
  //      one row is OK and another is violated still demand all three
  //      ticks; the deliberate tick IS the rubber-stamp prevention.
  //
  // `allOk` mirrors the spec's AND of `overallOk === true` and
  // `reason === 'ok'`. Without the reason check, a malformed /
  // inconsistent server payload like `{ overallOk: true, reason:
  // 'read-error' }` would steer the wizard into the green-banner
  // fast path even though the underlying settings read was fail-
  // closed (CodeX attempt 2 — response invariant validation).
  const allOk =
    state?.result.overallOk === true && state?.result.reason === 'ok'
  const failClosed = state?.result.reason !== 'ok' && state !== null
  const allRequiredAcknowledged = (() => {
    if (!state) return false
    if (allOk) return true // v1.5 exception clause 1 — green banner, no BOX
    if (failClosed) return false // v1.6 exception clause 2 — block until fixed
    // Violation path — 3-ack AND across every BOX (v1.4 normative pin
    // applies here, not on the two exception clauses above).
    return (
      acknowledged.bypassMode &&
      acknowledged.permissionMode &&
      acknowledged.denyPattern
    )
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
   * v1.6 §9.5.2.3 exception clause 2 — Recheck handler.
   *
   * Drives the wizard back to a fresh settings-check after the user
   * (we hope) has repaired the underlying settings file. Three
   * normative obligations the spec pins:
   *
   *   1. 4-state reset (`acknowledged` 3-field + `ruleOfTwoEverOpened`
   *      + `ruleOfTwoClosedAt` + `whyOpen`). Without this, a
   *      previously-ticked bypass-mode acknowledgement or a satisfied
   *      "modal opened + 2 s idle" gate would survive the fail-closed
   *      → violation transition, letting the user skip the T-4-1 /
   *      T-4-2 / I-6 gate with stale local state.
   *
   *   2. `setState(null)` returns the component to the loading
   *      branch BEFORE the new fetch resolves. The fail-closed JSX
   *      (with this very Recheck button) unmounts as a result, so a
   *      duplicate click is structurally impossible until the next
   *      response either re-mounts a fail-closed banner or advances
   *      the wizard. No `isRechecking` flag, no `disabled` attribute,
   *      no debounce needed (spec explicitly forbids those variants
   *      as "half-measure mount maintenance").
   *
   *   3. Re-fetch with the same fail-closed-on-error posture as the
   *      initial useEffect — a network failure or shape-drifted
   *      payload collapses back to `buildFetchFailureResponse()` so
   *      the amber banner re-surfaces and the user can try again.
   *      Infinite loop is allowed; only user action terminates it.
   */
  const handleRecheck = useCallback(() => {
    const reset = createStepSecurityResetState()
    setAcknowledged(reset.acknowledged)
    setRuleOfTwoEverOpened(reset.ruleOfTwoEverOpened)
    setRuleOfTwoClosedAt(reset.ruleOfTwoClosedAt)
    setWhyOpen(reset.whyOpen)
    setState(null)
    // No local cancellation flag — spec v1.6 §9.5.2.3 in-flight
    // semantics: the Recheck button is structurally unmounted once
    // `setState(null)` drives us back into the loading branch, so a
    // second concurrent recheck cannot enter this handler. The
    // shared `fetchSettingsCheck` loader already collapses errors
    // into a fail-closed payload, so the amber banner re-surfaces
    // if the new fetch also fails.
    fetchSettingsCheck().then((data) => setState(data))
  }, [])

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
        // v1.6 §9.5.2.3 exception clause 2 — block-until-fixed UX.
        // The amber banner replaces every per-row BOX and every
        // acknowledgement; the user must repair the settings file
        // and click Recheck before onboarding continues. Partial
        // data on the response (e.g. `bypassMode.active`) is fully
        // suppressed at this level — no per-row BOX, no rule-of-two
        // card, no Why? modal — because a fail-closed read cannot
        // honestly report any individual recommendation status.
        <div
          data-testid="security-fail-closed"
          className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-400 dark:border-amber-700 p-3 text-amber-900 dark:text-amber-100 flex flex-col gap-2"
        >
          <p className="font-semibold">
            ⚠ {t('onboarding.security.failClosed')}
          </p>
          <p className="text-sm">
            {t('onboarding.security.failClosedRemediation')}
          </p>
          {/*
            The candidate path block is a *fixed* literal, not a
            render of `state.result.settingsFilePath`. The server-side
            `publicResult()` always redacts that field to `null` for
            information-disclosure reasons (CodeX attempt 7), so the
            renderer can never show a resolved absolute path; v1.6
            normative pin uses the two well-known candidates instead.
          */}
          <p className="text-xs font-mono whitespace-pre-wrap">
            {t('onboarding.security.failClosedCandidatePath')}
          </p>
          <div>
            <button
              type="button"
              data-testid="security-recheck"
              onClick={handleRecheck}
              className="mt-1 rounded-md border border-amber-500 dark:border-amber-600 px-3 py-1 text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              {t('onboarding.security.recheck')}
            </button>
          </div>
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
                    {/*
                      The rule-of-two accept text doubles as the
                      bypassMode BOX's per-item ack (spec v1.4
                      §9.5.2.3): it accepts the rule-of-two violation
                      AND records the bypassMode-BOX acknowledgement.
                      We render the rule-of-two-specific accept copy
                      here so the user sees the threat-model framing,
                      not the generic "I have reviewed" label; the
                      generic per-BOX label is reserved for the
                      non-bypass SecurityRow render path below.
                    */}
                    <span>{t('ruleOfTwo.violation.accept')}</span>
                    {ruleOfTwoAcceptDisabled && (
                      <span
                        data-testid="onboarding-rule-of-two-accept-hint"
                        className="text-[10px] text-red-700 dark:text-red-300"
                      >
                        {!ruleOfTwoEverOpened || whyOpen === 'bypassMode'
                          ? t('ruleOfTwo.violation.acceptDisabledHint.modal')
                          : t('ruleOfTwo.violation.acceptDisabledHint.idle')}
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
                ackLabelKey="onboarding.security.acknowledge.bypassMode"
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
              ackLabelKey="onboarding.security.acknowledge.permissionMode"
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
              ackLabelKey="onboarding.security.acknowledge.denyPattern"
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
  /**
   * i18n key for this BOX's individual acknowledgement label. Each
   * SecurityRow owns its own label rather than reusing a shared
   * "I have reviewed these recommendations" string so the per-BOX
   * scope is visible at the UI per spec §9.5.2.3 v1.4.
   */
  ackLabelKey: MessageKey
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
  ackLabelKey,
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
      {/*
        Per-BOX individual acknowledgement. v1.4 spec §9.5.2.3 makes
        this unconditional: even when the recommendation already
        evaluates as OK, the BOX still asks for an explicit tick so
        one rubber-stamp gesture cannot clear all three rows.
      */}
      <label className="flex items-start gap-2 text-xs mt-1 text-[var(--text-primary)]">
        <input
          type="checkbox"
          data-testid={`${testId}-acknowledge`}
          checked={acknowledged}
          onChange={(e) => onAcknowledgeChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>{t(ackLabelKey)}</span>
      </label>
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
