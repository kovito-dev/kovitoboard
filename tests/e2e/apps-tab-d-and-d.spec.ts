/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Apps tab — drag-and-drop order persistence
 * (BS-T9, tester request v1.1 §1.2 + cascade §10.2 / BS-L6).
 *
 * Verifies the v0.2.1 Apps tab D&D flow:
 *
 *   1. Drag a row's `apps-tab-row-${appId}-drag-handle` past the
 *      dnd-kit PointerSensor activation constraint (4px) and drop it
 *      over a sibling row.
 *   2. The renderer performs an optimistic reorder + fires
 *      `PUT /api/apps/menu-order` with the new contiguous order.
 *   3. The server writes the new `menuOrder` field on each affected
 *      AppManifest and broadcasts `app_menu_changed` with
 *      `event: 'menu-order-update'`.
 *   4. Reloading the page shows the persisted order.
 *
 * Coverage:
 *   - BS-T9-a: drag-and-drop reorders the visible rows + fires PUT +
 *     writes AppManifest.menuOrder + emits the cascade broadcast +
 *     survives a reload.
 *
 * Fixture method: A (programmatic). Two bundled samples
 * (`document-viewer` + `todo`) are enabled in beforeEach so the
 * D&D has two rows to swap; the menu.ts annotation workaround from
 * Phase 1 is also applied.
 *
 * dnd-kit integration: the AppsTab uses `@dnd-kit/core` with a
 * `PointerSensor` activated by a 4-pixel distance. Playwright's
 * `locator.dragTo()` does not always trigger this sensor reliably,
 * so we drive the drag via mouse primitives (`page.mouse.move` +
 * `down` + multi-step `move` + `up`) so the sensor sees a real
 * pointer trajectory that crosses the activation threshold.
 */
import { test, expect } from './helpers/l1-per-test-setup'
import {
  rewriteMenuTsForEnable,
  restoreMenuTs,
  cleanupAppDir,
  readAppManifest,
  waitForWsFrame,
} from './helpers/v021-bundled-helpers'

const API_BASE = 'http://127.0.0.1:3001'
const APP_DOC = 'document-viewer'
const APP_TODO = 'todo'

test.describe('Apps tab — drag-and-drop reorder (BS-T9)', () => {
  let originalMenuTs: string | null = null

  test.beforeEach(async ({ request, kbFixture }) => {
    originalMenuTs = rewriteMenuTsForEnable(kbFixture.projectRoot)
    const r1 = await request.post(
      `${API_BASE}/api/recipes/sample/${APP_DOC}/enable`,
    )
    expect(r1.status()).toBe(200)
    const r2 = await request.post(
      `${API_BASE}/api/recipes/sample/${APP_TODO}/enable`,
    )
    expect(r2.status()).toBe(200)
  })

  test.afterEach(async ({ kbFixture }) => {
    cleanupAppDir(kbFixture.projectRoot, APP_DOC)
    cleanupAppDir(kbFixture.projectRoot, APP_TODO)
    if (originalMenuTs !== null) {
      restoreMenuTs(kbFixture.projectRoot, originalMenuTs)
      originalMenuTs = null
    }
  })

  test('BS-T9-a: drag a row past the 4px activation threshold reorders + persists + broadcasts (BS-L6, cascade §10.2)', async ({
    page,
    kbFixture,
  }) => {
    await page.goto('/recipes')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()

    const sourceRow = page.getByTestId(`apps-tab-row-${APP_TODO}`)
    const targetRow = page.getByTestId(`apps-tab-row-${APP_DOC}`)
    await expect(sourceRow).toBeVisible()
    await expect(targetRow).toBeVisible()

    // Capture the initial persisted order BEFORE the drag so the
    // post-drag assertion can verify the drag actually moved
    // something. Without this baseline, a no-op gesture that never
    // crossed the 4 px activation threshold would still satisfy the
    // contiguous `[0, 1]` permutation check below.
    const initialDocManifest = readAppManifest(kbFixture.projectRoot, APP_DOC)
    const initialTodoManifest = readAppManifest(kbFixture.projectRoot, APP_TODO)
    const initialDocOrder = initialDocManifest?.menuOrder ?? null
    const initialTodoOrder = initialTodoManifest?.menuOrder ?? null

    // Resolve the drag-handle bounding boxes so we can drive the
    // pointer trajectory directly. The sensor needs the pointer to
    // start on the handle (not the row body) and to move at least
    // 4 px before it activates the drag.
    const sourceHandle = page.getByTestId(
      `apps-tab-row-${APP_TODO}-drag-handle`,
    )
    await expect(sourceHandle).toBeVisible()
    const sourceHandleBox = await sourceHandle.boundingBox()
    const targetRowBox = await targetRow.boundingBox()
    if (!sourceHandleBox || !targetRowBox) {
      throw new Error(
        '[BS-T9-a] could not resolve drag-handle / target bounding boxes',
      )
    }

    // Listen for the broadcast before the PUT fires; the server emits
    // it after lock release via setImmediate, so a late subscription
    // would race the close.
    const wsFramePromise = waitForWsFrame('app_menu_changed', {
      timeoutMs: 5_000,
    })
    const putResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith('/api/apps/menu-order') &&
        resp.request().method() === 'PUT' &&
        resp.status() === 200,
    )

    // Drive the pointer: start on the handle, press, move past the
    // 4 px activation threshold, then track to the target's mid-line.
    const startX = sourceHandleBox.x + sourceHandleBox.width / 2
    const startY = sourceHandleBox.y + sourceHandleBox.height / 2
    const endX = targetRowBox.x + targetRowBox.width / 2
    const endY = targetRowBox.y + targetRowBox.height / 2

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // Cross the activation threshold first — the sensor only commits
    // to a drag after the pointer has moved at least 4 px from the
    // press point, so a single jump straight to the target can be
    // interpreted as a click.
    await page.mouse.move(startX + 8, startY + 4, { steps: 4 })
    // Now travel to the target row in measured steps so the dnd-kit
    // collision detector observes a smooth trajectory rather than a
    // teleport.
    await page.mouse.move(endX, endY, { steps: 12 })
    // A tiny pause lets the renderer's optimistic reorder land before
    // we release the pointer (without it the sensor occasionally
    // sees the drop before the collision recompute).
    await page.waitForTimeout(40)
    await page.mouse.up()

    // PUT lands + cascade broadcast fires.
    await putResponsePromise
    const frame = await wsFramePromise
    expect(frame.type).toBe('app_menu_changed')
    expect(frame.payload).toMatchObject({ event: 'menu-order-update' })

    // The inflight indicator clears (the renderer reuses
    // `apps-tab-reorder-saving` while the PUT is in flight).
    await expect(
      page.getByTestId('apps-tab-reorder-saving'),
    ).toHaveCount(0, { timeout: 5_000 })

    // Capture the DOM order immediately after drop, BEFORE reload, so
    // we can pin the post-reload DOM and the persisted manifests to
    // the same observed permutation. The pointer trajectory itself is
    // dnd-kit's collision detector's call, so we treat the immediate
    // post-drop DOM as the source of truth for "what the user saw"
    // and require the persistence path to honour it.
    const docBoxAfterDrop = await page
      .getByTestId(`apps-tab-row-${APP_DOC}`)
      .boundingBox()
    const todoBoxAfterDrop = await page
      .getByTestId(`apps-tab-row-${APP_TODO}`)
      .boundingBox()
    if (!docBoxAfterDrop || !todoBoxAfterDrop) {
      throw new Error(
        '[BS-T9-a] could not resolve row bounding boxes immediately after drop',
      )
    }
    const observedOrderAfterDrop =
      docBoxAfterDrop.y < todoBoxAfterDrop.y
        ? [APP_DOC, APP_TODO]
        : [APP_TODO, APP_DOC]

    // AppManifest holds the persisted menuOrder. The drop moved todo
    // (originally enable-order 0) into the document-viewer slot. The
    // exact final order is what the DOM shows immediately after drop
    // (captured above); both rows must carry a numeric menuOrder and
    // it must be a contiguous `[0, 1]` permutation, and the lower
    // menuOrder must belong to whichever row appeared first in the
    // post-drop DOM.
    const docManifest = readAppManifest(kbFixture.projectRoot, APP_DOC)
    const todoManifest = readAppManifest(kbFixture.projectRoot, APP_TODO)
    expect(docManifest).not.toBeNull()
    expect(todoManifest).not.toBeNull()
    const docOrder = docManifest?.menuOrder
    const todoOrder = todoManifest?.menuOrder
    expect(typeof docOrder).toBe('number')
    expect(typeof todoOrder).toBe('number')
    const orders = [docOrder, todoOrder].sort()
    expect(orders).toEqual([0, 1])

    // The drag must have actually moved something — a no-op gesture
    // that never crossed the 4 px activation threshold would leave
    // both `menuOrder` values at their initial state and still pass
    // the contiguous `[0, 1]` permutation check above. Comparing
    // against the captured initial baseline closes that gap.
    const orderActuallyChanged =
      docOrder !== initialDocOrder || todoOrder !== initialTodoOrder
    expect(orderActuallyChanged).toBe(true)

    // Reload — the persisted order survives.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('apps-screen-panel-apps')).toBeVisible()
    await expect(page.getByTestId(`apps-tab-row-${APP_DOC}`)).toBeVisible()
    await expect(page.getByTestId(`apps-tab-row-${APP_TODO}`)).toBeVisible()

    // The on-disk menuOrder did not regress.
    const docAfterReload = readAppManifest(kbFixture.projectRoot, APP_DOC)
    const todoAfterReload = readAppManifest(kbFixture.projectRoot, APP_TODO)
    expect(docAfterReload?.menuOrder).toBe(docOrder)
    expect(todoAfterReload?.menuOrder).toBe(todoOrder)

    // The DOM order after reload matches BOTH the immediate
    // post-drop DOM and the persisted menuOrder. Reading the two
    // row containers by explicit testid avoids matching nested
    // `-drag-handle`/`-open`/`-rename` child elements that share
    // the `apps-tab-row-` prefix.
    const docBox = await page
      .getByTestId(`apps-tab-row-${APP_DOC}`)
      .boundingBox()
    const todoBox = await page
      .getByTestId(`apps-tab-row-${APP_TODO}`)
      .boundingBox()
    if (!docBox || !todoBox) {
      throw new Error(
        '[BS-T9-a] could not resolve row bounding boxes after reload',
      )
    }
    const renderedOrderAfterReload =
      docBox.y < todoBox.y ? [APP_DOC, APP_TODO] : [APP_TODO, APP_DOC]
    const persistedOrder =
      (docAfterReload?.menuOrder ?? 0) < (todoAfterReload?.menuOrder ?? 0)
        ? [APP_DOC, APP_TODO]
        : [APP_TODO, APP_DOC]
    // The user-observed order at drop time and the persisted-then-
    // re-rendered order must agree — an inverted drop-resolution bug
    // would diverge here.
    expect(renderedOrderAfterReload).toEqual(observedOrderAfterDrop)
    expect(persistedOrder).toEqual(observedOrderAfterDrop)
  })
})
