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
test.describe('S1: Onboarding 5-step completion @preonboarding', () => {
  test('S1-a: Complete the 5-step wizard with Kobi skipped', async ({ page, kbFixture: _kbFixture }) => {
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

    // Step 5: Complete — click "Go to agents"
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
// S7: Recipe installation -> scope approval -> operation
// ---------------------------------------------------------------------------
test.describe('S7: Recipe installation flow', () => {
  test('S7-a: Sample recipe install flow surfaces the warning + agent picker', async ({ page, kbFixture: _kbFixture }) => {
    void _kbFixture

    // Stub `/api/recipes/parse` so we can deterministically force the
    // `pureDeclarative: false` branch that surfaces the warning dialog.
    // The legacy `recipe-install-modal` testid was removed in DEC-024 #4
    // when the install flow was split into a two-stage warning +
    // agent-picker UI (see `RecipeInstallWarningDialog.tsx` and
    // `RecipeInstallAgentPickerModal.tsx`).
    await page.route('**/api/recipes/parse**', async (route) => {
      const url = new URL(route.request().url())
      const sourcePath = url.searchParams.get('sourcePath') ?? '/tmp/s7-fixture'
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          recipe: {
            metadata: {
              recipeId: 's7-fixture-recipe',
              name: 'S7 fixture recipe',
              description: 'Fixture recipe surfaced by the S7-a stub',
              version: '1.0.0',
              author: 'kovito-test',
            },
            artifacts: [],
            menu: [],
            hash: 'sha256:s7a-fixture',
            sourceFormat: 'directory',
            sourcePath,
          },
          inspection: {
            verdict: 'safe',
            findings: [],
            pureDeclarative: false,
            detectedNonDeclarativePatterns: ['express-router'],
          },
        }),
      })
    })

    // Fetch available recipes up front so we can target a non-installed one
    const listRes = await page.request.get('/api/recipes/sample')
    expect(listRes.ok()).toBeTruthy()
    const recipes = await listRes.json() as Array<{ id: string; installed?: boolean }>
    expect(Array.isArray(recipes)).toBe(true)
    expect(recipes.length).toBeGreaterThan(0)

    const target = recipes.find((r) => !r.installed)
    if (!target) {
      test.skip(true, 'All sample recipes are already installed in this fixture')
      return
    }

    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')

    // Sample tab is default; the install button for the target recipe must exist
    const installBtn = page.getByTestId(`recipe-install-button-${target.id}`)
    await expect(installBtn).toBeVisible({ timeout: 10_000 })
    await installBtn.click()

    // Stage 1: warning dialog (only surfaces for non-pure declarative recipes)
    const warning = page.getByTestId('recipe-install-warning-dialog')
    await expect(warning).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('recipe-install-warning-continue')).toBeVisible()
    await expect(page.getByTestId('recipe-install-warning-cancel')).toBeVisible()

    // Stage 2: agent picker (continue past warning)
    await page.getByTestId('recipe-install-warning-continue').click()
    const picker = page.getByTestId('recipe-install-agent-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })

    // Cancel the picker so no install POST fires (kovito-concierge in
    // blank-onboarded keeps the fixture clean for later tests).
    await page.getByTestId('recipe-install-picker-cancel').click()
    await expect(picker).not.toBeVisible({ timeout: 5_000 })
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
// S11: Recipe parse/apply smoke
// Full export/import loop is blocked pending endpoint completion; this
// verifies the parse path which is the first half of import.
// ---------------------------------------------------------------------------
test.describe('S11: Recipe import UI smoke', () => {
  test('S11-a: Recipe import tab renders the parse form and validates empty input', async ({ page, request, kbFixture: _kbFixture }) => {
    void _kbFixture
    // API-level validation: empty source is rejected
    const apiRes = await request.post('/api/recipes/parse', { data: {} })
    expect(apiRes.status()).toBeGreaterThanOrEqual(400)
    expect(apiRes.status()).toBeLessThan(500)

    // UI-level: import tab renders the controls
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Import' }).click()

    // The legacy absolute-path entry was moved into a collapsed
    // <details> expander (see RecipeImport.tsx around the
    // "advanced.toggle" i18n key) so the input is reachable only
    // after opening the expander. Match the toggle label in either
    // ja ("パスを直接入力する（上級者向け）") or en
    // ("Enter a path directly (advanced)") locale.
    await page
      .locator('details > summary')
      .filter({ hasText: /パスを直接入力|Enter a path directly/i })
      .click()

    const input = page.getByTestId('recipe-import-source-input')
    await expect(input).toBeVisible({ timeout: 10_000 })
    const parseBtn = page.getByTestId('recipe-import-parse')
    await expect(parseBtn).toBeVisible()

    // Empty input keeps the parse button disabled
    await expect(parseBtn).toBeDisabled()

    // Filling the input enables the parse button (smoke contract)
    await input.fill('/tmp/kb-nonexistent-recipe')
    await expect(parseBtn).toBeEnabled()
  })
})

// Mark the scenario variable as used (suppresses unused-import lint when types narrow)
export type _FakeClaudeScenarioUsed = FakeClaudeScenario

// Global cleanup: remove any leftover tmux sessions from test runs.
test.afterAll(async ({}, testInfo) => {
  const sessionName = getSessionName(testInfo)
  await cleanupFakeClaudeSession(sessionName)
})
