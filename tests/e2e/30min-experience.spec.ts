/**
 * 30min-experience E2E テスト
 *
 * 「最初の30分体験」シナリオの機能動作保証。
 * @see docs/specs/v0.1.0-30min-experience-e2e-plan.md
 *
 * S3: エージェント追加依頼 → Write 系 prompt 通し【参照実装】
 * 康輔さんが「一番自動化したい」と明示したシナリオ。
 */
import { test, expect } from '@playwright/test'
import {
  startFakeClaude,
  cleanupFakeClaudeSession,
  type FakeClaudeHandle,
} from './helpers/fake-claude-harness'

/** E2E 共有 tmux セッション名（playwright.config.ts の env と一致） */
const E2E_SESSION = 'kb-e2e-shared'

test.describe('S3: エージェント追加依頼 → Write 系 prompt 通し', () => {
  test.describe.configure({ mode: 'serial' })

  test('S3-a: Yes 選択で trust prompt を承認し Claude Code が続行する', async ({ page }) => {
    // Arrange: Fake Claude を write-create シナリオで起動
    const fake = await startFakeClaude({
      scenario: 'write-create',
      windowName: 'kovito-concierge',
      sessionName: E2E_SESSION,
    })

    try {
      // fixture が tmux に表示されるのを待つ
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Write(')
      }).toPass({ timeout: 5000 })

      // Act: セッション画面にアクセス（detector がポーリングで検知する）
      await page.goto('/')
      await page.waitForLoadState('networkidle')

      // Assert 1: TrustPromptModal が表示される
      const modal = page.getByTestId('trust-prompt-modal')
      await expect(modal).toBeVisible({ timeout: 10000 })

      // Assert 2: kind ラベルが Write 系
      const kindLabel = page.getByTestId('trust-prompt-kind-label')
      await expect(kindLabel).toContainText('信頼確認')

      // Assert 3: 対象ファイルが表示される
      const targetFile = page.getByTestId('trust-prompt-target-file')
      await expect(targetFile).toContainText('test-agent.md')

      // Assert 4: 選択肢が 3 つ存在する（Yes / Yes-session / No）
      await expect(page.getByTestId('trust-prompt-choice-yes')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-yes-session')).toBeVisible()
      await expect(page.getByTestId('trust-prompt-choice-no')).toBeVisible()

      // Act: Yes を選択
      await page.getByTestId('trust-prompt-choice-yes').click()

      // Assert 5: Fake Claude が state 2 に遷移（成功メッセージ）
      await expect(async () => {
        const buf = await fake.capture()
        expect(buf).toContain('Created .claude/agents/test-agent.md')
      }).toPass({ timeout: 5000 })

      // Assert 6: モーダルが閉じる（trust_prompt_resolved で消える）
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

      // Act: Yes, and allow for session を選択
      await page.getByTestId('trust-prompt-choice-yes-session').click()

      // Assert: Fake Claude が session-allowed で遷移
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

      // Act: No を選択
      await page.getByTestId('trust-prompt-choice-no').click()

      // Assert: Fake Claude が拒否メッセージを表示して exit
      // Note: exit 1 でプロセスが終了するため、capture はエラーまたは空になりうる
      // モーダルが閉じることを主に検証する
      await expect(modal).not.toBeVisible({ timeout: 5000 })
    } finally {
      await fake.dispose()
    }
  })
})

// テスト全体のクリーンアップ
test.afterAll(async () => {
  await cleanupFakeClaudeSession(E2E_SESSION)
})
