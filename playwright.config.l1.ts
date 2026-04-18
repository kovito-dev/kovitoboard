/**
 * Playwright L1 Configuration — Fake Claude E2E tests
 *
 * Defines 3 Playwright projects, each with its own webServer instance
 * and project fixture (expanded by l1-global-setup.ts).
 *
 * Projects:
 *   l1-default         — blank-onboarded fixture (most tests)
 *   l1-preonboarding   — blank fixture (onboarding flow tests)
 *   l1-rich-completed  — existing-rich fixture (@rich-project tagged tests)
 *
 * @see docs/design/e2e-l1-harness-extension.md §4-3
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,

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
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared',
        KOVITOBOARD_PROJECT_ROOT: process.env.KB_E2E_PROJECT_ROOT_DEFAULT || '',
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
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared',
        KOVITOBOARD_PROJECT_ROOT: process.env.KB_E2E_PROJECT_ROOT_PREONBOARDING || '',
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
        KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared',
        KOVITOBOARD_PROJECT_ROOT: process.env.KB_E2E_PROJECT_ROOT_RICH || '',
      },
    },
  ],
})
