/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 coverage for the CLAUDE.md guidance-injection feature.
 *
 * Spec SSOT: `docs/specs/claude-md-guidance-injection.md` v1.2.
 *
 * Goal of this suite (rather than the full 7-target table in spec
 * §9.1): exercise the production trigger end to end. The fine-grained
 * branches (CRLF preservation, broken markers, marker variants) are
 * covered by `tests/unit/claude-md-guidance.test.ts` against a real
 * `DirectFsLayer`. Here we drive the full onboarding wizard so the
 * `PUT /api/config/setting` route, the `onboarding.completedAt`
 * transition detection, and the renderer opt-out checkbox are all
 * wired up correctly.
 *
 * The two scenarios are intentionally near-mirror images of one
 * another so any regression in either the renderer plumbing or the
 * route trigger surfaces here.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const GUIDANCE_START = '<!-- KB:GUIDANCE_START -->'
const GUIDANCE_END = '<!-- KB:GUIDANCE_END -->'

/** Common arrange step: clear any pre-existing CLAUDE.md so the test
 *  starts from the "file missing" branch (spec §5.4). The fixture
 *  snapshot/restore loop covers `.kovitoboard/`, but CLAUDE.md lives
 *  at the project root and is not part of that snapshot. */
function ensureNoClaudeMd(projectRoot: string): string {
  const path = join(projectRoot, 'CLAUDE.md')
  if (existsSync(path)) {
    rmSync(path, { force: true })
  }
  return path
}

/** Skip past the Security recommendations onboarding step (handoff
 *  v1.1 §3.4 / spec onboarding-scenarios v1.2 §9.5). The L1 fixture
 *  project root lives in /tmp so the check helper returns a fail-
 *  closed surface; check the acknowledge box when it surfaces, then
 *  proceed. */
async function skipSecurityStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
): Promise<void> {
  const securityStep = page.getByTestId('onboarding-step-security')
  await expect(securityStep).toBeVisible({ timeout: 5000 })
  // onboarding-scenarios.md v1.4 §9.5.2.3 — every BOX has its own
  // ack checkbox rendered unconditionally, and the Next button is
  // gated by the 3-ack AND. The shared `security-acknowledge` box
  // only shows up in the fail-closed banner branch.
  const sharedAck = page.getByTestId('security-acknowledge')
  if (await sharedAck.isVisible().catch(() => false)) {
    await sharedAck.check()
  }
  for (const row of ['permissionMode', 'denyPattern', 'bypassMode'] as const) {
    const box = page.getByTestId(`row-${row}-acknowledge`)
    if (await box.isVisible().catch(() => false)) {
      await box.check()
    }
  }
  await page.getByTestId('security-next').click()
}

test.describe('CLAUDE.md guidance injection — onboarding trigger @preonboarding', () => {
  test('writes the marker block to a fresh CLAUDE.md when the wizard completes', async ({ page, kbFixture }) => {
    const claudeMdPath = ensureNoClaudeMd(kbFixture.projectRoot)

    await page.goto('/')
    await page.waitForURL('**/onboarding', { timeout: 10_000 })

    // Step 1: Welcome
    await page.getByRole('button', { name: '日本語' }).click()
    await page.getByRole('button', { name: '始める' }).click()

    // Step 2: User
    await page.locator('#displayName').fill('テストユーザー')
    await page.getByRole('button', { name: '次へ' }).click()

    // Step 3: Project
    await page.locator('#projectName').fill('claude-md-guidance-test')
    await page.getByRole('button', { name: '次へ' }).click()

    // Step 4: Concierge — skip Kobi for a deterministic flow
    await page.getByRole('button', { name: 'あとで追加する' }).click()

    // Step 5: Security (handoff v1.1) — acknowledge when shown
    await skipSecurityStep(page)

    // Step 6: Complete — leave the opt-out checkbox unchecked, click
    // through. Verify the checkbox is rendered and checkable so the
    // i18n key + plumbing actually surfaced.
    const optOut = page.getByTestId('onboarding-skip-claude-md-guidance').locator('input[type="checkbox"]')
    await expect(optOut).toBeVisible()
    await expect(optOut).not.toBeChecked()
    await page.getByRole('button', { name: 'エージェント一覧へ' }).click()

    // Wait for the onboarding completion to land in setting.json. The
    // CLAUDE.md write happens on the same handler turn, so polling
    // the filesystem afterward is safe.
    await expect(async () => {
      const res = await page.request.get('/api/config/setting')
      expect(res.ok()).toBeTruthy()
      const body = await res.json() as {
        onboarding?: { completedAt?: string | null }
        claudeMdGuidance?: { lastInjectedAt?: string }
      } | null
      expect(body?.onboarding?.completedAt).toBeTruthy()
      // The route records `lastInjectedAt` only when the guidance was
      // actually written. Asserting it here closes the loop on the
      // server-side trigger.
      expect(body?.claudeMdGuidance?.lastInjectedAt).toBeTruthy()
    }).toPass({ timeout: 10_000 })

    // CLAUDE.md should now exist at projectRoot with the guidance
    // markers and the canonical agent-ref pointer.
    expect(existsSync(claudeMdPath)).toBe(true)
    const content = readFileSync(claudeMdPath, 'utf-8')
    expect(content).toContain(GUIDANCE_START)
    expect(content).toContain(GUIDANCE_END)
    expect(content).toContain('kovitoboard/docs/agent-ref/INDEX.md')
  })

  test('skips injection and persists disabled=true when the opt-out is checked', async ({ page, kbFixture }) => {
    const claudeMdPath = ensureNoClaudeMd(kbFixture.projectRoot)

    await page.goto('/')
    await page.waitForURL('**/onboarding', { timeout: 10_000 })

    await page.getByRole('button', { name: '日本語' }).click()
    await page.getByRole('button', { name: '始める' }).click()

    await page.locator('#displayName').fill('テストユーザー')
    await page.getByRole('button', { name: '次へ' }).click()

    await page.locator('#projectName').fill('claude-md-guidance-test')
    await page.getByRole('button', { name: '次へ' }).click()

    await page.getByRole('button', { name: 'あとで追加する' }).click()
    await skipSecurityStep(page)

    // Opt out of the guidance injection before completing. Use the
    // semantic role+name path so future i18n tweaks of the visible
    // label do not silently break the trigger plumbing.
    const optOut = page.getByTestId('onboarding-skip-claude-md-guidance').locator('input[type="checkbox"]')
    await expect(optOut).toBeVisible()
    await optOut.check()
    await expect(optOut).toBeChecked()

    await page.getByRole('button', { name: 'エージェント一覧へ' }).click()

    await expect(async () => {
      const res = await page.request.get('/api/config/setting')
      expect(res.ok()).toBeTruthy()
      const body = await res.json() as {
        onboarding?: { completedAt?: string | null }
        claudeMdGuidance?: { disabled?: boolean; lastInjectedAt?: string }
      } | null
      expect(body?.onboarding?.completedAt).toBeTruthy()
      expect(body?.claudeMdGuidance?.disabled).toBe(true)
      // No injection happened, so `lastInjectedAt` must remain unset.
      expect(body?.claudeMdGuidance?.lastInjectedAt).toBeUndefined()
    }).toPass({ timeout: 10_000 })

    expect(existsSync(claudeMdPath)).toBe(false)
  })

  test('preserves server-managed claudeMdGuidance fields across an unrelated full-document PUT', async ({ page, kbFixture }) => {
    // Spec hardening (CodeX review on PR #19, findings
    // "server-managed field integrity" + "preference clobbering"):
    // PUT /api/config/setting is a full-document write, so without
    // server-side merge-back any later unrelated update would erase:
    //   (a) the server-managed `lastInjectedAt` audit field
    //       recorded by a previous injection, and
    //   (b) an already-persisted `disabled = true` opt-out (when
    //       the new body omits `claudeMdGuidance` entirely).
    //
    // This test drives the production wizard once to produce the
    // initial state, then issues a second PUT that simulates an
    // unrelated client (e.g. a profile-name change) which does NOT
    // include `claudeMdGuidance` in its body. The persisted
    // `lastInjectedAt` must survive.
    const claudeMdPath = ensureNoClaudeMd(kbFixture.projectRoot)

    await page.goto('/')
    await page.waitForURL('**/onboarding', { timeout: 10_000 })

    await page.getByRole('button', { name: '日本語' }).click()
    await page.getByRole('button', { name: '始める' }).click()
    await page.locator('#displayName').fill('テストユーザー')
    await page.getByRole('button', { name: '次へ' }).click()
    await page.locator('#projectName').fill('claude-md-guidance-test')
    await page.getByRole('button', { name: '次へ' }).click()
    await page.getByRole('button', { name: 'あとで追加する' }).click()
    await skipSecurityStep(page)
    await page.getByRole('button', { name: 'エージェント一覧へ' }).click()

    // Capture the post-onboarding state so we know what
    // `lastInjectedAt` to assert against later.
    let recordedTimestamp: string | undefined
    await expect(async () => {
      const res = await page.request.get('/api/config/setting')
      expect(res.ok()).toBeTruthy()
      const body = await res.json() as {
        onboarding?: { completedAt?: string | null }
        claudeMdGuidance?: { lastInjectedAt?: string }
      } | null
      expect(body?.claudeMdGuidance?.lastInjectedAt).toBeTruthy()
      recordedTimestamp = body?.claudeMdGuidance?.lastInjectedAt
    }).toPass({ timeout: 10_000 })
    expect(existsSync(claudeMdPath)).toBe(true)
    expect(recordedTimestamp).toBeTruthy()

    // Now issue an unrelated full-document PUT that intentionally
    // omits `claudeMdGuidance` (the wizard does this when the
    // opt-out checkbox is left unchecked). Without server-side
    // merge-back, this would erase the previously recorded
    // `lastInjectedAt` from disk.
    const currentRes = await page.request.get('/api/config/setting')
    const current = await currentRes.json() as Record<string, unknown> & {
      user: { displayName: string }
      claudeMdGuidance?: { disabled?: boolean; lastInjectedAt?: string }
    }
    const unrelatedBody: Record<string, unknown> = {
      ...current,
      user: { ...current.user, displayName: 'updated-display-name' },
    }
    delete unrelatedBody.claudeMdGuidance

    const putRes = await page.request.put('/api/config/setting', {
      data: unrelatedBody,
      headers: { 'Content-Type': 'application/json' },
    })
    expect(putRes.ok()).toBeTruthy()

    // The persisted `lastInjectedAt` must still match the value
    // recorded after onboarding — proof that the server merged the
    // server-managed claudeMdGuidance fields back into the document.
    const afterRes = await page.request.get('/api/config/setting')
    const after = await afterRes.json() as {
      user: { displayName: string }
      claudeMdGuidance?: { disabled?: boolean; lastInjectedAt?: string }
    }
    expect(after.user.displayName).toBe('updated-display-name')
    expect(after.claudeMdGuidance?.lastInjectedAt).toBe(recordedTimestamp)
  })
})
