/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 Per-Test Setup — Snapshot/restore `.kovitoboard/` and disambiguate
 * tmux window names so tests within the same Playwright project cannot
 * leak state to each other.
 *
 * Why this exists
 * ----------------
 * playwright.config.l1.ts sets up three Playwright projects, each with
 * its own webServer (port + project root + tmux session). However, all
 * tests within a single project share the same `KOVITOBOARD_PROJECT_ROOT`
 * directory and the same `KOVITOBOARD_E2E_TMUX_SESSION` value. Without
 * per-test isolation:
 *   - `.kovitoboard/` mutations made by one test (settings, sessions,
 *     onboarding state, recipe-applied artifacts) leak into the next.
 *   - Fake-claude windows that fail to dispose can collide with windows
 *     created by the next test if both pick the same `windowName`.
 *
 * Strategy (DEC-018 §3.4 case C)
 * -------------------------------
 *   - Snapshot `.kovitoboard/` before each test.
 *   - Restore it after each test.
 *   - Hand out a per-test random suffix so callers can build unique tmux
 *     window names (`kbFixture.makeWindowName('agent-foo')`).
 *   - The tmux **session** name is left at the project-scoped value the
 *     KB server's tmux-bridge was started with (env-fixed; KB does not
 *     accept runtime rebinds).
 *
 * Usage
 * -----
 *   import { test, expect } from './helpers/l1-per-test-setup'
 *
 *   test('something', async ({ page, kbFixture }) => {
 *     const fake = await startFakeClaude({
 *       scenario: 'folder-trust',
 *       windowName: kbFixture.makeWindowName('agent-foo'),
 *       sessionName: kbFixture.tmuxSession,
 *     })
 *     // ... test body ...
 *     await fake.dispose()
 *   })
 *
 * @see docs/design/decisions/DEC-018-test-quality-assurance-strategy.md
 * @see docs/design/v0.1.0-test-quality-assurance-design.md §3.4
 */

import { test as base } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface KbFixture {
  /** Absolute path to the per-project root inside the template-cache. */
  projectRoot: string
  /** Project-scoped tmux session name (matches webServer env). */
  tmuxSession: string
  /** Build a tmux window name unique to the current test. */
  makeWindowName(prefix: string): string
  /** Origin of the KB API server bound to this Playwright project,
   *  e.g. `http://127.0.0.1:3001`. Used by waitForFullDispose to call
   *  the test-only state-reset endpoint (DEC-018 P1-4). */
  apiBaseUrl: string
}

/** Maps the well-known project session name to the env var that holds
 *  the project root path. The mapping mirrors playwright.config.l1.ts. */
const SESSION_TO_ENV: Record<string, string> = {
  'kb-e2e-shared-default': 'KB_E2E_PROJECT_ROOT_DEFAULT',
  'kb-e2e-shared-preonboarding': 'KB_E2E_PROJECT_ROOT_PREONBOARDING',
  'kb-e2e-shared-rich': 'KB_E2E_PROJECT_ROOT_RICH',
}

/** Maps the well-known project session name to the KB API port that
 *  webServer is bound to. Mirrors playwright.config.l1.ts metadata. */
const SESSION_TO_PORT: Record<string, number> = {
  'kb-e2e-shared-default': 3001,
  'kb-e2e-shared-preonboarding': 3002,
  'kb-e2e-shared-rich': 3003,
}

function resolveProjectRoot(sessionName: string): string {
  const envName = SESSION_TO_ENV[sessionName]
  if (!envName) {
    throw new Error(
      `[l1-per-test-setup] Unknown session name: ${sessionName}. ` +
        `Check that playwright.config.l1.ts and SESSION_TO_ENV are in sync.`,
    )
  }
  const value = process.env[envName]
  if (!value) {
    throw new Error(
      `[l1-per-test-setup] env ${envName} is not set. ` +
        `playwright.config.l1.ts must export it before tests run.`,
    )
  }
  return value
}

export const test = base.extend<{ kbFixture: KbFixture }>({
  // Seed the renderer's i18n localStorage key so the UI under test
  // renders in Japanese. The renderer defaults to `en` when no locale
  // is persisted (`src/renderer/i18n/index.ts` `FALLBACK_LOCALE`),
  // and the existing E2E selectors / assertions are written against
  // the Japanese copy. Setting it via `addInitScript` runs the seed
  // before every navigation in this context, so each `page.goto` in
  // a test is greeted by ja text from the very first paint.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('kb.locale', 'ja')
      } catch {
        /* localStorage unavailable */
      }
    })
    await use(page)
  },
  kbFixture: async ({ request }, use, testInfo) => {
    const meta = testInfo.project.metadata as { sessionName?: string }
    const sessionName = meta.sessionName ?? 'kb-e2e-shared-default'
    const projectRoot = resolveProjectRoot(sessionName)

    const snapId = randomBytes(4).toString('hex')

    const livePath = join(projectRoot, '.kovitoboard')
    const snapshotPath = join(projectRoot, `.kovitoboard.snapshot-${snapId}`)

    // `.claude/agents/` is also part of per-test state: tests like S9
    // ("create an agent via the UI wizard") write a fresh
    // `.claude/agents/<id>.json` and do not clean it up themselves. Without
    // restoring this directory, agent-management tests that run later see
    // an inflated agent list whose displayed copy displaces text the
    // assertions rely on (e.g. the "読み取り専用" banner gets pushed off
    // the page text used by toContain).
    const liveAgentsPath = join(projectRoot, '.claude', 'agents')
    const snapshotAgentsPath = join(projectRoot, `.claude.agents.snapshot-${snapId}`)

    // Snapshot the existing `.kovitoboard/` so it can be restored after
    // the test. Blank fixtures may not have one — record that fact so
    // the restore step knows to leave it absent.
    //
    // `logs/` is excluded from the snapshot because the KB logger
    // rotates files mid-snapshot (e.g. `server.2026-05-05.1.log` →
    // `server.2026-05-05.2.log`), which races against `cpSync`'s
    // recursive walk and surfaces as `ENOENT: no such file or directory,
    // lstat ...`. Logs are an output stream rather than test state, so
    // restoring them is unnecessary; leaving the live `logs/` untouched
    // also lets DEC-017's diagnostic flow keep working across tests.
    const hadLive = existsSync(livePath)
    if (hadLive) {
      cpSync(livePath, snapshotPath, {
        recursive: true,
        filter: (src) => !src.includes('/logs/') && !src.endsWith('/logs'),
      })
    }

    const hadAgents = existsSync(liveAgentsPath)
    if (hadAgents) {
      cpSync(liveAgentsPath, snapshotAgentsPath, { recursive: true })
    }

    // Hard-reset the trust-prompt-detector state on the server side
    // before the test runs (DEC-018 §3.1.4 / P1-4). This eliminates the
    // recycled-window-name race deterministically when window names are
    // reused across tests (see waitForFullDispose for the post-dispose
    // counterpart).
    //
    // Await order is strict: we want any 5xx from the endpoint to
    // surface so the test halts before running on a tainted detector.
    // Only network-level failures (typically 404 because the endpoint
    // is gated on KB_E2E_MODE, or ECONNREFUSED while the webServer is
    // still warming up) are tolerated — the response body itself is
    // ignored.
    const apiPort0 = SESSION_TO_PORT[sessionName] ?? 3001
    const resetUrl = `http://127.0.0.1:${apiPort0}/api/admin/test-reset-state`
    try {
      const r = await request.post(resetUrl)
      if (r.status() >= 500) {
        const body = await r.text().catch(() => '<unavailable>')
        throw new Error(
          `[l1-per-test-setup] test-reset-state returned ${r.status()}: ${body}`,
        )
      }
    } catch (err) {
      // Network-level failures (404, ECONNREFUSED, etc.) are tolerated:
      // the endpoint may be 404 if KB_E2E_MODE is unset, and connection
      // refused will resolve naturally as webServer finishes booting.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('returned 5')) throw err
      // Otherwise swallow silently.
    }

    // Window-name suffixing was attempted as an isolation lever but it
    // is not safe to use yet: KB's tmux-bridge resolves windows by
    // agentId, so a tmux window whose name does not match the active
    // agent id breaks message routing back into the window. Instead we
    // keep the window name stable and rely on
    //   - .kovitoboard/ snapshot/restore (this fixture, above)
    //   - waitForFullDispose() in fake-claude-harness (spec teardown)
    // for inter-test isolation. The makeWindowName API is preserved so
    // a future runtime-rebind endpoint (DEC-018 P1-4) can opt in.
    const apiPort = SESSION_TO_PORT[sessionName] ?? 3001
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`

    try {
      await use({
        projectRoot,
        tmuxSession: sessionName,
        makeWindowName: (prefix: string) => prefix,
        apiBaseUrl,
      })
    } finally {
      // Force-dispose any tmux windows the test forgot to clean up.
      // KB's tmux-bridge only manages windows whose names match an
      // active agent id; orphan fake-claude windows (e.g. from a test
      // that threw before reaching `await fake.dispose()`) would
      // otherwise persist into the next test's beforeEach and re-fire
      // a stale trust prompt the moment the detector ticks over them.
      // The `main` window is the session's own bookkeeping window and
      // must be preserved.
      try {
        const list = spawnSync(
          'tmux',
          ['list-windows', '-t', sessionName, '-F', '#{window_name}'],
          { stdio: 'pipe' },
        )
        if (list.status === 0) {
          const names = (list.stdout?.toString() ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter((n) => n && n !== 'main')
          for (const name of names) {
            spawnSync(
              'tmux',
              ['kill-window', '-t', `${sessionName}:${name}`],
              { stdio: 'pipe' },
            )
          }
        }
      } catch (err) {
        console.warn(
          `[l1-per-test-setup] failed to force-dispose tmux windows in ${sessionName}:`,
          err,
        )
      }

      // Reset detector state once more so the next test's beforeEach
      // starts from a clean map even if it runs before a window-discovery
      // tick has had a chance to prune the killed windows above.
      try {
        const r = await request.post(resetUrl)
        if (r.status() >= 500) {
          const body = await r.text().catch(() => '<unavailable>')
          console.warn(
            `[l1-per-test-setup] post-test reset returned ${r.status()}: ${body}`,
          )
        }
      } catch {
        // Tolerate network-level failures — see beforeEach for the rationale.
      }

      try {
        rmSync(livePath, { recursive: true, force: true })
        if (hadLive) {
          cpSync(snapshotPath, livePath, { recursive: true })
          rmSync(snapshotPath, { recursive: true, force: true })
        }
      } catch (err) {
        // Surface restore failures loudly: a half-restored project root
        // will poison every subsequent test in this Playwright project.
        console.warn(
          `[l1-per-test-setup] failed to restore .kovitoboard/ at ${projectRoot}:`,
          err,
        )
      }

      try {
        rmSync(liveAgentsPath, { recursive: true, force: true })
        if (hadAgents) {
          cpSync(snapshotAgentsPath, liveAgentsPath, { recursive: true })
          rmSync(snapshotAgentsPath, { recursive: true, force: true })
        }
      } catch (err) {
        console.warn(
          `[l1-per-test-setup] failed to restore .claude/agents/ at ${projectRoot}:`,
          err,
        )
      }
    }
  },
})

export { expect } from '@playwright/test'
