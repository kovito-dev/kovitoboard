/**
 * Stable API: Frontend extension loader.
 *
 * Discovers and loads user-defined menu entries and styles from app/.
 * These functions are the sole entry points for FE extensions.
 *
 * Public interface:
 *   - loadUserMenuEntries(): Promise<AppMenuEntry[]>
 *   - loadUserStyles(): Promise<void>
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 */

import type { AppMenuEntry, AppMenuModule } from './types/app-types'

/**
 * Discover and load user menu entries from app/menu.ts.
 * import.meta.glob returns an empty object if the file doesn't exist,
 * so this gracefully handles a missing app/ directory.
 */
export async function loadUserMenuEntries(): Promise<AppMenuEntry[]> {
  const modules = import.meta.glob<AppMenuModule>('../../app/menu.{ts,tsx}')

  const paths = Object.keys(modules)
  if (paths.length === 0) return []

  try {
    const mod = await modules[paths[0]]()
    return mod.menuEntries ?? []
  } catch (err) {
    console.warn('[app-loader] Failed to load app/menu:', err)
    return []
  }
}

/**
 * Discover and load all user CSS from app/styles/.
 * Each matched CSS file is imported as a side effect.
 */
export async function loadUserStyles(): Promise<void> {
  const styles = import.meta.glob('../../app/styles/**/*.css')

  for (const path of Object.keys(styles)) {
    try {
      await styles[path]()
    } catch (err) {
      console.warn(`[app-loader] Failed to load style ${path}:`, err)
    }
  }
}
