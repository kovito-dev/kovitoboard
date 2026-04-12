/**
 * セッションフロー テスト
 *
 * テスト対象:
 * - セッション一覧画面が表示されるか
 * - 新規セッション API の受け付け
 * - UI操作中にコンソールエラーが発生しないこと
 *
 * 注意:
 * Claude CLI の応答は期待しない。API 呼び出しとUI側の状態遷移のみを検証する。
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://127.0.0.1:3001'

// サイドバー内のメニューボタンを取得するヘルパー
function sidebarButton(page: import('@playwright/test').Page, label: string) {
  return page.locator(`button[title="${label}"]`).first()
}

test.describe('セッションフロー', () => {
  test('新規セッション API が受け付けられる', async ({ request }) => {
    // エージェント一覧を取得
    const agentsRes = await request.get(`${API_BASE}/api/agents`)
    expect(agentsRes.ok()).toBeTruthy()
    const agents = await agentsRes.json()

    // エージェントが存在しない場合はスキップ
    test.skip(agents.length === 0, 'エージェント定義が存在しないためスキップ')

    const firstAgent = agents[0]

    // 新規セッション API を呼び出す
    // Claude CLI が不在でもプロセス起動は試行される（エラーにはならない）
    const res = await request.post(`${API_BASE}/api/sessions/new`, {
      data: {
        agentId: firstAgent.id,
        message: 'E2Eテストメッセージ',
      },
    })
    expect(res.ok()).toBeTruthy()

    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.processId).toBeTruthy()
  })

  test('UI操作中にコンソールエラーが発生しない', async ({ page }) => {
    // ページエラー（未捕捉例外）を収集する
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // 1. セッション画面に遷移
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // 2. エージェント画面に戻る
    await sidebarButton(page, 'エージェント').click()
    await page.waitForTimeout(500)

    // 3. 再びセッション画面に遷移
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // コンソールエラーが発生していないこと
    expect(pageErrors).toHaveLength(0)
  })

  test('セッション画面遷移後にコンテンツが表示される', async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // セッション画面に遷移
    await sidebarButton(page, 'セッション').click()
    await page.waitForTimeout(500)

    // 画面が空白にならないこと
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeTruthy()
    expect(bodyText!.length).toBeGreaterThan(0)

    // コンソールエラーが発生していないこと
    expect(pageErrors).toHaveLength(0)
  })
})
