/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Idle-send regression (fix: "keep idle-session sends in the same session").
 *
 * What the fix changed
 * --------------------
 * An `idle` session is NOT a terminated one: the 5-minute idle timer only
 * flips the status label while the claude process and its tmux window stay
 * alive. A plain tmux send to such a session appends to the SAME claude
 * session (claude only starts a fresh JSONL session on `/clear`). The old
 * `SessionDetailPage.handleSendMessage` armed `startPendingNewSession` on
 * an idle send, so the page waited for a brand-new session that never
 * appeared — leaving the "new topic" control stuck in its pending/loading
 * state and the typing indicator showing forever, even though the reply was
 * already streamed into the session on screen. The fix removes that idle
 * branch; an idle send is now a normal send into the current session.
 *
 * Coverage (this spec)
 * --------------------
 * 1. Idle send → the reply appends to the SAME session on screen; the page
 *    does NOT navigate away and `isPendingNewSession` does NOT latch.
 * 2. Non-idle (ready) send behaves the same (no regression to the active
 *    path): reply appends to the same session, no navigation.
 * 3. Contrast / regression guard: the "Continue" (/clear new-topic) path
 *    DOES still arm `isPendingNewSession` and navigate to the brand-new
 *    session — proving the fix narrowed the behaviour to the idle-send
 *    branch only and did not disable pending-new-session everywhere.
 *
 * How the harness drives this without a live claude
 * -------------------------------------------------
 * - A session is surfaced by seeding a transcript JSONL into the Watcher's
 *   project sessions dir (helpers/session-seed.ts). The seeded
 *   `agent-setting` line binds it to a chosen agentId.
 * - A quiet tmux window named after that agentId (helpers/idle-agent-window.ts)
 *   makes the idle session "sendable" (isSessionSendable Condition 1: the
 *   agent has a tmux window AND this is the agent's latest session) so the
 *   MessageInput box is rendered even while status is `idle` — the exact UI
 *   surface the bug lived on. (The Fake Claude harness is deliberately NOT
 *   used here: its scenarios paint a trust prompt whose modal overlay would
 *   intercept the send button.)
 * - Idle status is forced deterministically (no 5-minute wait) via
 *   `POST /api/agents/:agentId/deactivate-sessions`, the production seam
 *   that flips active sessions to idle.
 * - A "claude reply" is simulated by appending a live assistant line to the
 *   same JSONL; the Watcher emits a `new_event` for that sessionId, which
 *   the renderer appends to the session already on screen.
 *
 * Observables (ChatTimeline has no testids — assert via text / role / URL):
 * - `isPendingNewSession` is reflected by the header "new topic" button:
 *   `New topic` when false, `Active` (+ pulse) when latched.
 * - Continue button (read-only branch): `Continue in new session`,
 *   `Continuing...` while pending.
 * - The L1 page fixture seeds `kb.locale='ja'`, but the fixture
 *   `setting.json` pins `locale: 'en'`, which `bootstrapLocaleFromSetting`
 *   applies last — so the ENGLISH copy actually renders. Assertions below
 *   use the English strings (the established L1 convention; see
 *   agent-management.spec.ts).
 */
import { test, expect } from './helpers/l1-per-test-setup'
import {
  startIdleAgentWindow,
  type IdleAgentWindow,
} from './helpers/idle-agent-window'
import { seedSession, type SeededSession } from './helpers/session-seed'
import type { Page } from '@playwright/test'

const TOPIC_NEW = 'New topic'
const TOPIC_ACTIVE = 'Active'
const CONTINUE_BUTTON = 'Continue in new session'
const CONTINUE_LOADING = 'Continuing...'
const PLACEHOLDER_RESUME = /Resume session/
const PLACEHOLDER_ACTIVE = /Type a message/

/**
 * A message bubble in the timeline renders its text inside
 * `<span class="whitespace-pre-wrap">` (MessageBubble.tsx). The same text
 * also appears in the sidebar session summary (`.truncate`) and lingers in
 * the textarea value, so assertions scope to the bubble span to stay in
 * Playwright strict mode.
 */
function bubble(page: Page, text: string) {
  return page.locator('span.whitespace-pre-wrap', { hasText: text })
}

/**
 * An assistant reply renders through MarkdownPreview as a `<p>` paragraph
 * (MessageBubble.tsx). The text also lands in the sidebar session summary
 * (`.truncate`), so assertions scope to the paragraph to stay in strict
 * mode. Substring `hasText` tolerates markdown re-wrapping / trailing
 * punctuation differences.
 */
function assistantBubble(page: Page, text: string) {
  return page.getByRole('paragraph').filter({ hasText: text })
}

/** Poll the server until `predicate` over GET /api/sessions holds. */
async function waitForSessionState(
  page: Page,
  apiBaseUrl: string,
  sessionId: string,
  predicate: (s: { id: string; status: string; agentId?: string }) => boolean,
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${apiBaseUrl}/api/sessions`)
        if (!res.ok()) return false
        const sessions = (await res.json()) as Array<{
          id: string
          status: string
          agentId?: string
        }>
        const s = sessions.find((x) => x.id === sessionId)
        return s ? predicate(s) : false
      },
      { message: label, timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toBe(true)
}

test.describe('idle-send keeps the same session', () => {
  test('idle send appends the reply to the same session and does not arm pending-new-session', async ({
    page,
    kbFixture,
  }) => {
    test.setTimeout(60_000)

    const agentId = 'idle-send-agent'
    let seeded: SeededSession | undefined
    // A quiet tmux window (no trust prompt) so the agent appears in
    // getAgentWindowMap and the idle session is "sendable" (MessageInput).
    const win: IdleAgentWindow = startIdleAgentWindow(kbFixture.tmuxSession, agentId)

    try {
      // 1. Surface the session bound to the agent (tmux window already up).
      seeded = seedSession(kbFixture.projectRoot, { agentId })

      // 2. Wait until the server sees the session bound to the agent.
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        seeded.sessionId,
        (s) => s.agentId === agentId,
        'seeded session is bound to the agent',
      )

      // 3. Force idle (the production deactivate seam, no 5-minute wait).
      const deact = await page.request.post(
        `${kbFixture.apiBaseUrl}/api/agents/${agentId}/deactivate-sessions`,
      )
      expect(deact.ok()).toBeTruthy()
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        seeded.sessionId,
        (s) => s.status === 'idle',
        'session is idle after deactivate',
      )

      // 4. Navigate AFTER the server state has settled so the renderer's
      //    initial load picks up sessions + session-agent-map + tmux-status
      //    in one shot (tmux status is only re-polled every 60s, so the
      //    window must already exist at mount — it does).
      await page.goto(`/sessions/${seeded.sessionId}`)
      await page.waitForLoadState('networkidle')

      // The MessageInput box must be present: an idle-but-sendable session
      // (latest for the agent + live tmux window) renders the input, NOT
      // the read-only / Continue surface. This is the bug's UI surface.
      // The `resume` placeholder confirms the idle (not active) variant.
      const input = page.getByTestId('message-input-textarea')
      await expect(input).toBeVisible()
      await expect(input).toHaveAttribute('placeholder', PLACEHOLDER_RESUME)

      // Sanity: pending-new-session is NOT latched before we send. The
      // header "new topic" button shows `New topic` (not the pending
      // `Active`). Match the span text directly (exact) — it is the
      // unambiguous reflection of `isPendingNewSession` on this page.
      await expect(page.getByText(TOPIC_NEW, { exact: true })).toBeVisible()
      await expect(page.getByText(TOPIC_ACTIVE, { exact: true })).toHaveCount(0)

      // 5. Send an idle message.
      const sentText = 'Resume please — does this stay in the same session?'
      await input.click()
      await input.fill(sentText)
      await page.getByTestId('message-input-send').click()

      // Optimistic UI: the user message bubble appears immediately here.
      await expect(bubble(page, sentText)).toBeVisible()

      // 6. Simulate claude appending the reply into the SAME session.
      const replyText = 'Yes — this reply belongs to the same session.'
      seeded.appendAssistantReply(replyText)

      // 7a. The reply lands on the SAME page (no navigation to a new id).
      await expect(assistantBubble(page, replyText)).toBeVisible({ timeout: 15_000 })
      await expect(page).toHaveURL(new RegExp(`/sessions/${seeded.sessionId}$`))

      // 7b. Regression assertion: pending-new-session was never armed.
      //     The header "new topic" button stays `New topic` and never
      //     flips to the pending `Active` label. (Pre-fix it latched to
      //     `Active` and the page waited for a session that never came —
      //     verified: this spec fails on the pre-fix staging build here.)
      await expect(page.getByText(TOPIC_ACTIVE, { exact: true })).toHaveCount(0)
      await expect(page.getByText(TOPIC_NEW, { exact: true })).toBeVisible()
    } finally {
      if (seeded) seeded.dispose()
      win.dispose()
    }
  })

  test('ready (non-idle) send also stays in the same session', async ({
    page,
    kbFixture,
  }) => {
    test.setTimeout(60_000)

    const agentId = 'ready-send-agent'
    let seeded: SeededSession | undefined
    const win: IdleAgentWindow = startIdleAgentWindow(kbFixture.tmuxSession, agentId)

    try {
      // Seed the session, then drive it to a non-idle (`ready`) status with
      // a guaranteed-LIVE assistant end_turn append. We do not rely on the
      // opening turn's status: the Watcher treats a file's first
      // drain-to-EOF as historical (status held) when it observes the file
      // only after content already exists, so the opening turn's status is
      // racy. Once the session is visible in the API the file's offset is
      // committed, so every later append is live and updates status
      // (watcher.ts INV-2).
      seeded = seedSession(kbFixture.projectRoot, { agentId })
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        seeded.sessionId,
        (s) => s.agentId === agentId,
        'session is bound to the agent',
      )
      seeded.appendAssistantReply('Live turn to make the session ready.')
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        seeded.sessionId,
        (s) => s.status === 'ready',
        'session is ready (non-idle) after a live assistant end_turn',
      )

      await page.goto(`/sessions/${seeded.sessionId}`)
      await page.waitForLoadState('networkidle')

      // Non-idle → active placeholder.
      const input = page.getByTestId('message-input-textarea')
      await expect(input).toBeVisible()
      await expect(input).toHaveAttribute('placeholder', PLACEHOLDER_ACTIVE)

      const sentText = 'Active send — stay here too.'
      await input.click()
      await input.fill(sentText)
      await page.getByTestId('message-input-send').click()
      await expect(bubble(page, sentText)).toBeVisible()

      const replyText = 'Active reply in the same session.'
      seeded.appendAssistantReply(replyText)

      await expect(assistantBubble(page, replyText)).toBeVisible({ timeout: 15_000 })
      await expect(page).toHaveURL(new RegExp(`/sessions/${seeded.sessionId}$`))
      await expect(page.getByText(TOPIC_ACTIVE, { exact: true })).toHaveCount(0)
    } finally {
      if (seeded) seeded.dispose()
      win.dispose()
    }
  })

  test('the Continue (/clear) path still arms pending-new-session and navigates to the new session', async ({
    page,
    kbFixture,
  }) => {
    test.setTimeout(60_000)

    // No tmux window is started for this agent → an idle session for it is
    // NOT "sendable" (isSessionSendable needs a live tmux window for the
    // agent's latest session). The page therefore renders the read-only
    // surface with the Continue button instead of the MessageInput box.
    // Clicking Continue runs handleStartNewTopic (the /clear path), which
    // DOES legitimately arm pending-new-session and navigate to the
    // brand-new session — the behaviour the fix deliberately preserved.
    const agentId = 'continue-agent'
    let oldSession: SeededSession | undefined
    let newSession: SeededSession | undefined

    try {
      oldSession = seedSession(kbFixture.projectRoot, { agentId })
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        oldSession.sessionId,
        (s) => s.agentId === agentId,
        'old session is bound to the agent',
      )

      // Force idle so the Continue surface is eligible (status === 'idle').
      await page.request.post(
        `${kbFixture.apiBaseUrl}/api/agents/${agentId}/deactivate-sessions`,
      )
      await waitForSessionState(
        page,
        kbFixture.apiBaseUrl,
        oldSession.sessionId,
        (s) => s.status === 'idle',
        'old session is idle',
      )

      await page.goto(`/sessions/${oldSession.sessionId}`)
      await page.waitForLoadState('networkidle')

      // Continue button is the surface here (read-only idle session).
      const continueButton = page.getByRole('button', {
        name: new RegExp(CONTINUE_BUTTON),
      })
      await expect(continueButton).toBeVisible()

      await continueButton.click()

      // pending-new-session latches: the button flips to the loading copy.
      await expect(
        page.getByRole('button', { name: new RegExp(CONTINUE_LOADING) }),
      ).toBeVisible()

      // The /clear path creates a brand-new session. Simulate claude
      // emitting that new session bound to the same agent.
      newSession = seedSession(kbFixture.projectRoot, {
        agentId,
        openingUser: 'New topic after /clear.',
        openingAssistant: 'Fresh session reply.',
      })

      // The page navigates to the new session id (pending-new-session
      // detection resolves once the new session for this agent appears).
      await expect(page).toHaveURL(
        new RegExp(`/sessions/${newSession.sessionId}$`),
        { timeout: 15_000 },
      )
      await expect(page).not.toHaveURL(
        new RegExp(`/sessions/${oldSession.sessionId}$`),
      )
    } finally {
      if (oldSession) oldSession.dispose()
      if (newSession) newSession.dispose()
    }
  })
})
