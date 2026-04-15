import { join, basename } from 'path'
import type { Express } from 'express'
import type { FileAccessLayer } from './fs-layer'
import { resolveProjectRoot } from './config'

/**
 * Scan app/api/ directory and mount each file as an Express Router
 * under /api/ext/{filename-without-extension}.
 *
 * - Files starting with '_' are skipped (convention for helpers/shared modules).
 * - Each file must export default as an Express Router.
 * - Gracefully handles missing app/api/ directory.
 */
export async function mountAppApiRoutes(
  app: Express,
  fs: FileAccessLayer,
): Promise<void> {
  const projectRoot = resolveProjectRoot(fs)
  const apiDir = join(projectRoot, 'app', 'api')

  if (!fs.existsSync(apiDir)) {
    return // No app/api/ directory — nothing to mount
  }

  const files = fs.readdirSync(apiDir)
  for (const file of files) {
    // Skip non-.ts/.js files and _ prefixed files
    if (!/\.(ts|js)$/.test(file) || file.startsWith('_')) continue

    const routeName = basename(file).replace(/\.(ts|js)$/, '')
    const filePath = join(apiDir, file)
    const mountPath = `/api/ext/${routeName}`

    try {
      const mod = await import(filePath)
      const router = mod.default
      if (!router) {
        console.warn(`[app-api] ${file}: no default export, skipping`)
        continue
      }
      app.use(mountPath, router)
      console.log(`[app-api] Mounted: ${mountPath} ← app/api/${file}`)
    } catch (err) {
      console.error(`[app-api] Failed to load ${file}:`, err)
    }
  }
}
