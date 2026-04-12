/**
 * trust-prompt-relay テスト
 *
 * テスト対象:
 * - trust-prompt 関連の API が応答するか
 * - WebSocket 接続が確立できるか
 * - 初期状態で TrustPromptModal が表示されていないことを確認
 *
 * 注意:
 * trust-prompt の完全な E2E フロー（tmux パネル監視 → 検出 → UI モーダル → 応答）は
 * tmux 環境に依存するため、このテストでは API レベルの動作確認に留める。
 * tmux 連携の統合テストは Phase 8 の実機確認で実施する。
 */
import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('trust-prompt-relay', () => {
  test('tmux ステータス API が正常に応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/tmux/status`)
    expect(res.ok()).toBeTruthy()

    const status = await res.json()
    // tmux セッションが存在しない環境でも、エラーにならずステータスを返す
    expect(status).toBeTruthy()
  })

  test('WebSocket 接続が確立できる', async () => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws')

    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close()
        resolve(false)
      }, 5000)

      ws.on('open', () => {
        clearTimeout(timeout)
        resolve(true)
      })

      ws.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })

    expect(connected).toBe(true)
    ws.close()
  })

  test('WebSocket で trust_prompt_respond を送信してクラッシュしない', async () => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws')

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('接続タイムアウト')), 5000)
      ws.on('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // trust_prompt_respond メッセージを送信
    // tmux セッションがない場合は無視される（サーバーはクラッシュしない）
    const message = JSON.stringify({
      type: 'trust_prompt_respond',
      payload: {
        promptId: 'test-prompt-id',
        windowName: 'test-window',
        response: { mode: 'choice', choiceId: 'yes' },
      },
    })

    // 送信がエラーなく完了することを確認（送信自体は成功する）
    ws.send(message)

    // 少し待ってからサーバーがクラッシュしていないことを確認
    await new Promise(r => setTimeout(r, 1000))

    // サーバーが生きていることを確認（新しい接続が張れる）
    const ws2 = new WebSocket('ws://127.0.0.1:3001/ws')
    const reconnected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws2.close()
        resolve(false)
      }, 3000)
      ws2.on('open', () => {
        clearTimeout(timeout)
        resolve(true)
      })
      ws2.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })

    expect(reconnected).toBe(true)

    ws.close()
    ws2.close()
  })

  test('初期状態で TrustPromptModal が表示されていない', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // TrustPromptModal は trust prompt 検知時のみ表示される
    // 初期状態では role="dialog" の要素が存在しないことを確認
    const modal = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(modal).toHaveCount(0)
  })
})
