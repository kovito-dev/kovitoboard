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
 * Playwright evaluates webServer.env before globalSetup executes.
 *
 * @see docs/design/e2e-l1-harness-extension.md §4-3
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

// Expand fixtures synchronously so env values are available for webServer config
const rootDir = mkdtempSync(join(tmpdir(), 'kb-e2e-'))
const PROJECT_ROOT_DEFAULT = prepareFixtureSync(rootDir, 'default', 'blank-onboarded')
const PROJECT_ROOT_PREONBOARDING = prepareFixtureSync(rootDir, 'preonboarding', 'blank')
const PROJECT_ROOT_RICH = prepareFixtureSync(rootDir, 'rich', 'existing-rich')

// Export env for globalSetup/teardown access
process.env.KB_E2E_ROOT = rootDir
process.env.KB_E2E_PROJECT_ROOT_DEFAULT = PROJECT_ROOT_DEFAULT
process.env.KB_E2E_PROJECT_ROOT_PREONBOARDING = PROJECT_ROOT_PREONBOARDING
process.env.KB_E2E_PROJECT_ROOT_RICH = PROJECT_ROOT_RICH

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,

  // globalSetup is kept only for logging; fixture expansion is done above
  globalSetup: './tests/e2e/helpers/l1-global-setup.ts',
  globalTeardown: './tests/e2e/helpers/l1-global-teardown.ts',

  use: {
    trace: 'on-first-retry',
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
      url: 'http://127.0.0.1:3001/api/config',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PORT: '3001',
        VITE_PORT: '5174',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-default',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_DEFAULT,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3002/api/config',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PORT: '3002',
        VITE_PORT: '5175',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-preonboarding',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_PREONBOARDING,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3003/api/config',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PORT: '3003',
        VITE_PORT: '5176',
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared-rich',
        KOVITOBOARD_PROJECT_ROOT: PROJECT_ROOT_RICH,
      },
    },
  ],
})
