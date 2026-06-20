/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * SecurityRecommendationsToast — startup warn for non-recommended
 * Claude Code settings (handoff
 * `v02x-phase1-claude-code-recommended-settings-check-request.md` v1.1
 * §3.3; spec `trust-prompt-relay.md` v1.3 §10.5).
 *
 * Phase 1 ④ extension
 * (`v02x-phase1-rule-of-two-warning-implementation-request.md` v1.1
 * §3.3): when bypass mode is active the toast swaps the per-row
 * violation list for a <RuleOfTwoViolationCard> + "Why?" link that
 * opens <RuleOfTwoExplanation>. The Dismiss button stays disabled
 * while bypass is active (I-7 / I-8 — re-surface every startup + every
 * mutation, never dismissable).
 *
 * Self-contained:
 *   1. Fetches `/api/security/settings-check` on mount.
 *   2. Hides itself when `suppressToast === true` (already dismissed
 *      within 24h cooldown) or when `result.overallOk === true`.
 *   3. Hides itself when the user is not yet onboarded — the
 *      OnboardingPage embeds the same surface inline via
 *      `<StepSecurity>` and the toast would otherwise double-up.
 *   4. POSTs to `/api/security/dismiss` when the user clicks Dismiss.
 *
 * Rubber-stamp prevention (handoff ② §3.3.3 + ④ §8 D-F, threat-model
 * §4.3): no "Approve All" button; each violation is listed in its own
 * row with a dedicated severity color, and bypass mode active is
 * surfaced via a prominent Rule of Two card that is not dismissable.
 */
import { useEffect, useState, useCallback } from 'react'
import { kbFetch } from '../lib/kbFetch'
import { t } from '../i18n'
import type { NewSessionResponse, SessionOrigin } from '../types'
import {
  type SecurityCheckResponse,
  buildFetchFailureResponse,
  isSecurityCheckResponse,
} from '../lib/securityCheckResponse'
import { useToast } from './Toast'
import { RuleOfTwoViolationCard } from './RuleOfTwoViolationCard'
import { RuleOfTwoExplanation } from './RuleOfTwoExplanation'

/**
 * Server-side initial-prompt dictionary key (see
 * `src/server/services/initial-prompts.ts`). Launching a session with
 * this key prefills a locale-aware prompt that asks an agent to add
 * `.kovitoboard/` to Claude Code's deny pattern — the remediation KB
 * cannot perform itself because it only reads Claude Code's settings.
 */
const ADD_DENY_PATTERN_PROMPT_KEY = 'security:add-deny-pattern'

interface SecurityRecommendationsToastProps {
  /**
   * Whether the user has finished onboarding. Defaults to true so the
   * toast is shown for the common post-onboarding flow; the App
   * wrapper passes `false` during the onboarding wizard so the inline
   * StepSecurity surface does not double up with the toast.
   */
  onboardingComplete?: boolean
  /**
   * Starts a new session. Wired to `useIPC().startNewSession` by the
   * App wrapper. Used by the "ask an agent" remediation button to
   * launch a session prefilled with the deny-pattern fix prompt.
   * `agentId` is intentionally left undefined so the session starts
   * with the vanilla `claude` agent — the remediation does not depend
   * on any configured agent existing.
   */
  startNewSession: (
    message: string | undefined,
    agentId?: string,
    options?: { origin?: SessionOrigin; initialPrompt?: string },
  ) => Promise<NewSessionResponse>
}

export function SecurityRecommendationsToast({
  onboardingComplete = true,
  startNewSession,
}: SecurityRecommendationsToastProps) {
  const { addToast } = useToast()
  const [state, setState] = useState<SecurityCheckResponse | null>(null)
  // After a successful dismiss we optimistically suppress the toast
  // until the next `/api/security/settings-check` response arrives.
  // The server response is the source of truth for visibility — the
  // server already evaluates the 24h cooldown + drift comparison —
  // so we clear this flag as soon as a new state lands, ensuring
  // the toast resurfaces when the cooldown expires or the user
  // changes their settings (CodeX attempt 12 — warning suppression
  // drift).
  const [optimisticHidden, setOptimisticHidden] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  // Guards the "ask an agent" remediation button against double-submit
  // while the session is being launched.
  const [asking, setAsking] = useState(false)
  // Tracks whether the Rule of Two explanation modal is currently
  // mounted on top of the toast (Phase 1 ④ §3.3 + §3.5).
  const [explanationOpen, setExplanationOpen] = useState(false)

  useEffect(() => {
    if (!onboardingComplete) return
    let cancelled = false
    const load = () => {
      kbFetch('/api/security/settings-check')
        .then((r) => {
          if (!r.ok) throw new Error(`status ${r.status}`)
          return r.json()
        })
        .then((data: unknown) => {
          if (cancelled) return
          // Runtime guard against shape-drifted payloads (CodeX
          // attempt 27 — runtime type safety). A response that does
          // not match `SecurityCheckResponse` falls back to the
          // fail-closed banner instead of crashing on a missing
          // field.
          if (!isSecurityCheckResponse(data)) {
            setState(buildFetchFailureResponse())
            setOptimisticHidden(false)
            return
          }
          setState(data)
          // Clear the optimistic dismiss flag once a fresh server
          // response is in hand — the server's `suppressToast`
          // verdict already reflects the cooldown / drift state,
          // so honoring the local flag any longer would prevent
          // legitimate re-surfacing (CodeX attempt 12).
          setOptimisticHidden(false)
        })
        .catch(() => {
          if (cancelled) return
          // Fail-closed: surface the warning UX even when
          // /api/security/* is unreachable so an outage cannot
          // silently dismiss the recommendation channel.
          setState(buildFetchFailureResponse())
          // Also clear the optimistic hide so a transient fetch
          // failure cannot keep the warning suppressed for the rest
          // of the session (CodeX attempt 21 — fail-closed warning
          // suppression).
          setOptimisticHidden(false)
        })
    }
    load()
    // Refetch when the user returns to the tab / window so a
    // settings mutation made outside KB (the runtime watcher case)
    // is reflected without requiring a full reload (CodeX attempt 9
    // — stale security warning state).
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      // Don't clobber a freshly-dismissed local hide; the suppress
      // logic on the server side reflects the dismiss persistence,
      // so re-running the fetch is safe.
      load()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onVisibility)
    }
    return () => {
      cancelled = true
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onVisibility)
      }
    }
  }, [onboardingComplete])

  const handleDismiss = useCallback(async () => {
    if (dismissing) return
    setDismissing(true)
    try {
      const response = await kbFetch('/api/security/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (response.ok) {
        setOptimisticHidden(true)
      }
    } catch {
      // best-effort
    } finally {
      setDismissing(false)
    }
  }, [dismissing])

  // "Ask an agent to fix this": KB only reads Claude Code's settings
  // and cannot write the deny pattern itself, so we hand the
  // remediation to an agent by starting a session prefilled with the
  // `security:add-deny-pattern` dictionary prompt. We pass no agentId
  // so the vanilla `claude` agent runs — this path does not depend on
  // any configured agent existing, so there is no "0 agents" failure
  // mode to guard against here.
  //
  // On success we optimistically hide the toast ONLY when the deny
  // pattern is the sole remaining violation: this prompt fixes
  // `permissions.deny` and nothing else, so if `permissionMode` is also
  // out of compliance we must keep the toast visible rather than
  // suppress an unrelated, still-unfixed recommendation. In either case
  // the next settings-check (mount / visibility / focus refetch) is the
  // source of truth and resurfaces any violation that is still present.
  // On failure we surface a toast and leave the warning in place.
  const handleAskAgent = useCallback(async () => {
    if (asking) return
    setAsking(true)
    try {
      await startNewSession(undefined, undefined, {
        origin: 'sidebar',
        initialPrompt: ADD_DENY_PATTERN_PROMPT_KEY,
      })
      // Only hide when the deny pattern is the only open recommendation,
      // so launching the deny-pattern fix cannot mask a permissionMode
      // warning the prompt does not address.
      if (state?.result.permissionMode.ok === true) {
        setOptimisticHidden(true)
      }
    } catch {
      addToast(t('security.toast.askAgentFailed'), 'error')
    } finally {
      setAsking(false)
    }
  }, [asking, startNewSession, addToast, state])

  if (!onboardingComplete) return null
  if (optimisticHidden) return null
  if (!state) return null
  if (state.suppressToast) return null
  if (state.result.overallOk) return null

  const { result } = state
  const failClosed = result.reason !== 'ok'
  const bypassActive = result.bypassMode.active === true

  return (
    <>
      <div
        data-testid="security-recommendations-toast"
        className="fixed top-4 right-4 z-50 max-w-md rounded-xl border border-amber-400/50 bg-amber-50 dark:bg-amber-950/90 dark:border-amber-700/50 shadow-lg p-4 text-sm"
        role="alert"
        aria-live="polite"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="font-semibold text-amber-900 dark:text-amber-100 mb-2">
              ⚠️ {t('security.toast.title')}
            </div>
            {failClosed ? (
              <p className="text-amber-800 dark:text-amber-200">
                {t('security.toast.failClosed')}
              </p>
            ) : bypassActive ? (
              /*
               * Phase 1 ④ §3.3: surface the Rule of Two violation
               * prominently when bypass mode is active. The card
               * supersedes the per-row list (the permissionMode row
               * would otherwise duplicate the same bypass concern in
               * a less actionable form); a denyPattern violation
               * still surfaces below as an independent issue.
               */
              <>
                <RuleOfTwoViolationCard
                  testId="toast-rule-of-two"
                  onOpenWhy={() => setExplanationOpen(true)}
                />
                {!result.denyPattern.ok && (
                  <ul className="space-y-1 list-none ml-0 mt-2">
                    <li
                      data-testid="violation-denyPattern"
                      className="text-amber-700 dark:text-amber-300"
                    >
                      ✗ {t('security.toast.denyPattern.violation')}
                    </li>
                  </ul>
                )}
              </>
            ) : (
              <>
                <p className="text-amber-800 dark:text-amber-200 mb-2">
                  {t('security.toast.intro')}
                </p>
                <ul className="space-y-1 list-none ml-0">
                  {!result.permissionMode.ok && (
                    <li
                      data-testid="violation-permissionMode"
                      className="text-red-700 dark:text-red-300"
                    >
                      ✗ {t('security.toast.permissionMode.violation', {
                        current: result.permissionMode.current,
                      })}
                    </li>
                  )}
                  {!result.denyPattern.ok && (
                    <li
                      data-testid="violation-denyPattern"
                      className="text-amber-700 dark:text-amber-300"
                    >
                      ✗ {t('security.toast.denyPattern.violation')}
                    </li>
                  )}
                  {!result.bypassMode.ok && (
                    <li
                      data-testid="violation-bypassMode"
                      className="text-red-700 dark:text-red-300"
                    >
                      ✗ {t('security.toast.bypassMode.violation')}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-3">
          {/*
           * "Ask an agent to fix this" — only offered when a deny-
           * pattern violation is the actionable issue. Hidden while
           * fail-closed (settings unreadable, so there is nothing
           * concrete to fix yet) or while bypass mode is active (the
           * Rule of Two violation is the dominant concern and must be
           * resolved by the user, not delegated). Mirrors the dismiss
           * button's disabled guards.
           */}
          {!failClosed && !bypassActive && !result.denyPattern.ok && (
            <button
              type="button"
              data-testid="security-toast-ask-agent"
              onClick={handleAskAgent}
              disabled={asking}
              className="text-xs px-3 py-1 rounded-md border border-amber-700/40 bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('security.toast.askAgent')}
            </button>
          )}
          {/*
           * T-2-3 / I-7: dismiss is intentionally disabled when bypass
           * mode is active. The Rule of Two violation must re-surface
           * every startup; the server-side endpoint also enforces this,
           * so the disabled state is purely a UX affordance.
           */}
          <button
            type="button"
            onClick={handleDismiss}
            disabled={dismissing || bypassActive || failClosed}
            className="text-xs px-3 py-1 rounded-md border border-amber-700/40 text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('security.toast.dismiss')}
          </button>
        </div>
      </div>
      {explanationOpen && (
        <RuleOfTwoExplanation onClose={() => setExplanationOpen(false)} />
      )}
    </>
  )
}
