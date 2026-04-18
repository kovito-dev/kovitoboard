/**
 * L1 Global Setup — Logging only
 *
 * Fixture expansion is handled synchronously in playwright.config.l1.ts
 * because Playwright evaluates webServer.env before globalSetup runs.
 * This module only logs the fixture location for debugging.
 *
 * @see docs/design/e2e-l1-harness-extension.md §6-2
 */

export default async function globalSetup(): Promise<void> {
  const rootDir = process.env.KB_E2E_ROOT
  if (rootDir) {
    console.log(`[l1-global-setup] Fixtures at: ${rootDir}`)
  }
}
