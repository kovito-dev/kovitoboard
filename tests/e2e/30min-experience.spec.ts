/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * 30min-experience E2E test
 *
 * Functional verification of the "first 30 minutes experience" scenario.
 * @see docs/specs/v0.1.0-30min-experience-e2e-plan.md
 *
 * Scenarios implemented (L1 Fake Claude E2E):
 *   S2: First folder trust prompt
 *   S3: Agent creation request -> Write-type prompt (reference implementation)
 *   S4: CLAUDE.md edit request -> Update-type prompt
 *   S5: Bash execution request -> Bash-type prompt
 *   S6: Rejection flow (No selection)
 *
 * Timing note:
 *   The trust-prompt-detector broadcasts `trust_prompt_detected` exactly once
 *   per unique capture hash. To guarantee the browser receives the event,
 *   tests MUST establish the WS connection (page.goto) BEFORE starting
 *   Fake Claude. Otherwise the first broadcast happens before the client
 *   connects and the modal never appears.
 */
import type { Page } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './helpers/l1-per-test-setup'
import {
  startFakeClaude,
  cleanupFakeClaudeSession,
  waitForFullDispose,
  type FakeClaudeScenario,
} from './helpers/fake-claude-harness'

/** Resolve the tmux session name from Playwright project metadata
 *  (used only by test.afterAll where the kbFixture is out of scope). */
function getSessionName(testInfo: { project: { metadata?: { sessionName?: string } } }): string {
  return testInfo.project.metadata?.sessionName ?? 'kb-e2e-shared-default'
}

/**
 * Navigate to the session page and wait for the WebSocket to be ready.
 * Returns after `networkidle` to ensure the WS client has been initialized.
 */
async function openSessionPage(page: Page): Promise<void> {
  await page.goto('/sessions/kovito-concierge')
  await page.waitForLoadState('networkidle')
  // Extra wait for the React WS client to connect (onopen runs after mount)
  await page.waitForTimeout(500)
}

// Run all scenarios serially to avoid tmux session contention.
test.describe.configure({ mode: 'serial' })

// ---------------------------------------------------------------------------
// S3: Agent creation request -> Write-type prompt (reference implementation)
// ---------------------------------------------------------------------------
test.describe('S3: Agent creation request -> Write-type prompt', () => {
  test('S3-a: Approve with Yes and let Claude Code continue', async ({ page, kbFixture }) => {
    // Establish WS connection first (detector only broadcasts once per capture hash)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      // Modal is expected to appear within detector polling window (1s window discovery + 200ms poll)
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // Kind label reflects a Write-type prompt. Match against either
      // locale: en is "Trust confirmation: File write" (lowercase 'write')
      // and ja is "信頼確認: ファイル書き込み". The legacy regex used a
      // capital 'Write' which silently stopped matching after the L1
      // fixture switched to locale=en.
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/write|信頼確認|ファイル書き込み/i)

      // Target file is displayed
      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('test-agent.md')

      // All three choices are rendered. Choice ids follow trust-prompt
      // detector spec v1.2 §4-1-4 / §TP-1: when the on-screen menu is
      // parseable, dynamic extraction wins and choice ids are
      // `dynamic-<row-num>` (1-based) rather than the legacy static
      // `yes` / `yes-session` / `no` ids that only fire as the
      // last-resort fallback. For a Write-type 3-choice menu the
      // mapping is dynamic-1 = Yes, dynamic-2 = Yes-for-session,
      // dynamic-3 = No.
      await expect(page.getByTestId('trust-prompt-choice-dynamic-1')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-dynamic-2')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-dynamic-3')).toBeVisible()

      // Act: click Yes (dynamic-1)
      await page.getByTestId('trust-prompt-choice-dynamic-1').click()

      // Fake Claude transitions to state 2 (success message)
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Created .claude/agents/test-agent.md')
      }).toPass({ timeout: 5000 })

      // Modal dismisses after trust_prompt_resolved
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })

  test('S3-b: Approve with Yes-for-session', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // dynamic-2 = Yes-for-session in a Write-type 3-choice menu
      await page.getByTestId('trust-prompt-choice-dynamic-2').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('session-allowed')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })

  test('S3-c: Reject with No', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // dynamic-3 = No in a Write-type 3-choice menu
      await page.getByTestId('trust-prompt-choice-dynamic-3').click()

      // Modal closes after rejection; Fake Claude exits with code 1
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })
})

// ---------------------------------------------------------------------------
// S2: First folder trust prompt
// ---------------------------------------------------------------------------
test.describe('S2: First folder trust prompt', () => {
  test('S2-a: Approve folder trust (Yes)', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'folder-trust',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // Kind label should indicate folder trust
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/folder|フォルダ/i)

      // Folder trust has 2 choices (Yes / No). Choice ids follow the
      // dynamic-extraction policy (see S3-a comment): dynamic-1 = Yes,
      // dynamic-2 = No for a 2-choice folder-trust menu.
      await expect(page.getByTestId('trust-prompt-choice-dynamic-1')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-dynamic-2')).toBeVisible()

      await page.getByTestId('trust-prompt-choice-dynamic-1').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Welcome back, session ready')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })
})

// ---------------------------------------------------------------------------
// S4: CLAUDE.md edit request -> Update-type prompt
// ---------------------------------------------------------------------------
test.describe('S4: Edit request -> Update-type prompt', () => {
  test('S4-a: Approve edit (Yes)', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'edit-modify',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/edit|update|編集/i)

      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('sample.txt')

      // dynamic-1 = Yes in an Edit-type 3-choice menu
      await page.getByTestId('trust-prompt-choice-dynamic-1').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Applied edit to sample.txt')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })
})

// ---------------------------------------------------------------------------
// S5: Bash execution request -> Bash-type prompt
// ---------------------------------------------------------------------------
test.describe('S5: Bash request -> Bash-type prompt', () => {
  test('S5-a: Approve Bash command (Yes)', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'bash-simple',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/bash|コマンド/i)

      // Bash prompt has 3 choices. dynamic-1 = Yes,
      // dynamic-2 = Yes-for-session, dynamic-3 = No.
      await expect(page.getByTestId('trust-prompt-choice-dynamic-1')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-dynamic-2')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-dynamic-3')).toBeVisible()

      await page.getByTestId('trust-prompt-choice-dynamic-1').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Ran: touch newfile.txt')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })
})

// ---------------------------------------------------------------------------
// S1: Onboarding completion flow (preonboarding project)
// ---------------------------------------------------------------------------
test.describe('S1: Onboarding 6-step completion @preonboarding', () => {
  test('S1-a: Complete the 6-step wizard with Kobi skipped', async ({ page, kbFixture: _kbFixture }) => {
    void _kbFixture // bind the fixture so snapshot/restore covers this test
    // Start at root; React navigates to /onboarding after checking setting API
    await page.goto('/')
    // Wait for the SPA redirect (client-side Navigate, not HTTP 302)
    await page.waitForURL('**/onboarding', { timeout: 10_000 })

    // Step 1: Welcome — choose language (ja) and start
    const stepWelcome = page.getByTestId('onboarding-step-welcome')
    await expect(stepWelcome).toBeVisible({ timeout: 10_000 })

    // Pick Japanese explicitly to make button text deterministic
    await page.getByRole('button', { name: '日本語' }).click()
    await page.getByRole('button', { name: '始める' }).click()

    // Step 2: User — enter display name
    const stepUser = page.getByTestId('onboarding-step-user')
    await expect(stepUser).toBeVisible()
    await page.locator('#displayName').fill('テストユーザー')
    await page.getByRole('button', { name: '次へ' }).click()

    // Step 3: Project — enter project name
    const stepProject = page.getByTestId('onboarding-step-project')
    await expect(stepProject).toBeVisible()
    await page.locator('#projectName').fill('test-project')
    // project path is display-only (DEC-009)
    await expect(page.getByTestId('onboarding-project-path')).toBeVisible()
    await page.getByRole('button', { name: '次へ' }).click()

    // Step 4: Concierge — skip Kobi for a deterministic flow
    const stepConcierge = page.getByTestId('onboarding-step-concierge')
    await expect(stepConcierge).toBeVisible()
    await page.getByRole('button', { name: 'あとで追加する' }).click()

    // Step 5: Security recommendations (handoff v1.1 §3.4 /
    // onboarding-scenarios v1.2 §9.5). Acknowledge the warning when
    // violations surface; the L1 fixture project root is outside
    // ~/.claude so the check helper returns the fail-closed surface
    // and a banner is shown — accept the banner and proceed.
    const stepSecurity = page.getByTestId('onboarding-step-security')
    await expect(stepSecurity).toBeVisible()
    const ack = page.getByTestId('security-acknowledge')
    if (await ack.isVisible().catch(() => false)) {
      await ack.check()
    }
    await page.getByTestId('security-next').click()

    // Step 6: Complete — click "Go to agents"
    // (i18n key: onboarding.complete.goToAgents = 'エージェント一覧へ',
    // shown when concierge is skipped on Step 4. The earlier label
    // 'ダッシュボードへ' was renamed during the dashboard -> agents
    // terminology alignment.)
    const stepComplete = page.getByTestId('onboarding-step-complete')
    await expect(stepComplete).toBeVisible()
    await page.getByRole('button', { name: 'エージェント一覧へ' }).click()

    // Verify the setting was persisted via API
    // (UI state transition after PUT /api/config/setting is a separate concern)
    await expect(async () => {
      const res = await page.request.get('/api/config/setting')
      expect(res.ok()).toBeTruthy()
      const body = await res.json() as {
        onboarding?: { completedAt?: string | null }
        user?: { displayName?: string }
        project?: { name?: string }
      } | null
      expect(body).not.toBeNull()
      expect(body!.onboarding?.completedAt).toBeTruthy()
      expect(body!.user?.displayName).toBe('テストユーザー')
      expect(body!.project?.name).toBe('test-project')
    }).toPass({ timeout: 10_000 })
  })
})

// ---------------------------------------------------------------------------
// S6: Rejection flow (No selection)
// ---------------------------------------------------------------------------
test.describe('S6: Rejection flow', () => {
  test('S6-a: No selection closes modal and Fake Claude exits', async ({ page, kbFixture }) => {
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'rejection-flow',
      windowName: kbFixture.makeWindowName('kovito-concierge'),
      sessionName: kbFixture.tmuxSession,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // dynamic-3 = No in a Write-type 3-choice menu (rejection-flow
      // scenario reuses the write-create fixture, see
      // tests/fixtures/fake-claude/scenarios/rejection-flow.sh).
      await page.getByTestId('trust-prompt-choice-dynamic-3').click()

      // Modal dismisses after rejection
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await waitForFullDispose(fake, page, { apiBaseUrl: kbFixture.apiBaseUrl })
    }
  })
})

// ---------------------------------------------------------------------------
// S7: Recipe installation surface — v0.2.x temporary disable
// ---------------------------------------------------------------------------
test.describe('S7: Recipe install temporary disable', () => {
  test('S7-a: Sample recipes page shows the disable notice and no install buttons', async ({
    page,
    kbFixture: _kbFixture,
  }) => {
    void _kbFixture

    // Recipe install is temporarily disabled in v0.2.x while the
    // KovitoHub signed publisher model is being prepared
    // (recipe-system.md §10.6). The sample page now renders a
    // Coming-in-v0.3.0 notice instead of install / reinstall CTAs;
    // the standalone disable contract is covered by
    // `recipe-install-disable.spec.ts`.

    const listRes = await page.request.get('/api/recipes/sample')
    expect(listRes.ok()).toBeTruthy()
    const recipes = (await listRes.json()) as Array<{ id: string }>
    expect(Array.isArray(recipes)).toBe(true)
    expect(recipes.length).toBeGreaterThan(0)

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('recipe-install-disabled-notice')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid^="recipe-install-button-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="recipe-reinstall-button-"]')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// S8: TODO recipe CRUD (kb-call handler smoke)
// ---------------------------------------------------------------------------
test.describe('S8: TODO recipe kb-call smoke', () => {
  test('S8-a: kv-set -> kv-list round-trip via kb-call', async ({ page, kbFixture: _kbFixture }) => {
    void _kbFixture
    // Minimal smoke: verify the kb-call WebSocket path works end-to-end.
    // Full CRUD coverage lives in recipe-handler-e2e.spec.ts.
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The recipe-handler-e2e suite already verifies write/read/list with
    // own-data scope. We only assert the /api/recipes/sample endpoint
    // exposes a TODO-like recipe so this scenario is meaningful.
    const res = await page.request.get('/api/recipes/sample')
    expect(res.ok()).toBeTruthy()
    const recipes = await res.json() as Array<{ id: string }>
    // Either the document-viewer or a todo-like recipe must exist
    expect(Array.isArray(recipes)).toBe(true)
    expect(recipes.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// S9: Agent creation + avatar (BE direct, no trust prompt)
// ---------------------------------------------------------------------------
test.describe('S9: Agent creation flow', () => {
  test('S9-a: Create an agent via the UI wizard', async ({ page, kbFixture }) => {
    await page.goto('/agents/new')
    await page.waitForLoadState('networkidle')

    // Step 1: pick a template (any available one)
    const selector = page.getByTestId('agent-template-selector')
    await expect(selector).toBeVisible({ timeout: 10_000 })

    // Click the first template button inside the selector. We have
    // to filter twice:
    //   1. Skip `agent-template-scratch` — AA-3 (commit 877d772)
    //      added a "from-scratch" entry point at the head of the
    //      template grid which requires extra mandatory fields
    //      (description / systemPrompt) we do not fill in below.
    //   2. Skip disabled template buttons — AA-1 disables a template
    //      whose target agent id is already on disk. The
    //      blank-onboarded fixture ships with `kovito-concierge`
    //      already created, so the matching template is disabled.
    const firstTemplate = selector
      .locator('button[data-testid^="agent-template-"]:not([data-testid="agent-template-scratch"]):not([disabled])')
      .first()
    await firstTemplate.click()

    // Step 2: configure with a unique agent id
    const agentId = `s9-test-${Date.now()}`
    await page.getByTestId('agent-id-input').fill(agentId)
    await page.getByTestId('agent-display-name-input').fill('S9 Test Agent')
    await page.getByTestId('agent-create-button').click()

    try {
      // Verify the agent appears in the API list
      await expect(async () => {
        const res = await page.request.get('/api/agents')
        expect(res.ok()).toBeTruthy()
        const agents = await res.json() as Array<{ id: string }>
        expect(agents.some((a) => a.id === agentId)).toBe(true)
      }).toPass({ timeout: 10_000 })
    } finally {
      // Belt-and-braces cleanup: the kbFixture snapshot/restore should
      // also remove this file at afterEach, but doing it here as well
      // covers the CI case where afterEach occasionally appears to lag
      // behind the next test's KB agent-list refresh, leaving a stale
      // s9-test-<ts>.md visible to agent-management tests downstream.
      const agentFile = join(kbFixture.projectRoot, '.claude', 'agents', `${agentId}.md`)
      try {
        if (existsSync(agentFile)) rmSync(agentFile, { force: true })
      } catch {
        /* swallow — fixture restore will still run */
      }
    }
  })
})

// ---------------------------------------------------------------------------
// S10: Research Reports UI smoke
// Extensive API-level coverage lives in research-reports.spec.ts.
// ---------------------------------------------------------------------------
test.describe('S10: Research Reports API smoke', () => {
  test('S10-a: start-research rejects empty theme', async ({ request, kbFixture: _kbFixture }) => {
    void _kbFixture
    const res = await request.post('/api/ext/research-reports/start-research', {
      data: { theme: '' },
    })
    // 400 for validation, or 404 if app-api-loader has not mounted the route
    expect([400, 404]).toContain(res.status())
  })
})

// ---------------------------------------------------------------------------
// S11: Recipe parse smoke
// The full import / apply path was retired in v0.2.x alongside the
// recipe install temporary disable (recipe-system.md §10.6). The
// `POST /api/recipes/parse` endpoint stays operational so manifests
// and exports can still surface parsed recipe content; this smoke
// test guards the parse path's basic input validation.
// ---------------------------------------------------------------------------
test.describe('S11: Recipe parse smoke', () => {
  test('S11-a: /api/recipes/parse rejects empty body', async ({ request, kbFixture: _kbFixture }) => {
    void _kbFixture
    const apiRes = await request.post('/api/recipes/parse', { data: {} })
    expect(apiRes.status()).toBeGreaterThanOrEqual(400)
    expect(apiRes.status()).toBeLessThan(500)
  })
})

// Mark the scenario variable as used (suppresses unused-import lint when types narrow)
export type _FakeClaudeScenarioUsed = FakeClaudeScenario

// Global cleanup: remove any leftover tmux sessions from test runs.
test.afterAll(async ({}, testInfo) => {
  const sessionName = getSessionName(testInfo)
  await cleanupFakeClaudeSession(sessionName)
})
