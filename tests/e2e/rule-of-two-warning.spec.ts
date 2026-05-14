/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E coverage for Phase 1 prompt injection ④ — Rule of Two
 * violation warning when bypass mode is active (handoff
 * `v02x-phase1-rule-of-two-warning-implementation-request.md` v1.1
 * §3.2 + §3.3 + §3.5 + §8).
 *
 * Scope:
 *   - Post-onboarding toast surfaces the Rule of Two violation card
 *     (testid `toast-rule-of-two`) instead of the per-row list when
 *     bypass mode is active.
 *   - "Why?" link opens the RuleOfTwoExplanation modal with the
 *     (A)(B)(C) elements + KB-context + HITL + responsibility boundary
 *     blocks (T-3-5 rubber-stamp prevention coverage / D-E).
 *   - Toast Dismiss button is disabled while bypass is active (I-7 +
 *     I-8 — re-surface every startup + every mutation, never
 *     dismissable).
 *   - Onboarding wizard StepSecurity swaps the bypass row for the same
 *     prominent Rule of Two card with an accept gate that:
 *       - stays disabled until the explanation modal is opened (I-6),
 *       - stays disabled for ≥ 2 s after the modal closes (D-E reading
 *         delay),
 *       - rejects synthetic / programmatic accept clicks via
 *         `event.isTrusted` (T-4-1 / I-6).
 *
 * Fixture strategy: the L1 fixture does not create a
 * `.claude/settings.json`, so `/api/security/settings-check` returns
 * the deterministic "denyPattern violation only" state. We use
 * `page.route()` to intercept the endpoint and substitute a
 * bypass-mode-active response. This keeps the fixture footprint
 * unchanged while exercising the bypass-active rendering path that the
 * unit / Phase 1 ② specs cannot reach.
 */
import { test, expect } from './helpers/l1-per-test-setup'

interface MockedSettingsResponse {
  result: {
    permissionMode: { current: string; recommended: 'default'; ok: boolean }
    denyPattern: { hasKovitoboardDeny: boolean; ok: boolean; remediation: string }
    bypassMode: { active: boolean; ok: boolean }
    overallOk: boolean
    reason: string
    settingsFilePath: string | null
  }
  suppressToast: boolean
  dismissExpiresAt: string | null
}

function bypassActiveResponse(): MockedSettingsResponse {
  return {
    result: {
      permissionMode: { current: 'bypassPermissions', recommended: 'default', ok: false },
      denyPattern: {
        hasKovitoboardDeny: false,
        ok: false,
        remediation:
          'Add ".kovitoboard/" to permissions.deny in your Claude Code settings.',
      },
      bypassMode: { active: true, ok: false },
      overallOk: false,
      reason: 'ok',
      settingsFilePath: null,
    },
    suppressToast: false,
    dismissExpiresAt: null,
  }
}

async function mockBypassActive(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/security/settings-check', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bypassActiveResponse()),
    })
  })
}

test.describe('Rule of Two violation toast (onboarded user)', () => {
  test('bypass mode active 時、トーストが Rule of Two violation card を表示する', async ({
    page,
  }) => {
    await mockBypassActive(page)
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    const toast = page.getByTestId('security-recommendations-toast')
    await expect(toast).toBeVisible({ timeout: 5000 })

    // Rule of Two card replaces the per-row list under bypass-active.
    const card = page.getByTestId('toast-rule-of-two')
    await expect(card).toBeVisible()

    // 3 elements (A)(B)(C) are present with their KB-context
    // annotations (handoff §3.2 sample UI).
    await expect(
      page.getByTestId('toast-rule-of-two-element-untrustedInput'),
    ).toBeVisible()
    await expect(
      page.getByTestId('toast-rule-of-two-element-sensitiveData'),
    ).toBeVisible()
    await expect(
      page.getByTestId('toast-rule-of-two-element-externalState'),
    ).toBeVisible()

    // The legacy violation-bypassMode row must NOT render under
    // bypass-active — the Rule of Two card supersedes it (avoids
    // duplicate / less-actionable surfaces).
    await expect(page.getByTestId('violation-bypassMode')).toHaveCount(0)
  })

  test('Dismiss ボタンが bypass active で disabled になる (I-7 / I-8)', async ({
    page,
  }) => {
    await mockBypassActive(page)
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    const toast = page.getByTestId('security-recommendations-toast')
    await expect(toast).toBeVisible({ timeout: 5000 })

    const dismiss = toast.getByRole('button', { name: /Dismiss|閉じる/ })
    await expect(dismiss).toBeDisabled()
  })

  test('Why? リンクで RuleOfTwoExplanation modal が開く', async ({ page }) => {
    await mockBypassActive(page)
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('toast-rule-of-two')).toBeVisible({
      timeout: 5000,
    })

    await page.getByTestId('toast-rule-of-two-why-link').click()
    const modal = page.getByTestId('rule-of-two-explanation')
    await expect(modal).toBeVisible()

    // Modal explains the 3 elements + responsibility boundary so the
    // user has a single source of truth for "why this matters".
    await expect(page.getByTestId('rule-of-two-element-untrustedInput')).toBeVisible()
    await expect(page.getByTestId('rule-of-two-element-sensitiveData')).toBeVisible()
    await expect(page.getByTestId('rule-of-two-element-externalState')).toBeVisible()

    await page.getByTestId('rule-of-two-explanation-close').click()
    await expect(modal).toBeHidden()
  })
})

test.describe('@preonboarding Rule of Two onboarding step', () => {
  // The onboarding wizard renders before /api/security/settings-check is
  // fetched by StepSecurity, so we mock the response BEFORE navigating
  // so the bypass-active branch is selected from the very first render.
  async function advanceToSecurityStep(
    page: import('@playwright/test').Page,
  ): Promise<void> {
    await mockBypassActive(page)
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: /Get Started|始める/ }).click()
    await page.locator('input[type="text"]').first().fill('Tester')
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Add later|あとで追加する/ }).click()

    await expect(page.getByTestId('onboarding-step-security')).toBeVisible({
      timeout: 5000,
    })
  }

  test('@preonboarding bypass mode active → Rule of Two card が onboarding に出る', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)
    const card = page.getByTestId('onboarding-rule-of-two')
    await expect(card).toBeVisible()
    // The legacy bypass row is replaced by the Rule of Two card under
    // bypass-active — the row-bypassMode test-id must NOT render.
    await expect(page.getByTestId('row-bypassMode')).toHaveCount(0)
  })

  test('@preonboarding accept は Why? modal を開く前は disabled (T-4-2 / I-6)', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeDisabled()
    // Hint copy explains why so the user is not stuck.
    await expect(
      page.getByTestId('onboarding-rule-of-two-accept-hint'),
    ).toBeVisible()
  })

  test('@preonboarding Why? modal を開いて閉じても idle 中は accept disabled', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)

    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await expect(page.getByTestId('rule-of-two-explanation')).toBeVisible()
    await page.getByTestId('rule-of-two-explanation-close').click()
    await expect(page.getByTestId('rule-of-two-explanation')).toBeHidden()

    // Immediately after close — still inside the 2 s idle window.
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeDisabled()
  })

  test('@preonboarding 2 s idle 経過後に accept enable', async ({ page }) => {
    await advanceToSecurityStep(page)

    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await page.getByTestId('rule-of-two-explanation-close').click()

    // Wait past the 2 s idle window.
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeEnabled({ timeout: 4000 })
  })

  test('@preonboarding programmatic (synthetic) click は accept state を変えない (T-4-1)', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)

    // Pass the modal-opened + idle gate via the real user path so the
    // checkbox can be interacted with.
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await page.getByTestId('rule-of-two-explanation-close').click()
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeEnabled({ timeout: 4000 })

    // Synthesize a click event from inside the page — `event.isTrusted`
    // is `false` for events constructed via `new MouseEvent` /
    // `dispatchEvent`, mirroring the attack scenario where recipe JS
    // dispatches a programmatic click against the onboarding UI.
    await page.evaluate(() => {
      const node = document.querySelector(
        '[data-testid="onboarding-rule-of-two-accept"]',
      ) as HTMLInputElement | null
      if (!node) throw new Error('accept checkbox not found')
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // A programmatic change event is also synthesized to mirror
      // libraries that fire onChange directly.
      node.checked = true
      node.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The `event.isTrusted` guard in StepSecurity's onChange handler
    // refuses the synthetic event, so React's controlled-checkbox state
    // remains unchecked. (The bare DOM `.checked = true` mutation
    // above is not enough — React re-renders from its own state on the
    // next tick and reverts the DOM checked attribute.)
    await page.waitForTimeout(150)
    await expect(accept).not.toBeChecked()

    // A real user click via Playwright dispatches a trusted event,
    // which IS accepted.
    await accept.check()
    await expect(accept).toBeChecked()
  })

  test('@preonboarding modal 再開で accept が再 disabled になる (gate re-arm regression)', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)

    // First cycle: open → close → wait past idle → accept enables.
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await page.getByTestId('rule-of-two-explanation-close').click()
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeEnabled({ timeout: 4000 })

    // Re-open the modal: accept must disable again while the modal is
    // mounted so a keyboard-focused checkbox cannot be toggled from
    // behind the dialog (background interaction guard).
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await expect(page.getByTestId('rule-of-two-explanation')).toBeVisible()
    await expect(accept).toBeDisabled()

    // After the second close the idle window re-arms — accept stays
    // disabled inside the 2 s gate, then re-enables after it elapses.
    await page.getByTestId('rule-of-two-explanation-close').click()
    await expect(accept).toBeDisabled()
    await expect(accept).toBeEnabled({ timeout: 4000 })
  })

  test('@preonboarding modal re-open で既に tick 済 acknowledgement も reset される', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)

    // Pass the gate once and tick accept.
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await page.getByTestId('rule-of-two-explanation-close').click()
    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeEnabled({ timeout: 4000 })
    await accept.check()
    await expect(accept).toBeChecked()

    // Re-open the explanation modal. The accept state must invalidate
    // immediately so the user cannot proceed without going through the
    // full "open / read / close / wait / accept" cycle again. Without
    // this reset, a stale "checked" state would keep the Next-button
    // gate satisfied even though the user has re-entered the
    // explanation flow.
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await expect(accept).not.toBeChecked()
  })

  test('@preonboarding accept tick → Next 有効化 (denyPattern 行も ack 必須)', async ({
    page,
  }) => {
    await advanceToSecurityStep(page)

    // Open + close Why? to clear the modal-opened gate.
    await page.getByTestId('onboarding-rule-of-two-why-link').click()
    await page.getByTestId('rule-of-two-explanation-close').click()

    const accept = page.getByTestId('onboarding-rule-of-two-accept')
    await expect(accept).toBeEnabled({ timeout: 4000 })
    await accept.check()

    // The bypass-active mock also reports a denyPattern violation, so
    // that row's per-item ack is still required to unlock Next.
    const denyAck = page.getByTestId('row-denyPattern-acknowledge')
    if (await denyAck.isVisible().catch(() => false)) {
      await denyAck.check()
    }
    // permissionMode violation row also surfaces independently (since
    // permissionMode = bypassPermissions is non-default) — tick it too.
    const pmAck = page.getByTestId('row-permissionMode-acknowledge')
    if (await pmAck.isVisible().catch(() => false)) {
      await pmAck.check()
    }

    await expect(page.getByTestId('security-next')).toBeEnabled()
  })
})
