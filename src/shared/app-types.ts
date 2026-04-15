/**
 * Stable API: app/ extension type definitions.
 *
 * These types define the contract between KovitoBoard core (src/)
 * and user extensions (app/). They are guaranteed to be backward-compatible
 * within the same major version.
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 */

// ─── Menu Registration ───

/**
 * Metadata for a user-defined menu entry (React-independent).
 * Used by the recipe system and server-side code.
 *
 * For the full renderer-side type (with `component` field),
 * see src/renderer/types/app-types.ts.
 */
export interface AppMenuEntryMeta {
  /** Unique page ID. Routes to /ext/{id} */
  id: string
  /** Display label for the nav menu */
  label: string
  /** Key from NavMenu Icons dictionary. Falls back to 'folder'. */
  icon: string
}

// ─── API Extension ───

/**
 * Convention for app/api/*.ts files:
 * - Must `export default` an Express Router
 * - Mounted at /api/ext/{filename-without-extension}
 * - Files starting with '_' are skipped (helper convention)
 */
export const APP_API_MOUNT_PREFIX = '/api/ext' as const

/**
 * Convention for app/pages/*.tsx files:
 * - Must `export default` a React component
 * - Routed at /ext/{menu-entry-id}
 */
export const APP_PAGE_ROUTE_PREFIX = '/ext' as const

// ─── Directory conventions ───

/** Allowed artifact placement directories under app/ */
export const APP_DIRECTORIES = {
  pages: 'pages',
  styles: 'styles',
  api: 'api',
  lib: 'lib',
  hooks: 'hooks',
  utils: 'utils',
} as const
