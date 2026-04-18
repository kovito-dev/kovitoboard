/**
 * L1 Global Teardown — Clean up temporary fixture directories
 *
 * Removes the temporary root directory created by l1-global-setup.ts.
 * Set KB_E2E_KEEP_TMP=1 to skip cleanup for debugging.
 *
 * @see docs/design/e2e-l1-harness-extension.md §6-4
 */
import { rm } from 'node:fs/promises'

export default async function globalTeardown(): Promise<void> {
  const rootDir = process.env.KB_E2E_ROOT
  if (!rootDir) return

  if (process.env.KB_E2E_KEEP_TMP === '1') {
    console.log(`[l1-global-teardown] Keeping tmp dir: ${rootDir}`)
    return
  }

  try {
    await rm(rootDir, { recursive: true, force: true })
    console.log(`[l1-global-teardown] Cleaned up: ${rootDir}`)
  } catch (err) {
    console.warn(`[l1-global-teardown] Failed to clean up ${rootDir}:`, err)
  }
}
