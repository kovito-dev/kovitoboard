/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * S14: Recipe page "Create new app" flow (EU9)
 *
 * @see docs/specs/v0.1.0-app-creation-flow.md (kovitoboard-dev / kovito-hq)
 *
 * 検証対象:
 *   - S14-a: モーダル開閉の基本動作（× / Esc / overlay click / cancel）
 *   - S14-b: 必須項目バリデーション（purpose 空 → submit 非活性）
 *   - S14-c: エージェント選択切替（agents が 2 件以上あるときのみ）
 *   - S14-d: OK 押下 → POST /sessions/new → /agents/<id>?openLatestSession=1 への遷移
 *   - S14-e: キャンセル動作とフォーム状態リセット
 *
 * 注: 仕様書 §8.1 / §9.2 では `S13` を割り当てているが、L1 リポジトリ
 *    内には既に `s13-version-display.spec.ts` があるため衝突を避けて
 *    `S14` を採用した。実装担当判断（既存 spec に手を入れずファイル名は
 *    仕様書通り `recipe-create-app.spec.ts` を維持）。
 */
import { test, expect, type Page } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

interface AgentInfo {
  id: string
  displayName: string
}

/** Fetch the live agent list via the same endpoint the renderer uses. */
async function fetchAgents(page: Page): Promise<AgentInfo[]> {
  const res = await page.request.get(`${API_BASE}/api/agents`)
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json as AgentInfo[]
}

/** Open the recipes page and click the "Create new app" button. */
async function openCreateAppModal(page: Page): Promise<void> {
  await page.goto('/recipes')
  await page.waitForLoadState('networkidle')
  const button = page.locator('[data-testid="recipe-create-app-button"]')
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.locator('[data-testid="app-create-modal"]')).toBeVisible()
}

test.describe('S14: Recipe page Create-new-app flow', () => {
  // -----------------------------------------------------------------
  // S14-a: モーダル開閉の基本動作
  // -----------------------------------------------------------------
  test.describe('S14-a: モーダル開閉', () => {
    test('S14-a-1: ボタンクリックでモーダルが開く', async ({ page }) => {
      await page.goto('/recipes')
      await page.waitForLoadState('networkidle')
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)
      await page.locator('[data-testid="recipe-create-app-button"]').click()
      await expect(page.locator('[data-testid="app-create-modal"]')).toBeVisible()
    })

    test('S14-a-2: × ボタンで閉じる', async ({ page }) => {
      await openCreateAppModal(page)
      await page.locator('[data-testid="app-create-modal-close"]').click()
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)
    })

    test('S14-a-3: Escape キーで閉じる', async ({ page }) => {
      await openCreateAppModal(page)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)
    })

    test('S14-a-4: オーバーレイクリックで閉じる', async ({ page }) => {
      await openCreateAppModal(page)
      // The overlay is the absolute-positioned bg layer just inside the
      // modal root. Click in the top-left corner to avoid hitting the
      // modal body.
      const root = page.locator('[data-testid="app-create-modal-root"]')
      const box = await root.boundingBox()
      expect(box).not.toBeNull()
      if (!box) return
      await page.mouse.click(box.x + 5, box.y + 5)
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)
    })

    test('S14-a-5: キャンセルボタンで閉じる', async ({ page }) => {
      await openCreateAppModal(page)
      await page.locator('[data-testid="app-create-cancel"]').click()
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)
    })
  })

  // -----------------------------------------------------------------
  // S14-b: 必須項目バリデーション
  // -----------------------------------------------------------------
  test.describe('S14-b: 必須項目バリデーション', () => {
    test('S14-b-1: 開いた直後は submit ボタンが disabled', async ({ page }) => {
      await openCreateAppModal(page)
      await expect(page.locator('[data-testid="app-create-submit"]')).toBeDisabled()
    })

    test('S14-b-2: purpose を入力すると submit ボタンが enabled', async ({ page }) => {
      await openCreateAppModal(page)
      await page.locator('[data-testid="app-create-purpose"]').fill('test purpose')
      await expect(page.locator('[data-testid="app-create-submit"]')).toBeEnabled()
    })

    test('S14-b-3: purpose を空に戻すと submit ボタンが再び disabled', async ({ page }) => {
      await openCreateAppModal(page)
      const textarea = page.locator('[data-testid="app-create-purpose"]')
      await textarea.fill('test')
      await expect(page.locator('[data-testid="app-create-submit"]')).toBeEnabled()
      await textarea.fill('')
      await expect(page.locator('[data-testid="app-create-submit"]')).toBeDisabled()
    })

    test('S14-b-4: 半角スペースのみは未入力扱い（submit 非活性）', async ({ page }) => {
      await openCreateAppModal(page)
      await page.locator('[data-testid="app-create-purpose"]').fill('   ')
      await expect(page.locator('[data-testid="app-create-submit"]')).toBeDisabled()
    })
  })

  // -----------------------------------------------------------------
  // S14-c: エージェント選択切替
  // -----------------------------------------------------------------
  test.describe('S14-c: エージェント選択切替', () => {
    test('S14-c-1: agents が 2 件以上ある場合に切替できる（1 件なら skip）', async ({ page }) => {
      const agents = await fetchAgents(page)
      test.skip(
        agents.length < 2,
        `Need at least 2 agents to test selection switching, got ${agents.length}`,
      )
      await openCreateAppModal(page)
      const list = page.locator('[data-testid="app-create-agent-list"]')
      await expect(list).toBeVisible()

      // Find the option that is NOT currently selected. The default
      // selection is `kovito-developer` if present, otherwise agents[0].
      const initialSelected = list.locator('li[aria-selected="true"]').first()
      await expect(initialSelected).toHaveCount(1)

      // Pick another agent.
      const target = agents.find((a) => {
        const opt = list.locator(`[data-testid="app-create-agent-option-${a.id}"]`)
        return opt
      })
      // Use the second agent in the list (deterministic).
      const second = agents[1]
      const secondOpt = list.locator(`[data-testid="app-create-agent-option-${second.id}"]`)
      await secondOpt.click()
      await expect(secondOpt).toHaveAttribute('aria-selected', 'true')
    })

    test('S14-c-2: 開いた直後にデフォルト選択が必ず存在する', async ({ page }) => {
      await openCreateAppModal(page)
      const selected = page
        .locator('[data-testid="app-create-agent-list"] li[aria-selected="true"]')
      await expect(selected).toHaveCount(1)
    })
  })

  // -----------------------------------------------------------------
  // S14-d: 送信 → POST 発火 → payload 検証（renderer の正常パスを
  //                                          decisive に検証する）
  //
  // L1 fake-claude harness は `POST /api/sessions/new` の後段（tmux
  // spawn → JSONL 生成 → watcher 検出）が決定的でないので、ここでは
  // route interception で POST を success レスポンスにモックし、
  // renderer 側の handleCreate がきちんと「POST 投げる → resolve →
  // modal close」を辿ることを検証する。POST 後の navigate と実エ
  // ージェントの応答チェーンは L3 手動 §1-12 がカバー。
  // -----------------------------------------------------------------
  test.describe('S14-d: 送信 → POST 発火', () => {
    test('S14-d-1: submit で POST /api/sessions/new が想定 payload で叩かれ、モーダルが閉じる', async ({
      page,
    }) => {
      // Mock the new-session endpoint with a 200 OK so handleCreate's
      // awaited promise resolves regardless of the harness state.
      await page.route('**/api/sessions/new', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, processId: 'mock-pid', via: 'claude-bridge' }),
        })
      })

      await openCreateAppModal(page)
      await page.locator('[data-testid="app-create-purpose"]').fill('search project notes')

      // Capture the chosen agent id from the highlighted option.
      const selectedOption = page
        .locator('[data-testid="app-create-agent-list"] li[aria-selected="true"]')
      const selectedTestid = await selectedOption.getAttribute('data-testid')
      expect(selectedTestid).toBeTruthy()
      const expectedAgentId = (selectedTestid ?? '').replace('app-create-agent-option-', '')
      expect(expectedAgentId.length).toBeGreaterThan(0)

      // Watch for the POST /api/sessions/new call. The body payload
      // should carry origin: 'recipe-create-app' and the chosen agent.
      const sessionRequestPromise = page.waitForRequest(
        (req) => req.url().endsWith('/api/sessions/new') && req.method() === 'POST',
      )

      await page.locator('[data-testid="app-create-submit"]').click()

      const sessionRequest = await sessionRequestPromise
      const postData = sessionRequest.postDataJSON() as {
        agentId?: string
        message?: string
        origin?: string
      }
      expect(postData.agentId).toBe(expectedAgentId)
      expect(postData.origin).toBe('recipe-create-app')
      expect(typeof postData.message).toBe('string')
      // The prompt is wrapped in a rule-line `app-create` sentinel
      // (spec `kb-authored-sentinel.md` §6.1). The legacy
      // `KovitoBoard App Creation Request` anchor was removed in the
      // K-15 cutover (§11.3); only the sentinel envelope identifies
      // the kind now.
      expect(postData.message ?? '').toContain('━━━━━ KovitoBoard:app-create ━━━━━')

      // The mocked 200 OK lets handleCreate close the modal. We
      // intentionally do not assert the URL transition — that ties
      // the test to the AgentDetailPage hand-off, which is more
      // appropriately covered by the L3 §1-12-D scenario.
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0, {
        timeout: 5_000,
      })
    })
  })

  // -----------------------------------------------------------------
  // S14-e: キャンセル後の状態リセット
  // -----------------------------------------------------------------
  test.describe('S14-e: キャンセル後の状態', () => {
    test('S14-e-1: キャンセルして再度開くと purpose は空に戻る', async ({ page }) => {
      await openCreateAppModal(page)
      const textarea = page.locator('[data-testid="app-create-purpose"]')
      await textarea.fill('typed-then-cancelled')
      await page.locator('[data-testid="app-create-cancel"]').click()
      await expect(page.locator('[data-testid="app-create-modal"]')).toHaveCount(0)

      // Reopen and confirm the field is empty.
      await page.locator('[data-testid="recipe-create-app-button"]').click()
      await expect(page.locator('[data-testid="app-create-modal"]')).toBeVisible()
      await expect(page.locator('[data-testid="app-create-purpose"]')).toHaveValue('')
    })
  })
})
