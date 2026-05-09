/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Playwright L1 Configuration — Fake Claude E2E tests
 *
 * Defines 3 Playwright projects, each with its own webServer instance
 * and project fixture.
 *
 * Projects:
 *   l1-default         — blank-onboarded fixture (most tests)
 *   l1-preonboarding   — blank fixture (onboarding flow tests)
 *   l1-rich-completed  — existing-rich fixture (@rich-project tagged tests)
 *
 * Fixture expansion runs synchronously at config load time because
 * Playwright evaluates webServer.env before globalSetup executes
 * (i.e. globalSetup cannot supply paths that webServer.env requires).
 * The expanded directory acts as the **template-cache** referenced by
 * DEC-018 §3.3 — the cache is populated once per Playwright run, and
 * per-test isolation is provided by `helpers/l1-per-test-setup.ts`
 * which snapshots/restores `.kovitoboard/` and assigns unique tmux
 * window names.
 *
 * Master / worker cache sharing
 * -----------------------------
 * Playwright re-imports this config in every worker process it forks,
 * so a naive `mkdtempSync` / `prepareFixtureSync` would create a fresh
 * tmpdir per worker — leaving the webServer (started from the master's
 * config evaluation) bound to one path while workers see a different
 * one. The snapshot/restore in `l1-per-test-setup.ts` would silently
 * become a no-op because it operates on a directory KB never reads.
 *
 * The fix:
 *   - Master evaluates the config first and `mkdtempSync` allocates
 *     the canonical tmpdir, then exposes it via env (`KB_E2E_TEMPLATE_CACHE`
 *     and the per-template path env vars).
 *   - Workers inherit that env from master (Node `child_process`
 *     defaults), so their config re-import sees the env already set
 *     and skips `mkdtempSync` + `prepareFixtureSync`. Both ends of the
 *     run therefore agree on a single fixture root.
 *   - `globalTeardown` is the only place that removes the tmpdir, so
 *     skipping `prepareFixtureSync` in workers cannot cause double-free.
 *
 * @see docs/design/e2e-l1-harness-extension.md §4-3
 * @see docs/design/decisions/DEC-018-test-quality-assurance-strategy.md
 */
import { defineConfig } from '@playwright/test'
import { cpSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_ROOT = resolve(__dirname, 'tests', 'fixtures', 'projects')

type Template = 'blank' | 'blank-onboarded' | 'existing-rich'

function prepareFixtureSync(rootDir: string, name: string, template: Template): string {
  const dest = join(rootDir, name)
  cpSync(join(FIXTURES_ROOT, template), dest, { recursive: true })

  // Patch setting.json with actual path
  const settingPath = join(dest, '.kovitoboard', 'setting.json')
  try {
    const raw = readFileSync(settingPath, 'utf-8')
    const data = JSON.parse(raw)
    if (data.project) data.project.path = dest
    writeFileSync(settingPath, JSON.stringify(data, null, 2))
  } catch {
    // blank template has no setting.json
  }

  return dest
}

// Expand the template-cache once per Playwright run.
// Synchronous execution is required because Playwright captures
// webServer.env at config-load time, before globalSetup runs.
//
// Master (the first `playwright test` process to import this file)
// allocates the cache dir and expands fixtures. Workers re-import the
// config in their forked Node process; they detect the master-prepared
// state via inherited env and reuse the existing paths instead of
// running `mkdtempSync` + `prepareFixtureSync` again.
const ALREADY_PREPARED = process.env.KB_E2E_TEMPLATE_CACHE !== undefined
const TEMPLATE_CACHE =
  process.env.KB_E2E_TEMPLATE_CACHE ?? mkdtempSync(join(tmpdir(), 'kb-e2e-template-'))
const PROJECT_ROOT_DEFAULT = ALREADY_PREPARED
  ? (process.env.KB_E2E_PROJECT_ROOT_DEFAULT ?? join(TEMPLATE_CACHE, 'default'))
  : prepareFixtureSync(TEMPLATE_CACHE, 'default', 'blank-onboarded')
const PROJECT_ROOT_PREONBOARDING = ALREADY_PREPARED
  ? (process.env.KB_E2E_PROJECT_ROOT_PREONBOARDING ?? join(TEMPLATE_CACHE, 'preonboarding'))
  : prepareFixtureSync(TEMPLATE_CACHE, 'preonboarding', 'blank')
const PROJECT_ROOT_RICH = ALREADY_PREPARED
  ? (process.env.KB_E2E_PROJECT_ROOT_RICH ?? join(TEMPLATE_CACHE, 'rich'))
  : prepareFixtureSync(TEMPLATE_CACHE, 'rich', 'existing-rich')

// Export env for globalSetup/teardown and per-test helpers.
// KB_E2E_TEMPLATE_CACHE is the canonical name introduced by DEC-018.
// KB_E2E_ROOT is retained as an alias for backwards compatibility.
//
// On master (`!ALREADY_PREPARED`) we always (re)export so the values
// reflect the freshly-allocated paths. On workers (`ALREADY_PREPARED`)
// the env is already populated by master via process inheritance, so
// re-assigning would be a no-op — we keep the assignment unconditional
// for clarity.
process.env.KB_E2E_TEMPLATE_CACHE = TEMPLATE_CACHE
process.env.KB_E2E_ROOT = TEMPLATE_CACHE
process.env.KB_E2E_PROJECT_ROOT_DEFAULT = PROJECT_ROOT_DEFAULT
process.env.KB_E2E_PROJECT_ROOT_PREONBOARDING = PROJECT_ROOT_PREONBOARDING
process.env.KB_E2E_PROJECT_ROOT_RICH = PROJECT_ROOT_RICH

// Per-launch auth token (KB_LAUNCH_TOKEN) — production code mints a
// fresh value per supervisor launch; in L1 we hard-code a deterministic
// test token so every webServer process and every Playwright worker
// agree on the same value. The Vite plugin embeds it into index.html
// so the renderer's kbFetch helper picks it up like in real life.
const E2E_LAUNCH_TOKEN = '0123456789abcdef0123456789abcdef'
process.env.KB_LAUNCH_TOKEN = E2E_LAUNCH_TOKEN

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,

  // Force serial execution. Without this, Playwright defaults to a
  // worker count derived from the host CPU and runs spec files in
  // parallel; with the three L1 projects sharing one KB server per
  // project port, an orphan tmux window left by an earlier spec is
  // observed simultaneously by every parallel spec that hits the same
  // port (trust-prompt-detector broadcasts to all connected clients).
  // Serializing eliminates that shared-orphan vector — any orphan can
  // only leak from the test that immediately preceded the current one,
  // which the per-test setup hooks are already designed to handle.
  //
  // The expected runtime cost is ~4-6 minutes for a full L1 run (vs
  // ~1 min when running in parallel). CI impact is currently nil
  // because the `l1-e2e` job is disabled (DEC-022). Re-evaluate when
  // the job is re-enabled (BL-2026-083) — at that point a CI-only
  // override (e.g. `process.env.CI ? 1 : undefined`) may be worth
  // considering.
  workers: 1,

  // globalSetup is kept only for logging; fixture expansion is done above
  globalSetup: './tests/e2e/helpers/l1-global-setup.ts',
  globalTeardown: './tests/e2e/helpers/l1-global-teardown.ts',

  use: {
    // `retries: 0` is enforced by DEC-018 §Q3, so 'on-first-retry' would
    // never produce a trace. Use 'retain-on-failure' instead so the
    // playwright-trace-l1 artifact uploaded on CI actually contains a
    // trace.zip per failed test (DEC-018 design §4.3).
    trace: 'retain-on-failure',
    // Attach the per-launch auth token to every Playwright-issued
    // request so spec files can use both the test-level `request`
    // fixture and `page.request` for `/api/*` calls without
    // threading the header through manually. The renderer itself
    // gets the same value through the meta tag injected into
    // `index.html` by the Vite dev plugin.
    //
    // Cross-origin leak considered and accepted: this configuration
    // would also attach the header to a `page.goto('https://...')`
    // navigation, but the L1 suite is structurally local-only —
    // every webServer is `http://127.0.0.1:<port>`, every spec
    // reaches the renderer via the project `baseURL`, and there is
    // no third-party asset / external navigation in any test. A
    // future spec that introduces an external navigation must
    // either drop `use.extraHTTPHeaders` for that scenario or scope
    // the header to a per-request fixture.
    extraHTTPHeaders: {
      'X-Kovitoboard-Token': E2E_LAUNCH_TOKEN,
    },
  },

  projects: [
    {
      name: 'l1-default',
      use: {
        baseURL: 'http://localhost:5174',
      },
      metadata: {
        projectState: 'blank',
        onboardingState: 'completed',
        port: 3001,
        vitePort: 5174,
        sessionName: 'kb-e2e-shared-default',
      },
      // Exclude tests tagged for other projects
      grepInvert: /@rich-project|@preonboarding/,
    },
    {
      name: 'l1-preonboarding',
      use: {
        baseURL: 'http://localhost:5175',
      },
      metadata: {
        projectState: 'blank',
        onboardingState: 'preonboarding',
        port: 3002,
        vitePort: 5175,
        sessionName: 'kb-e2e-shared-preonboarding',
      },
      grep: /@preonboarding/,
    },
    {
      name: 'l1-rich-completed',
      use: {
        baseURL: 'http://localhost:5176',
      },
      metadata: {
        projectState: 'existing-rich',
        onboardingState: 'completed',
        port: 3003,
        vitePort: 5176,
        sessionName: 'kb-e2e-shared-rich',
      },
      grep: /@rich-project/,
    },
  ],

  webServer: [
    {
      command: 'npm run dev',
      // Probe via the Vite-served HTML (token-free) instead of an API
      // route — every `/api/*` path now requires the launch token, so
      // the readiness check would otherwise see a 401 before the test
      // even starts.
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: '3001',
        VITE_PORT: '5174',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-default',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_DEFAULT,
        // Enable the test-only state-reset endpoint (DEC-018 P1-4).
        KB_E2E_MODE: '1',
        // Suppress GitHub Releases polls for the version-display feature
        // (v0.1.0-version-display.md §3.3) — keeps L1 deterministic and
        // free of outbound network calls.
        KOVITO_NO_VERSION_CHECK: '1',
        KB_LAUNCH_TOKEN: E2E_LAUNCH_TOKEN,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5175/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: '3002',
        VITE_PORT: '5175',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-preonboarding',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_PREONBOARDING,
        KB_E2E_MODE: '1',
        KB_LAUNCH_TOKEN: E2E_LAUNCH_TOKEN,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5176/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: '3003',
        VITE_PORT: '5176',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-rich',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_RICH,
        KB_E2E_MODE: '1',
        KB_LAUNCH_TOKEN: E2E_LAUNCH_TOKEN,
      },
    },
  ],
})
