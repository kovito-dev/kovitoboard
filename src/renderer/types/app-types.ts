/**
 * Type definitions for the app/ extension system.
 * Renderer-only — these types are NOT imported by server code
 * because the `component` field depends on React types.
 */

/** A single user-defined menu entry from app/menu.ts */
export interface AppMenuEntry {
  /** Unique page ID. Used as route parameter: /ext/{id} */
  id: string
  /** Display label for the nav menu */
  label: string
  /** Key from NavMenu Icons dictionary (e.g., 'content', 'dashboard'). Falls back to 'folder'. */
  icon: string
  /** Dynamic import function returning the page component (must use export default) */
  component: () => Promise<{ default: React.ComponentType }>
}

/** The shape exported by app/menu.ts */
export interface AppMenuModule {
  menuEntries: AppMenuEntry[]
}
