/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * trust-prompt-relay tests
 *
 * Test targets:
 * - trust-prompt related APIs respond
 * - WebSocket connections can be established
 * - TrustPromptModal is not displayed in the initial state
 *
 * Note:
 * The full E2E flow (tmux pane monitoring -> detection -> UI modal -> response)
 * depends on a tmux environment, so this test only verifies API-level behavior.
 * Integration tests with tmux are performed in Phase 8 live verification.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import { WebSocket } from 'ws'

const API_BASE = 'http://127.0.0.1:3001'

test.describe('trust-prompt-relay', () => {
  test('tmux ステータス API が正常に応答する', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/tmux/status`)
    expect(res.ok()).toBeTruthy()

    const status = await res.json()
    // Returns status without error even in environments without a tmux session
    expect(status).toBeTruthy()
  })

  test('WebSocket 接続が確立できる', async () => {
    const ws = new WebSocket('ws://127.0.0.1:3001/api/ws')

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
    const ws = new WebSocket('ws://127.0.0.1:3001/api/ws')

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connection timeout')), 5000)
      ws.on('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // Send a trust_prompt_respond message
    // Ignored when no tmux session exists (server does not crash)
    const message = JSON.stringify({
      type: 'trust_prompt_respond',
      payload: {
        promptId: 'test-prompt-id',
        windowName: 'test-window',
        response: { mode: 'choice', choiceId: 'yes' },
      },
    })

    // Verify that sending completes without error (the send itself succeeds)
    ws.send(message)

    // Wait briefly, then verify the server has not crashed
    await new Promise(r => setTimeout(r, 1000))

    // Verify the server is alive (a new connection can be established)
    const ws2 = new WebSocket('ws://127.0.0.1:3001/api/ws')
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

    // TrustPromptModal is only shown when a trust prompt is detected
    // Verify that no role="dialog" element exists in the initial state
    const modal = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(modal).toHaveCount(0)
  })
})
