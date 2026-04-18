import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3001/api/config',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      // For Fake Claude E2E tests: pin the tmux session name referenced by tmux-bridge
      // @see docs/design/fake-claude-design.md §5-3 approach A
      KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared',
    },
  },
})
