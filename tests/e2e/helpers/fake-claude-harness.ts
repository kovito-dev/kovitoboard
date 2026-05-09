/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Fake Claude Harness — tmux mock management for Playwright E2E tests
 *
 * Launches Fake Claude scripts inside tmux sessions so that
 * KB's trust-prompt-detector can capture and detect prompts just like in production.
 *
 * @see docs/design/fake-claude-design.md
 * @see docs/design/decisions/DEC-010-fake-claude-e2e-strategy.md
 */

import type { Page } from '@playwright/test'
import { execSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Directory containing the Fake Claude scripts */
const FAKE_CLAUDE_DIR = resolve(__dirname, '../../fixtures/fake-claude')

export type FakeClaudeScenario =
  | 'folder-trust'
  | 'write-create'
  | 'edit-modify'
  | 'bash-simple'
  | 'rejection-flow'

export interface FakeClaudeHandle {
  /** tmux session name (unique) */
  sessionName: string
  /** tmux window name */
  windowName: string
  /** Destroy the session */
  dispose(): Promise<void>
  /** Send additional keys (for follow-up operations after a response) */
  sendKeys(keys: string): Promise<void>
  /** Capture the current pane content (for debugging and assertions) */
  capture(): Promise<string>
}

export interface StartFakeClaudeOptions {
  /** Scenario name (filename from scenarios/*.sh without the .sh extension) */
  scenario: FakeClaudeScenario
  /** tmux window name (KB treats the window name as the agent ID) */
  windowName: string
  /** Explicit tmux session name (default: auto-resolved E2E shared session name) */
  sessionName?: string
  /** Playwright TestInfo — if provided, project.metadata.sessionName is used as fallback */
  testInfo?: { project?: { metadata?: { sessionName?: string } } }
}

/**
 * Resolve the shared E2E tmux session name.
 *
 * Priority: explicit override > Playwright project metadata > env var > random fallback
 */
function resolveSessionName(opts: Pick<StartFakeClaudeOptions, 'sessionName' | 'testInfo'>): string {
  if (opts.sessionName) return opts.sessionName
  const metaName = opts.testInfo?.project?.metadata?.sessionName
  if (metaName) return metaName
  return process.env.KOVITOBOARD_E2E_TMUX_SESSION || `kb-e2e-${randomUUID().slice(0, 8)}`
}

/**
 * Start Fake Claude inside a tmux session.
 *
 * Creates a window inside the session specified by KOVITOBOARD_E2E_TMUX_SESSION,
 * which KB's tmux-bridge will reference.
 */
export async function startFakeClaude(
  opts: StartFakeClaudeOptions,
): Promise<FakeClaudeHandle> {
  const sessionName = resolveSessionName(opts)
  const scriptPath = resolve(FAKE_CLAUDE_DIR, 'entrypoint.sh')

  // Create the session if it does not exist
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
  })

  if (hasSession.status !== 0) {
    // Create a new session with fixed dimensions (pitfall #2 mitigation)
    execSync(
      `tmux new-session -d -s "${sessionName}" -n main -x 200 -y 50`,
      { stdio: 'pipe' },
    )
  }

  // Remove existing window with the same name (idempotency)
  spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
    stdio: 'pipe',
  })

  // Create a window that runs the Fake Claude script
  execSync(
    `tmux new-window -t "${sessionName}" -n "${opts.windowName}" ` +
    `"bash '${scriptPath}' '${opts.scenario}'"`,
    { stdio: 'pipe' },
  )

  // Wait briefly for the fixture to finish rendering
  await new Promise((r) => setTimeout(r, 500))

  return {
    sessionName,
    windowName: opts.windowName,

    async dispose() {
      spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${opts.windowName}`], {
        stdio: 'pipe',
      })

      // Wait for the window to actually disappear from `tmux list-windows`.
      // Without this poll, `kill-window` returns synchronously before tmux
      // has finished tearing down the pane, and the next test (or a
      // detector tick) can still observe the dying window's content.
      // Bound the wait so a wedged tmux server does not stall the suite.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const list = spawnSync(
          'tmux',
          ['list-windows', '-t', sessionName, '-F', '#{window_name}'],
          { stdio: 'pipe' },
        )
        // session may already be gone (e.g. last window killed) → done
        if (list.status !== 0) break
        const names = (list.stdout?.toString() ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
        if (!names.includes(opts.windowName)) break
        await new Promise((r) => setTimeout(r, 25))
      }

      // Destroy the session if no windows remain
      const remaining = spawnSync('tmux', [
        'list-windows', '-t', sessionName,
      ], { stdio: 'pipe' })
      const output = remaining.stdout?.toString().trim() ?? ''
      // If only the main window remains (or empty), destroy the session
      const lines = output.split('\n').filter((l) => l.trim())
      if (lines.length <= 1) {
        spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
      }
    },

    async sendKeys(keys: string) {
      spawnSync('tmux', [
        'send-keys', '-t', `${sessionName}:${opts.windowName}`, keys,
      ], { stdio: 'pipe' })
    },

    async capture() {
      const r = spawnSync('tmux', [
        'capture-pane', '-pt', `${sessionName}:${opts.windowName}`, '-S', '-200',
      ], { stdio: 'pipe' })
      return r.stdout?.toString() ?? ''
    },
  }
}

/**
 * Fully clean up the tmux session used for E2E tests.
 * Call this in test.afterAll.
 */
export async function cleanupFakeClaudeSession(sessionName: string): Promise<void> {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' })
}

/**
 * Dispose a Fake Claude window AND wait for any KB UI side-effects
 * (such as a TrustPromptModal triggered by it) to fully detach.
 *
 * This is the recommended teardown path inside per-test cleanup hooks
 * (see helpers/l1-per-test-setup.ts). It guarantees that the next test
 * does not race against:
 *   - a tmux window that is still being killed,
 *   - a `<TrustPromptModal>` that is still in the DOM (its overlay
 *     `<div class="absolute inset-0 ...">` blocks pointer events for
 *     subsequent tests if it is still mounted),
 *   - a WebSocket event burst that has not yet settled on the server,
 *   - the server-side trust-prompt-detector keeping a stale per-window
 *     `DetectorState` entry whose `lastCaptureHash` would silence the
 *     next test's trust-prompt event when window names are recycled.
 *
 * If `apiBaseUrl` is supplied the helper calls the test-only
 * `/api/admin/test-reset-state` endpoint (DEC-018 §3.1.4 / P1-4) which
 * clears the detector's per-window state map server-side. This is the
 * deterministic fix for the recycled-window-name race. Without
 * `apiBaseUrl` the helper falls back to a longer settle wait.
 *
 * @param handle - the FakeClaudeHandle returned by startFakeClaude
 * @param page   - the Playwright Page bound to the test
 * @param opts.timeout    - max wait for modal-detached (default 5s)
 * @param opts.apiBaseUrl - origin of the KB API server (e.g.
 *                          `http://127.0.0.1:3001`). When provided the
 *                          test-only state-reset endpoint is invoked.
 */
export async function waitForFullDispose(
  handle: FakeClaudeHandle,
  page: Page,
  opts: { timeout?: number; apiBaseUrl?: string } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 5_000

  // 1. Kill the tmux window (and the session if no other windows remain).
  //    `dispose()` itself polls `tmux list-windows` so it does not return
  //    until the window has actually disappeared (or 2 s elapses), which
  //    makes the subsequent server-side reset deterministic — no detector
  //    tick can re-seed state for a window that is already gone.
  await handle.dispose()

  // 2. Wait for any KB-rendered modal driven by this window to detach.
  //    The selector intentionally matches both detected-mode and
  //    fallback-mode TrustPromptModal renderings.
  await page
    .locator('[data-testid="trust-prompt-modal"]')
    .waitFor({ state: 'detached', timeout })
    .catch(() => {
      /* No modal was open — nothing to wait on. */
    })

  // 3. Force-clear server-side detector state when running under
  //    KB_E2E_MODE. This eliminates the recycled-window-name race
  //    deterministically; the longer time-based fallback below is
  //    only used when the helper is invoked without apiBaseUrl
  //    (e.g. legacy callers or tests that don't go through kbFixture).
  if (opts.apiBaseUrl) {
    const launchToken = process.env.KB_LAUNCH_TOKEN ?? ''
    await page.request
      .post(`${opts.apiBaseUrl}/api/admin/test-reset-state`, {
        headers: { 'X-Kovitoboard-Token': launchToken },
      })
      .catch(() => {
        /* Endpoint may be 404 if KB_E2E_MODE is not set — tolerate it. */
      })
  }

  // Settle wait. Empirically a hard server-side reset is not enough on
  // its own — under dev-mode webServer the next test still races the
  // detector tick, vite-dev hot-reload of the new page, and tmux's own
  // window-disappearance settling. 2500 ms covers the worst case
  // observed in 3-run gate testing (DEC-018 P1-6) without making the
  // suite painfully slow (≈18s overhead across 7 dispose calls).
  // The wait is unconditional; if the reset endpoint was unavailable
  // the wait still helps the fallback path.
  await new Promise<void>((r) => setTimeout(r, 2500))
}
