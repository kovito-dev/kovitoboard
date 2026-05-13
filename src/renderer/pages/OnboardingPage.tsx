/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { t, setLocale } from '../i18n'
import type { Locale } from '../i18n'
import type {
  KovitoboardSetting,
  ClaudeCodeSettingsWarning,
  SettingsCheckResult,
} from '../../shared/setting-types'
import { StepWelcome } from './onboarding/StepWelcome'
import { StepUser } from './onboarding/StepUser'
import { StepProject } from './onboarding/StepProject'
import { StepConcierge } from './onboarding/StepConcierge'
import { StepSecurity } from './onboarding/StepSecurity'
import { StepComplete } from './onboarding/StepComplete'
import { kbFetch } from '../lib/kbFetch'

// Spec onboarding-scenarios.md v1.2 §9.5 inserts a Security
// recommendations step between Concierge (Step 4) and Complete
// (Step 6). Total step count grows from 5 to 6 — older fixtures
// that hardcode `5` should be updated alongside.
const TOTAL_STEPS = 6

interface OnboardingPageProps {
  /**
   * Called after the settings file has been successfully written but
   * before navigating to '/'. Lets the parent update its cached
   * `onboardingComplete` flag so that the SPA does not bounce back to
   * /onboarding on the very next render.
   */
  onCompleted?: () => void
  /**
   * Whether a trust-prompt modal is currently shown. The wizard waits
   * for this to clear before triggering the post-completion full-page
   * reload, so a user-visible modal is not destroyed mid-interaction
   * (which previously caused the folder-trust dialog to flash and
   * vanish during onboarding).
   */
  isTrustPromptPending?: boolean
}

export function OnboardingPage({ onCompleted, isTrustPromptPending = false }: OnboardingPageProps = {}) {
  // Wizard state
  const [step, setStep] = useState(1)
  const [locale, setLocaleState] = useState<Locale>(
    navigator.language.startsWith('ja') ? 'ja' : 'en'
  )
  const [displayName, setDisplayName] = useState('')
  const [userAvatar, setUserAvatar] = useState<File | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [conciergeAdded, setConciergeAdded] = useState(false)
  const [projectRoot, setProjectRoot] = useState('')
  // Tracks whether handleComplete is in flight so the final button can
  // show a spinner and stay disabled until the full-page reload fires.
  const [isCompleting, setIsCompleting] = useState(false)
  // Opt-out for the CLAUDE.md guidance-block injection
  // (spec `claude-md-guidance-injection.md` v1.2 §7.2). Default OFF
  // — the wizard still injects on completion. Users who hand-roll
  // their CLAUDE.md can flip this on to skip the write.
  const [skipClaudeMdGuidance, setSkipClaudeMdGuidance] = useState(false)

  // Mirror the trust-prompt-pending flag into a ref so the async
  // handleComplete callback can poll the latest value without being
  // re-created on every change (avoids stale-closure bugs and keeps
  // the dependency list stable).
  const trustPromptPendingRef = useRef(isTrustPromptPending)
  useEffect(() => {
    trustPromptPendingRef.current = isTrustPromptPending
  }, [isTrustPromptPending])

  // Initialize locale on mount and fetch projectRoot
  useEffect(() => {
    setLocale(locale)
    kbFetch('/api/config/project-root')
      .then(r => r.json())
      .then(d => {
        const root: string = d.projectRoot || ''
        setProjectRoot(root)
        // OB-2: seed the application title input with the project
        // directory's basename so the first-run user starts with a
        // sensible default instead of an empty box. Only triggers
        // on the initial fetch (the setProjectName call below short-
        // circuits if the user has already typed anything thanks to
        // the functional updater check).
        if (root) {
          const trimmed = root.replace(/[\\/]+$/, '')
          const segs = trimmed.split(/[\\/]/)
          const basename = segs[segs.length - 1]
          if (basename) {
            setProjectName((current) => (current.length === 0 ? basename : current))
          }
        }
      })
      .catch(() => setProjectRoot(''))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLocaleChange = useCallback((newLocale: Locale) => {
    setLocale(newLocale)
    setLocaleState(newLocale)
  }, [])

  const handleConciergeNext = useCallback((added: boolean) => {
    setConciergeAdded(added)
    setStep(5)
  }, [])

  const handleSecurityNext = useCallback(() => {
    setStep(6)
  }, [])

  const handleComplete = useCallback(async () => {
    if (isCompleting) return
    setIsCompleting(true)

    // Fetch the current Claude Code recommended-settings check so we
    // can seed `claudeCodeSettingsWarning` with the reviewed snapshot.
    // Persisting a real dismiss record (vs a bare reviewedAt
    // timestamp) means the standard drift comparison applies: if the
    // user changes their Claude Code settings after onboarding, the
    // toast re-surfaces because the snapshot no longer matches
    // (CodeX attempt 3 — stale security suppression).
    let securityWarning: ClaudeCodeSettingsWarning | undefined
    try {
      const res = await kbFetch('/api/security/settings-check')
      if (res.ok) {
        const data = (await res.json()) as {
          result: SettingsCheckResult
        }
        const result = data.result
        if (result && !result.overallOk && !result.bypassMode.active) {
          securityWarning = {
            dismissedAt: new Date().toISOString(),
            dismissedResult: { ...result, settingsFilePath: null },
          }
        }
      }
    } catch {
      // Best-effort: a fetch failure simply means the toast will
      // surface on /agents until the user dismisses it manually.
    }

    // Save setting via API
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName, avatar: null },
      project: { name: projectName, description: projectDescription, path: projectRoot },
      locale,
      onboarding: {
        completedAt: new Date().toISOString(),
        wizardVersion: '0.1.0',
        // Kept as an audit / observability field even though the
        // dismiss-cooldown logic now relies on the seeded
        // claudeCodeSettingsWarning record (CodeX attempt 3). A
        // future migration may consolidate the two — for now both are
        // populated atomically so server-side readers can pick
        // whichever is more convenient.
        securityRecommendationsReviewedAt: new Date().toISOString(),
      },
      // When the wizard surfaced a real violation, seed the dismiss
      // record so the post-onboarding toast respects the same 24h
      // cooldown WITH drift detection. When everything was already
      // OK (no violation surfaced) we omit the field — there is
      // nothing to dismiss and a stale snapshot would create
      // surprising re-surfacing if the user later regresses their
      // settings.
      ...(securityWarning ? { claudeCodeSettingsWarning: securityWarning } : {}),
      // Persist the opt-out choice as `claudeMdGuidance.disabled`
      // when set; otherwise omit the struct entirely so older
      // tooling that does not know about the field is not surprised
      // by an unexpected `false`. Spec §7.2.
      ...(skipClaudeMdGuidance
        ? { claudeMdGuidance: { disabled: true } }
        : {}),
    }

    try {
      await kbFetch('/api/config/setting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setting),
      })

      // Upload the avatar selected in StepUser (Q11 / SM-4 fix).
      // Before this change the wizard collected the file into state
      // but persisted `avatar: null`, so the operator's choice
      // silently disappeared. POSTing here AFTER the setting.json
      // PUT is intentional: the user-avatar route refuses to write
      // without an existing setting file, so the order matters. We
      // best-effort: a failed upload only suppresses the avatar
      // surface, it must not block onboarding completion.
      if (userAvatar) {
        try {
          const buffer = await userAvatar.arrayBuffer()
          await kbFetch('/api/settings/user/avatar', {
            method: 'POST',
            headers: { 'Content-Type': userAvatar.type },
            body: buffer,
          })
        } catch {
          // Swallow — the user can re-upload from the settings
          // modal once onboarding finishes.
        }
      }

      // Start a session with Kobi if concierge was added. The tmux/claude
      // launch may take several seconds; the spinner in <StepComplete>
      // keeps the user informed while we wait.
      if (conciergeAdded) {
        await kbFetch('/api/sessions/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'kovito-concierge',
            initialPrompt: 'onboarding:first-time',
          }),
        })
      }
    } catch {
      // Best-effort; navigate to agents page regardless
    }

    // Wait for any pending trust-prompt modal (folder-trust, auto-mode,
    // etc.) to be resolved by the user before triggering the full-page
    // reload. Otherwise the user can be greeted by a modal that flashes
    // for a frame and vanishes the moment the reload fires — and any
    // half-typed / un-acknowledged response is lost. The detector
    // re-broadcasts pending prompts on WS reconnect, so a reload while a
    // modal is up does not technically lose the prompt; however the
    // server may also have just sent the initial message via tmux, and
    // those keystrokes can collapse the trust prompt before the user has
    // a chance to react. Polling here keeps the UX deterministic.
    //
    // The wait is bounded by user behavior (prompts only clear when the
    // user responds), so no explicit timeout — onboarding should not
    // forcibly proceed past a security-relevant dialog. The user can
    // also dismiss the modal via Esc, which clears the queue.
    if (conciergeAdded) {
      // Allow up to 1 s for the first prompt to even arrive (the WS event
      // races the fetch resolution; the prompt may not be in the queue
      // yet at this exact moment). After that, only wait while one is
      // actually pending.
      const arrivalDeadline = Date.now() + 1000
      while (Date.now() < arrivalDeadline && !trustPromptPendingRef.current) {
        await new Promise((r) => setTimeout(r, 100))
      }
      while (trustPromptPendingRef.current) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    // Notify the parent (App) that onboarding is complete so the
    // stale-state guard in App.tsx releases before the page reloads.
    onCompleted?.()

    // Full-page navigation (not SPA navigation) so every one-shot
    // useEffect hook — including useIPC's /api/agents fetch — rehydrates
    // from the freshly-written setting.json and the newly-created
    // agent/session files. Attempting to navigate with react-router
    // leaves the stale initial fetch results in place and the agent
    // list appears empty even though the files exist on disk.
    //
    // When a concierge session was created, land on Kobi's agent page
    // with a query flag so AgentDetailPage can auto-redirect to the
    // freshly-created session as soon as the watcher picks it up.
    // Otherwise land on the default agents page.
    const target = conciergeAdded
      ? '/agents/kovito-concierge?openLatestSession=1'
      : '/'
    window.location.assign(target)
  }, [isCompleting, displayName, projectName, projectDescription, projectRoot, locale, conciergeAdded, onCompleted, userAvatar, skipClaudeMdGuidance])

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <StepWelcome
            locale={locale}
            onLocaleChange={handleLocaleChange}
            onNext={() => setStep(2)}
          />
        )
      case 2:
        return (
          <StepUser
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            userAvatar={userAvatar}
            onUserAvatarChange={setUserAvatar}
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
          />
        )
      case 3:
        return (
          <StepProject
            projectName={projectName}
            onProjectNameChange={setProjectName}
            projectDescription={projectDescription}
            onProjectDescriptionChange={setProjectDescription}
            projectRoot={projectRoot}
            onNext={() => setStep(4)}
            onBack={() => setStep(2)}
          />
        )
      case 4:
        return (
          <StepConcierge
            locale={locale}
            onNext={handleConciergeNext}
            onBack={() => setStep(3)}
          />
        )
      case 5:
        return (
          <StepSecurity
            onNext={handleSecurityNext}
            onBack={() => setStep(4)}
          />
        )
      case 6:
        return (
          <StepComplete
            conciergeAdded={conciergeAdded}
            isCompleting={isCompleting}
            onComplete={handleComplete}
            skipClaudeMdGuidance={skipClaudeMdGuidance}
            onSkipClaudeMdGuidanceChange={setSkipClaudeMdGuidance}
          />
        )
      default:
        return null
    }
  }

  return (
    <div
      data-testid="onboarding-wizard"
      className="h-screen bg-[var(--bg-base)] flex flex-col items-center justify-center p-4"
    >
      <div className="w-full max-w-lg">
        {/* Step progress */}
        <div className="text-center mb-8">
          <span className="text-sm text-[var(--text-dim)]">
            {t('onboarding.step', { current: step, total: TOTAL_STEPS })}
          </span>
          {/* Progress bar */}
          <div className="mt-2 h-1 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--onboarding-accent)] rounded-full transition-all duration-300"
              style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
            />
          </div>
        </div>

        {/* Step content */}
        <div className="bg-[var(--bg-surface)] rounded-2xl p-8 border border-[var(--border)]">
          {renderStep()}
        </div>
      </div>
    </div>
  )
}
