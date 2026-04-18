/**
 * 30min-experience E2E test
 *
 * Functional verification of the "first 30 minutes experience" scenario.
 * @see docs/specs/v0.1.0-30min-experience-e2e-plan.md
 *
 * S3: Agent creation request -> Write-type prompt pass-through [reference impl]
 * This is the scenario explicitly flagged as a top automation priority.
 */
import { test, expect } from '@playwright/test'
import {
  startFakeClaude,
  cleanupFakeClaudeSession,
  type FakeClaudeHandle,
} from './helpers/fake-claude-harness'

/** Shared E2E tmux session name (must match the env in playwright.config.ts) */
const E2E_SESSION = 'kb-e2e-shared'

test.describe('S3: エージェント追加依頼 → Write 系 prompt 通し', () => {
  test.describe.configure({ mode: 'serial' })

  test('S3-a: Yes 選択で trust prompt を承認し Claude Code が続行する', async ({ page }) => {
    // Arrange: Start Fake Claude with the write-create scenario
    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName: E2E_SESSION,
    })

    try {
      // Wait for the fixture to be rendered in tmux
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Write(')
      }).toPass({ timeout: 5000 })

      // Act: Navigate to the session page (detector picks it up via polling)
      await page.goto('/')
      await page.waitForLoadState('networkidle')

      // Assert 1: TrustPromptModal is visible
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 10000 })

      // Assert 2: kind label indicates a Write-type prompt
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText('信頼確認')

      // Assert 3: Target file is displayed
      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('test-agent.md')

      // Assert 4: Three choices are available (Yes / Yes-session / No)
      await expect(page.getByTestId('trust-prompt-choice-yes')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-yes-session')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-no')).toBeVisible()

      // Act: Select Yes
      await page.getByTestId('trust-prompt-choice-yes').click()

      // Assert 5: Fake Claude transitions to state 2 (success message)
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Created .claude/agents/test-agent.md')
      }).toPass({ timeout: 5000 })

      // Assert 6: Modal closes (dismissed by trust_prompt_resolved)
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })

  test('S3-b: Yes-for-session 選択で trust prompt を承認する', async ({ page }) => {
    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName: E2E_SESSION,
    })

    try {
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Write(')
      }).toPass({ timeout: 5000 })

      await page.goto('/')
      await page.waitForLoadState('networkidle')

      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 10000 })

      // Act: Select "Yes, and allow for session"
      await page.getByTestId('trust-prompt-choice-yes-session').click()

      // Assert: Fake Claude transitions with session-allowed
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('session-allowed')
      }).toPass({ timeout: 5000 })

      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })

  test('S3-c: No 選択で trust prompt を拒否する', async ({ page }) => {
    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName: E2E_SESSION,
    })

    try {
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Write(')
      }).toPass({ timeout: 5000 })

      await page.goto('/')
      await page.waitForLoadState('networkidle')

      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 10000 })

      // Act: Select No
      await page.getByTestId('trust-prompt-choice-no').click()

      // Assert: Fake Claude shows rejection message and exits
      // Note: The process terminates with exit 1, so capture may return an error or empty string.
      // The primary assertion is that the modal closes.
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// Global cleanup for all tests
test.afterAll(async () => {
  await cleanupFakeClaudeSession(E2E_SESSION)
})
