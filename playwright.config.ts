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
      // Fake Claude E2E テスト用: tmux-bridge が参照するセッション名を固定
      // @see docs/design/fake-claude-design.md §5-3 方式 A
      KOVITOBOARD_E2E_TMUX_SESSION: 'kb-e2e-shared',
    },
  },
})
