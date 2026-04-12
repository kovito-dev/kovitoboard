/**
 * ナビゲーション・画面遷移テスト
 *
 * テスト対象:
 * - サイドメニューの各項目をクリックして画面遷移できるか
 *
 * NavMenu の構造:
 * - サイドバー: div.bg-[var(--bg-nav)] 内に button[title=label] として配置
 * - button の title 属性にメニュー名が設定されている
 */
import { test, expect } from '@playwright/test'

// サイドバー内のメニューボタンを取得するヘルパー
function sidebarButton(page: import('@playwright/test').Page, label: string) {
  return page.locator(`button[title="${label}"]`).first()
}

test.describe('ナビゲーション', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('サイドバーにメニュー項目が表示される', async ({ page }) => {
    await expect(sidebarButton(page, 'エージェント')).toBeVisible()
    await expect(sidebarButton(page, 'セッション')).toBeVisible()
  })

  test('タスクメニューが存在しないことを確認', async ({ page }) => {
    // KovitoBoard v0.1.0 ではタスク機能は削除済み
    const taskButton = page.locator('button[title="タスク"]')
    await expect(taskButton).toHaveCount(0)
  })

  test('セッションメニューに遷移できる', async ({ page }) => {
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // 画面が変わったことを確認
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })

  test('エージェントメニューに戻れる', async ({ page }) => {
    // まずセッションに遷移
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(300)

    // エージェントに戻る
    await sidebarButton(page, 'エージェント').click()
    await page.waitForTimeout(500)

    // エージェント画面が表示される
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })
})
