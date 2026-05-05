/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 Global Setup — Logging only
 *
 * Fixture expansion (the **template-cache** referenced by DEC-018 §3.3)
 * is handled synchronously in playwright.config.l1.ts because Playwright
 * captures webServer.env at config-load time, before globalSetup runs.
 * Moving the expansion into globalSetup is therefore not possible — by
 * the time globalSetup executes, webServer has already been started with
 * stale env values.
 *
 * Per-test isolation is supplied by `helpers/l1-per-test-setup.ts` which
 * snapshots/restores `.kovitoboard/` and assigns unique tmux window names
 * per test (see DEC-018 §3.4 case C).
 *
 * @see docs/design/e2e-l1-harness-extension.md §6-2
 * @see docs/design/decisions/DEC-018-test-quality-assurance-strategy.md
 */

export default async function globalSetup(): Promise<void> {
  const cacheDir = process.env.KB_E2E_TEMPLATE_CACHE ?? process.env.KB_E2E_ROOT
  if (cacheDir) {
    console.log(`[l1-global-setup] Template cache: ${cacheDir}`)
  }
}
