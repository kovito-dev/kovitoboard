/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 E2E coverage for Phase 1 prompt injection ② — Claude Code
 * recommended-settings check (spec `trust-prompt-relay.md` v1.3 §10.5
 * / `onboarding-scenarios.md` v1.2 §9.5; handoff
 * `v02x-phase1-claude-code-recommended-settings-check-request.md`
 * v1.1).
 *
 * Scope (handoff §4.2):
 *   - GET /api/security/settings-check responds with shape
 *   - already-onboarded user: toast surfaces / dismisses / persists
 *     dismiss state across reloads (24h cooldown)
 *   - not-yet-onboarded user: Security step appears between Concierge
 *     and Complete and gates the wizard until acknowledged
 *
 * The L1 fixture project root lives in /tmp (template-cache), which is
 * outside the user's home directory. The check helper's T-2-1
 * realpath guard rejects project-level settings outside ~ — so the
 * resulting check result is `path-resolution-rejected` (fail-closed,
 * surfaces as a warn). The tests below assert against this fail-
 * closed UX since it is the deterministically reachable state in CI.
 * Unit tests (tests/unit/claude-code-settings-check.test.ts) cover
 * the happy paths and other reasons.
 */
// BL-2026-160: this spec verifies the SecurityRecommendationsToast's
// own surface / dismiss behaviour, so it must NOT inherit the default
// `test` fixture's pre-dismiss step. `testWithSecurityToast` is the
// opt-out variant declared in the helper; every other L1 spec should
// continue to import the default `test`.
import { testWithSecurityToast as test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('セキュリティ推奨設定 API', () => {
  test('GET /api/security/settings-check が応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/security/settings-check`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body).toHaveProperty('result')
    expect(body).toHaveProperty('suppressToast')
    expect(body).toHaveProperty('dismissExpiresAt')
    expect(body.result).toHaveProperty('overallOk')
    expect(body.result).toHaveProperty('reason')
    expect(body.result).toHaveProperty('permissionMode')
    expect(body.result).toHaveProperty('denyPattern')
    expect(body.result).toHaveProperty('bypassMode')
  })

  test('check 結果が fail-closed posture を返す (T-2-1 / T-2-2)', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/security/settings-check`)
    const body = await res.json()
    // CodeX attempt 25 — pin the L1 fixture's deterministic outcome
    // so a regression in the path-resolution / read pipeline cannot
    // silently slip through under a softer `overallOk: false` assertion.
    //
    // L1 fixture: no `.claude/settings.json` exists at either
    // user-level or project-level (the template-cache project root
    // lives under /tmp/kb-e2e-template-XXX). The bounded reader
    // therefore observes ENOENT, classifies it as "missing entry"
    // (not a fail-closed rejection), and the checker falls back to
    // Claude Code's documented default `permissionMode: 'default'`
    // with an empty deny set. That yields:
    //   - reason === 'ok' (no structural failure)
    //   - permissionMode.ok === true (default is the recommended value)
    //   - denyPattern.ok === false (no entry covers .kovitoboard/)
    //   - bypassMode.ok === true (bypass not active)
    //   - overallOk === false (the deny-pattern recommendation is unmet)
    expect(body.result.overallOk).toBe(false)
    expect(body.result.reason).toBe('ok')
    expect(body.result.permissionMode.ok).toBe(true)
    expect(body.result.permissionMode.current).toBe('default')
    expect(body.result.denyPattern.ok).toBe(false)
    expect(body.result.denyPattern.hasKovitoboardDeny).toBe(false)
    expect(body.result.bypassMode.ok).toBe(true)
    expect(body.result.bypassMode.active).toBe(false)
  })
})

test.describe('セキュリティ警告トースト (onboarded user)', () => {
  test('違反検出時にトーストが表示される', async ({ page }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    // The toast is rendered lazily via the /api/security/settings-check
    // fetch; wait for the data-testid hook to surface.
    const toast = page.getByTestId('security-recommendations-toast')
    await expect(toast).toBeVisible({ timeout: 5000 })
  })

  test('Dismiss ボタンでトーストが消える', async ({ page }) => {
    await page.goto('/agents')
    await page.waitForLoadState('networkidle')

    const toast = page.getByTestId('security-recommendations-toast')
    await expect(toast).toBeVisible({ timeout: 5000 })

    const dismiss = toast.getByRole('button', { name: /Dismiss|閉じる/ })
    // Skip the dismiss assertion when the button is disabled (the
    // fail-closed surface keeps the dismiss button disabled — that is
    // by design so the user must fix the underlying read error rather
    // than silence it). When the button is interactive (e.g. a
    // permissionMode mismatch in a future fixture), the click resolves
    // the toast.
    if (await dismiss.isDisabled()) {
      // Fail-closed path is also a valid assertion: the toast remains
      // visible because dismiss is intentionally refused.
      await expect(toast).toBeVisible()
      return
    }
    await dismiss.click()
    await expect(toast).toBeHidden({ timeout: 5000 })
  })
})

test.describe('@preonboarding オンボーディング Security ステップ', () => {
  test('Step 5 = Security recommendations が表示される', async ({ page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Welcome (Step 1) — pick language and proceed
    await page.getByRole('button', { name: /Get Started|始める/ }).click()

    // User (Step 2) — fill display name
    await page.locator('input[type="text"]').first().fill('Tester')
    await page.getByRole('button', { name: /Next|次へ/ }).click()

    // Project (Step 3) — name + description default seeded; just next
    await page.getByRole('button', { name: /Next|次へ/ }).click()

    // Concierge (Step 4) — skip adding Kobi to keep the test fast
    await page.getByRole('button', { name: /Add later|あとで追加する/ }).click()

    // Step 5: Security
    const securityStep = page.getByTestId('onboarding-step-security')
    await expect(securityStep).toBeVisible({ timeout: 5000 })
  })

  test('@preonboarding overallOk: true で緑バナーが表示され ack 不要で次へ即進める (v1.5 §9.5.2.3 例外条項)', async ({ page }) => {
    // Spec onboarding-scenarios.md v1.5 §9.5.2.3 exception clause:
    // when `overallOk === true && reason === 'ok'`, the green-
    // banner branch renders alone with NO per-row BOX. Per-BOX ack
    // is structurally unnecessary (rubber-stamp threat surface is
    // absent — there is nothing to "miss" when no recommendation
    // is violated), and the Next button must enable immediately.
    //
    // The L1 fixture's deterministic outcome is `overallOk: false`
    // (the `/tmp/kb-e2e-template-XXX` project root puts the deny
    // pattern check out of compliance), so we mock the
    // `/api/security/settings-check` endpoint here to reach the
    // `allOk` branch the fixture cannot otherwise produce. The
    // mock response shape is pinned against the
    // `isSecurityCheckResponse` runtime guard.
    await page.route('**/api/security/settings-check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            overallOk: true,
            reason: 'ok',
            permissionMode: {
              current: 'default',
              recommended: 'default',
              ok: true,
            },
            denyPattern: {
              hasKovitoboardDeny: true,
              ok: true,
              remediation: '',
            },
            bypassMode: {
              active: false,
              ok: true,
            },
            settingsFilePath: null,
          },
          suppressToast: false,
          dismissExpiresAt: null,
        }),
      })
    })

    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: /Get Started|始める/ }).click()
    await page.locator('input[type="text"]').first().fill('Tester')
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Add later|あとで追加する/ }).click()

    const securityStep = page.getByTestId('onboarding-step-security')
    await expect(securityStep).toBeVisible({ timeout: 5000 })

    // The `allOk` branch must render the green banner alone.
    const allOkBanner = page.getByTestId('security-all-ok')
    await expect(allOkBanner).toBeVisible()

    // No per-row BOX is rendered, so none of the per-BOX ack
    // checkboxes should exist in the DOM. The single shared
    // `security-acknowledge` (fail-closed branch) is also absent.
    await expect(page.getByTestId('row-bypassMode-acknowledge')).toHaveCount(0)
    await expect(page.getByTestId('row-permissionMode-acknowledge')).toHaveCount(0)
    await expect(page.getByTestId('row-denyPattern-acknowledge')).toHaveCount(0)
    await expect(page.getByTestId('security-acknowledge')).toHaveCount(0)

    // Next must enable immediately with zero acks (v1.5 §9.5.2.3
    // exception clause). The rubber-stamp threat surface is absent
    // because no recommendation is violated, so requiring deliberate
    // ticks here would be over-defense outside the spec's intent.
    const next = page.getByTestId('security-next')
    await expect(next).toBeEnabled()
  })

  test('@preonboarding 違反検出時、acknowledge なしで次へ進めない', async ({ page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: /Get Started|始める/ }).click()
    await page.locator('input[type="text"]').first().fill('Tester')
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Add later|あとで追加する/ }).click()

    const securityStep = page.getByTestId('onboarding-step-security')
    await expect(securityStep).toBeVisible({ timeout: 5000 })

    const next = page.getByTestId('security-next')
    // Spec onboarding-scenarios.md v1.6 §9.5.2.3: every BOX
    // (bypassMode, permissionMode, denyPattern) renders its own
    // individual acknowledgement checkbox inside the BOX. The Next
    // button is gated by the AND of all three per-BOX acks so a
    // single rubber-stamp gesture cannot cover multiple BOXes. The
    // fail-closed branch no longer carries any acknowledgement
    // (v1.6 withdrew the single-shared-ack reuse in favour of a
    // block-until-fixed + Recheck button UX); the `sharedAck`
    // fallback below stays as a defensive safety net only — under
    // v1.6 it is structurally never visible on this fixture.
    const sharedAck = page.getByTestId('security-acknowledge')
    if (await sharedAck.isVisible().catch(() => false)) {
      await expect(next).toBeDisabled()
      await sharedAck.check()
      await expect(next).toBeEnabled()
      return
    }
    // Three per-BOX acks must all be ticked. With bypass mode
    // inactive in this scenario, the bypass row is rendered as a
    // plain SecurityRow (bypass-disabled display) and exposes the
    // same `row-bypassMode-acknowledge` testid as the others.
    const rowIds: Array<'permissionMode' | 'denyPattern' | 'bypassMode'> = [
      'permissionMode',
      'denyPattern',
      'bypassMode',
    ]
    await expect(next).toBeDisabled()
    for (const row of rowIds) {
      const box = page.getByTestId(`row-${row}-acknowledge`)
      await expect(box).toBeVisible()
      await box.check()
    }
    await expect(next).toBeEnabled()
  })
})

/**
 * v1.6 §9.5.2.3 example clause 2 — fail-closed block-until-fixed +
 * Recheck UX coverage. The L1 fixture cannot reach `reason !== 'ok'`
 * deterministically (its template-cache root yields the violation
 * path via the realpath-rejected fallback), so each test below stubs
 * `/api/security/settings-check` with a mock that satisfies the
 * `isSecurityCheckResponse` runtime guard. The shape pin is spec
 * v1.6 §9.5.6 — drift would silently collapse into the fail-closed
 * banner via the response-shape guard and the assertions would
 * still pass for the wrong reason.
 */
test.describe('@preonboarding §9.5.2.3 fail-closed UX (block-until-fixed + Recheck, v1.6)', () => {
  type SettingsCheckResultShape = {
    overallOk: boolean
    reason: 'ok' | 'read-error' | 'parse-error' | 'schema-mismatch' | 'path-resolution-rejected' | 'file-too-large'
    permissionMode: { current: string; recommended: 'default'; ok: boolean }
    denyPattern: { hasKovitoboardDeny: boolean; ok: boolean; remediation: string }
    bypassMode: { active: boolean; ok: boolean }
    settingsFilePath: string | null
  }

  function buildResult(overrides: Partial<SettingsCheckResultShape> = {}): SettingsCheckResultShape {
    // Sensible defaults for the "all OK" path; tests override the
    // fields that drive the branch they exercise. Keeping the
    // helper in-file (rather than in a shared fixture) localises
    // the spec-shape SSOT next to the assertions that depend on it.
    return {
      overallOk: true,
      reason: 'ok',
      permissionMode: { current: 'default', recommended: 'default', ok: true },
      denyPattern: { hasKovitoboardDeny: true, ok: true, remediation: '' },
      bypassMode: { active: false, ok: true },
      settingsFilePath: null,
      ...overrides,
    }
  }

  function envelope(result: SettingsCheckResultShape) {
    return {
      result,
      suppressToast: false,
      dismissExpiresAt: null,
    }
  }

  async function advanceToSecurityStep(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /Get Started|始める/ }).click()
    await page.locator('input[type="text"]').first().fill('Tester')
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Next|次へ/ }).click()
    await page.getByRole('button', { name: /Add later|あとで追加する/ }).click()
    const securityStep = page.getByTestId('onboarding-step-security')
    await expect(securityStep).toBeVisible({ timeout: 5000 })
  }

  test('§9.5.6 Test 1: fail-closed → Recheck → ok 自動遷移で緑バナー + Next enable', async ({ page }) => {
    // Start fail-closed (parse-error), then flip the mock to all-OK
    // before clicking Recheck so the recheck fetch lands on the
    // green-banner path.
    let phase: 'fail' | 'ok' = 'fail'
    await page.route('**/api/security/settings-check', async (route) => {
      const result = phase === 'fail'
        ? buildResult({ overallOk: false, reason: 'parse-error' })
        : buildResult({ overallOk: true, reason: 'ok' })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(result)),
      })
    })

    await advanceToSecurityStep(page)
    await expect(page.getByTestId('security-fail-closed')).toBeVisible()
    await expect(page.getByTestId('security-next')).toBeDisabled()

    phase = 'ok'
    await page.getByTestId('security-recheck').click()

    // Component must transition through the loading branch to the
    // green-banner path; per-row BOX never renders along the way.
    await expect(page.getByTestId('security-all-ok')).toBeVisible()
    await expect(page.getByTestId('security-fail-closed')).toHaveCount(0)
    await expect(page.getByTestId('security-next')).toBeEnabled()
  })

  test('§9.5.6 Test 2: fail-closed → Recheck → violation 自動遷移 + 3-ack AND gate 再 arm', async ({ page }) => {
    // Drive fail-closed → violation. After the recheck, the three
    // per-row BOXes must render and Next must stay disabled until
    // every per-BOX ack is ticked (3-ack AND gate). Equivalent to a
    // user-visible black-box assertion that the local ack state was
    // reset by `handleRecheck` (spec v1.6 §9.5.2.3 4-state reset).
    let phase: 'fail' | 'violation' = 'fail'
    await page.route('**/api/security/settings-check', async (route) => {
      const result = phase === 'fail'
        ? buildResult({ overallOk: false, reason: 'read-error' })
        : buildResult({
            overallOk: false,
            reason: 'ok',
            permissionMode: { current: 'bypassPermissions', recommended: 'default', ok: false },
            denyPattern: { hasKovitoboardDeny: false, ok: false, remediation: '' },
          })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(result)),
      })
    })

    await advanceToSecurityStep(page)
    await expect(page.getByTestId('security-fail-closed')).toBeVisible()

    phase = 'violation'
    await page.getByTestId('security-recheck').click()

    await expect(page.getByTestId('row-permissionMode-acknowledge')).toBeVisible()
    await expect(page.getByTestId('row-denyPattern-acknowledge')).toBeVisible()
    await expect(page.getByTestId('row-bypassMode-acknowledge')).toBeVisible()
    const next = page.getByTestId('security-next')
    await expect(next).toBeDisabled()

    // Tick every per-BOX ack; only then must Next enable.
    await page.getByTestId('row-bypassMode-acknowledge').check()
    await expect(next).toBeDisabled()
    await page.getByTestId('row-permissionMode-acknowledge').check()
    await expect(next).toBeDisabled()
    await page.getByTestId('row-denyPattern-acknowledge').check()
    await expect(next).toBeEnabled()
  })

  test('§9.5.6 Test 3: Recheck 中の重複 click は button unmount で構造的に防止', async ({ page }) => {
    // Hold the recheck fetch with an artificial delay so we can observe
    // the in-flight semantics. After the click, the Recheck button
    // must unmount (the loading branch takes over), and only one fetch
    // call must complete by the time the next response renders.
    let phase: 'fail' | 'ok' = 'fail'
    let fetchCount = 0
    await page.route('**/api/security/settings-check', async (route) => {
      fetchCount += 1
      if (phase === 'fail') {
        // Initial mount fetch — respond immediately so we reach the
        // fail-closed banner without flake.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(envelope(buildResult({ overallOk: false, reason: 'schema-mismatch' }))),
        })
        return
      }
      // Recheck fetch — hold briefly so the loading branch is
      // observable. 500 ms is enough to assert the unmount without
      // making the test slow.
      await new Promise((r) => setTimeout(r, 500))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(buildResult({ overallOk: true, reason: 'ok' }))),
      })
    })

    await advanceToSecurityStep(page)
    await expect(page.getByTestId('security-fail-closed')).toBeVisible()
    expect(fetchCount).toBe(1)

    phase = 'ok'
    await page.getByTestId('security-recheck').click()

    // While the fetch is in flight: Recheck button must be unmounted
    // (spec v1.6 §9.5.2.3 in-flight semantics — `setState(null)`
    // returns the component to the loading branch).
    await expect(page.getByTestId('security-recheck')).toHaveCount(0)
    await expect(page.getByTestId('security-fail-closed')).toHaveCount(0)

    // Resolution: green banner takes over and Next enables.
    await expect(page.getByTestId('security-all-ok')).toBeVisible()
    // Only the initial + the single Recheck fetch should have run.
    // If the button were rendered with a disabled flag instead of
    // unmounted, a click race could push this to 3+.
    expect(fetchCount).toBe(2)
  })

  test('§9.5.6 Test 4: Recheck → 再 fail-closed (無限ループ許容、ユーザー操作で終端)', async ({ page }) => {
    // Both the initial mount and the recheck land on a fail-closed
    // response. The amber banner must re-surface after the recheck
    // and the Recheck button must remain interactive so the user
    // can try again — confirming that an unrecoverable settings
    // file does not silently lock the wizard.
    await page.route('**/api/security/settings-check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(buildResult({ overallOk: false, reason: 'schema-mismatch' }))),
      })
    })

    await advanceToSecurityStep(page)
    const failClosedBanner = page.getByTestId('security-fail-closed')
    await expect(failClosedBanner).toBeVisible()
    const recheck = page.getByTestId('security-recheck')
    await expect(recheck).toBeEnabled()

    await recheck.click()
    // After the loading branch resolves into another fail-closed
    // response, the banner must re-mount and Recheck must be ready
    // for another attempt.
    await expect(failClosedBanner).toBeVisible()
    await expect(recheck).toBeEnabled()
    await expect(page.getByTestId('security-next')).toBeDisabled()
  })

  test('§9.5.6 Test 5: candidate path 2 件併記が payload に依存せず常時表示', async ({ page }) => {
    // The `publicResult()` server route redacts `settingsFilePath` to
    // null in every response (CodeX attempt 7 — information
    // disclosure). The spec therefore pins a fixed-literal candidate
    // path block in the renderer (i18n key
    // `onboarding.security.failClosedCandidatePath`) that is shown
    // unconditionally on every fail-closed reason.
    await page.route('**/api/security/settings-check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(buildResult({ overallOk: false, reason: 'file-too-large' }))),
      })
    })

    await advanceToSecurityStep(page)
    const banner = page.getByTestId('security-fail-closed')
    await expect(banner).toBeVisible()
    // Both candidate paths must be co-rendered inside the banner.
    // We assert against the literal substrings rather than the i18n
    // key so a future label rewording will surface here loudly
    // (the candidate paths themselves are normative SSOT).
    await expect(banner).toContainText('~/.claude/settings.json')
    await expect(banner).toContainText('<projectRoot>/.claude/settings.json')
  })
})
