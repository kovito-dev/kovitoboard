/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * L1 Global Teardown — Clean up the template-cache directory
 *
 * Removes the template-cache directory created at config-load time
 * in playwright.config.l1.ts. Set KB_E2E_KEEP_TMP=1 to skip cleanup
 * for debugging.
 *
 * @see docs/design/e2e-l1-harness-extension.md §6-4
 */
import { rm } from 'node:fs/promises'

export default async function globalTeardown(): Promise<void> {
  const cacheDir = process.env.KB_E2E_TEMPLATE_CACHE ?? process.env.KB_E2E_ROOT
  if (!cacheDir) return

  if (process.env.KB_E2E_KEEP_TMP === '1') {
    console.log(`[l1-global-teardown] Keeping tmp dir: ${cacheDir}`)
    return
  }

  try {
    await rm(cacheDir, { recursive: true, force: true })
    console.log(`[l1-global-teardown] Cleaned up: ${cacheDir}`)
  } catch (err) {
    console.warn(`[l1-global-teardown] Failed to clean up ${cacheDir}:`, err)
  }
}
