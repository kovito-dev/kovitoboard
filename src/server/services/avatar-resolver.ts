/**
 * Agent avatar image resolution logic with priority ordering
 *
 * Scans the filesystem in custom -> default order to locate avatar images.
 * - custom: User-uploaded images (public/avatars/custom/)
 * - default: Built-in default avatars (public/avatars/default/, git-managed)
 * - If neither exists, returns null (frontend SVG generator provides the fallback)
 */

import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import type { FileAccessLayer } from '../fs-layer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPPORTED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg']

/**
 * Resolve the avatars directory path.
 * dev: src/server/services/ -> ../../../public/avatars
 * build: dist/server/services/ -> ../../avatars (public copied by vite into dist/)
 *
 * In dev mode the built dist does not exist, so ../../public/avatars is also tried as a fallback.
 */
function getAvatarsBaseDir(fs: FileAccessLayer): string {
  const candidates = [
    resolve(__dirname, '../../../public/avatars'),  // dev
    resolve(__dirname, '../../avatars'),             // build (dist/avatars/)
  ]
  return candidates.find(d => fs.existsSync(d)) || candidates[0]
}

export function getCustomDir(fs: FileAccessLayer): string {
  return join(getAvatarsBaseDir(fs), 'custom')
}

export function getDefaultDir(fs: FileAccessLayer): string {
  return join(getAvatarsBaseDir(fs), 'default')
}

/**
 * Resolve the avatar image path for a given agent name.
 * Searches custom -> default in order. Returns null if not found.
 */
export function resolveAvatarPath(fs: FileAccessLayer, agentName: string): string | null {
  // Search the custom directory first
  const customDir = getCustomDir(fs)
  const customPath = findImageInDir(fs, customDir, agentName)
  if (customPath) return customPath

  // Fall back to default directory
  const defaultDir = getDefaultDir(fs)
  return findImageInDir(fs, defaultDir, agentName)
}

/**
 * Find a file matching agentName.{ext} in the specified directory
 */
function findImageInDir(fs: FileAccessLayer, dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null
  for (const ext of SUPPORTED_EXTS) {
    const filePath = join(dir, `${name}${ext}`)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

/**
 * Delete all agentName.* files in the custom directory (including different extensions)
 */
export function deleteCustomAvatar(fs: FileAccessLayer, agentName: string): boolean {
  const customDir = getCustomDir(fs)
  if (!fs.existsSync(customDir)) return false

  let deleted = false
  for (const ext of SUPPORTED_EXTS) {
    const filePath = join(customDir, `${agentName}${ext}`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      deleted = true
    }
  }
  return deleted
}
