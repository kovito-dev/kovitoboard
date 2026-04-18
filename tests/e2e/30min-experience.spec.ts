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
import { test, expect, type Page } from '@playwright/test'
import {
  startFakeClaude,
  cleanupFakeClaudeSession,
  type FakeClaudeScenario,
} from './helpers/fake-claude-harness'

/** Resolve the tmux session name from Playwright project metadata. */
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
  test('S3-a: Approve with Yes and let Claude Code continue', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)

    // Establish WS connection first (detector only broadcasts once per capture hash)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      // Modal is expected to appear within detector polling window (1s window discovery + 200ms poll)
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // Kind label reflects a Write-type prompt
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/Write|信頼確認|ファイル書き込み/)

      // Target file is displayed
      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('test-agent.md')

      // All three choices are rendered
      await expect(page.getByTestId('trust-prompt-choice-yes')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-yes-session')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-no')).toBeVisible()

      // Act: click Yes
      await page.getByTestId('trust-prompt-choice-yes').click()

      // Fake Claude transitions to state 2 (success message)
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Created .claude/agents/test-agent.md')
      }).toPass({ timeout: 5000 })

      // Modal dismisses after trust_prompt_resolved
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })

  test('S3-b: Approve with Yes-for-session', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      await page.getByTestId('trust-prompt-choice-yes-session').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('session-allowed')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })

  test('S3-c: Reject with No', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      await page.getByTestId('trust-prompt-choice-no').click()

      // Modal closes after rejection; Fake Claude exits with code 1
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// S2: First folder trust prompt
// ---------------------------------------------------------------------------
test.describe('S2: First folder trust prompt', () => {
  test('S2-a: Approve folder trust (Yes)', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'folder-trust',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      // Kind label should indicate folder trust
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/folder|フォルダ/i)

      // Folder trust has 2 choices (Yes / No)
      await expect(page.getByTestId('trust-prompt-choice-yes')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-no')).toBeVisible()

      await page.getByTestId('trust-prompt-choice-yes').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Welcome back, session ready')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// S4: CLAUDE.md edit request -> Update-type prompt
// ---------------------------------------------------------------------------
test.describe('S4: Edit request -> Update-type prompt', () => {
  test('S4-a: Approve edit (Yes)', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'edit-modify',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/edit|update|編集/i)

      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('sample.txt')

      await page.getByTestId('trust-prompt-choice-yes').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Applied edit to sample.txt')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// S5: Bash execution request -> Bash-type prompt
// ---------------------------------------------------------------------------
test.describe('S5: Bash request -> Bash-type prompt', () => {
  test('S5-a: Approve Bash command (Yes)', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'bash-simple',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText(/bash|コマンド/i)

      // Bash prompt has 3 choices
      await expect(page.getByTestId('trust-prompt-choice-yes')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-yes-session')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-no')).toBeVisible()

      await page.getByTestId('trust-prompt-choice-yes').click()

      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Ran: touch newfile.txt')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// S6: Rejection flow (No selection)
// ---------------------------------------------------------------------------
test.describe('S6: Rejection flow', () => {
  test('S6-a: No selection closes modal and Fake Claude exits', async ({ page }, testInfo) => {
    const sessionName = getSessionName(testInfo)
    await openSessionPage(page)

    const fake = await startFakeClaude({
      scenario: 'rejection-flow',
      windowName: 'kovito-concierge',
      sessionName,
    })

    try {
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 15_000 })

      await page.getByTestId('trust-prompt-choice-no').click()

      // Modal dismisses after rejection
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// Mark the scenario variable as used (suppresses unused-import lint when types narrow)
export type _FakeClaudeScenarioUsed = FakeClaudeScenario

// Global cleanup: remove any leftover tmux sessions from test runs.
test.afterAll(async ({}, testInfo) => {
  const sessionName = getSessionName(testInfo)
  await cleanupFakeClaudeSession(sessionName)
})
