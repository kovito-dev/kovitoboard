/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
 * Directory for the operator's own avatar (Q11 / SM-4 user avatar).
 *
 * Kept on a separate sub-tree (`public/avatars/user/`) so it cannot
 * collide with an agent created with the literal id "user" / "_user"
 * etc. The agent and user avatar surfaces resolve through entirely
 * different helpers; this directory is only ever read or written via
 * the user-avatar router.
 */
export function getUserAvatarDir(fs: FileAccessLayer): string {
  return join(getAvatarsBaseDir(fs), 'user')
}

/** Fixed file stem inside `getUserAvatarDir()`. */
export const USER_AVATAR_FILE_STEM = 'avatar'

/**
 * Locate the operator's avatar file (any supported extension) and
 * return the absolute path. Returns null when the user has not
 * uploaded one yet.
 */
export function resolveUserAvatarPath(fs: FileAccessLayer): string | null {
  return findImageInDir(fs, getUserAvatarDir(fs), USER_AVATAR_FILE_STEM)
}

/**
 * Resolve the user's avatar to a slash-delimited sub-path under
 * `public/avatars/`, e.g. `user/avatar.png`. Mirrors
 * `resolveAvatarRelativeName` for agents so renderer code can prepend
 * `/avatars/` and obtain a working URL. Returns null when no upload
 * exists yet.
 */
export function resolveUserAvatarRelativeName(fs: FileAccessLayer): string | null {
  const dir = getUserAvatarDir(fs)
  if (!fs.existsSync(dir)) return null
  for (const ext of SUPPORTED_EXTS) {
    if (fs.existsSync(join(dir, `${USER_AVATAR_FILE_STEM}${ext}`))) {
      return `user/${USER_AVATAR_FILE_STEM}${ext}`
    }
  }
  return null
}

/**
 * Delete every supported-extension variant of the user's avatar in
 * `getUserAvatarDir()`. Returns true when at least one file was
 * removed (mirrors `deleteCustomAvatar` for agents).
 */
export function deleteUserAvatar(fs: FileAccessLayer): boolean {
  const dir = getUserAvatarDir(fs)
  if (!fs.existsSync(dir)) return false

  let deleted = false
  for (const ext of SUPPORTED_EXTS) {
    const filePath = join(dir, `${USER_AVATAR_FILE_STEM}${ext}`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      deleted = true
    }
  }
  return deleted
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
 * Resolve the avatar file name as a path relative to the `public/avatars/`
 * root, e.g. `default/kovito-concierge.svg` or `custom/my-agent.png`.
 *
 * The renderer's <AgentAvatar> component prepends `/avatars/` to the
 * value, so we must return the slash-delimited sub-path only (no
 * leading slash, no absolute URL).
 *
 * Returns null if no avatar file exists.
 */
export function resolveAvatarRelativeName(fs: FileAccessLayer, agentName: string): string | null {
  for (const scope of ['custom', 'default'] as const) {
    const dir = scope === 'custom' ? getCustomDir(fs) : getDefaultDir(fs)
    if (!fs.existsSync(dir)) continue
    for (const ext of SUPPORTED_EXTS) {
      if (fs.existsSync(join(dir, `${agentName}${ext}`))) {
        return `${scope}/${agentName}${ext}`
      }
    }
  }
  return null
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
