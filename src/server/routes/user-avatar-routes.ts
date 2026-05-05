/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * User avatar REST API router (Q11 / SM-4 extension).
 *
 * The operator's own avatar lives outside the agent avatar
 * namespace so an agent created with id "user"/"_user"/etc. cannot
 * collide with it. The image is stored at
 * `public/avatars/user/avatar.<ext>` and the relative path is
 * persisted to `setting.json` `user.avatar` so the renderer can
 * resolve it through the existing `<AgentAvatar>` component.
 *
 * POST   /api/settings/user/avatar — Upload (image/png|jpeg|webp|svg+xml, ≤1MB)
 * DELETE /api/settings/user/avatar — Remove the uploaded image
 * GET    /api/settings/user/avatar — Serve the current image (404 when none)
 *
 * Architect §6.9 (DEC entry: Q11 / SM-4) caps the file size at 1MB
 * for the user surface — agents allow 2MB. The cap is applied both
 * at the express.raw limit and inside the handler so the second
 * check still fires when the body bypasses the parser middleware.
 */

import { Router } from 'express'
import express from 'express'
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import {
  deleteUserAvatar,
  getUserAvatarDir,
  resolveUserAvatarPath,
  resolveUserAvatarRelativeName,
  USER_AVATAR_FILE_STEM,
} from '../services/avatar-resolver'
import { readSetting, writeSetting } from '../setting-manager'
import { lazyChildLogger } from '../logger'

const userAvatarLog = lazyChildLogger('user-avatar-routes')

/** Architect §6.9: user avatar upload size cap (smaller than agent's 2MB). */
const MAX_USER_AVATAR_SIZE = 1 * 1024 * 1024
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

/**
 * Update `setting.json` `user.avatar` to the supplied relative path
 * (or null when the user just deleted their avatar). The merge
 * preserves every other top-level block — onboarding /
 * ambientSidebar / versionCheck / locale — so this never undoes
 * earlier setup. Returns false when no setting file exists yet
 * (the operator should finish onboarding first).
 */
function updateSettingAvatar(fs: FileAccessLayer, avatarRelative: string | null): boolean {
  const existing = readSetting(fs)
  if (!existing) return false
  const next = {
    ...existing,
    user: {
      ...existing.user,
      avatar: avatarRelative,
    },
  }
  writeSetting(fs, next)
  return true
}

export function createUserAvatarRouter(fs: FileAccessLayer): Router {
  const router = Router()

  router.post(
    '/avatar',
    express.raw({ type: ['image/*', 'image/svg+xml'], limit: '1mb' }),
    (req, res) => {
      const body = req.body as Buffer
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'Empty file' })
        return
      }
      if (body.length > MAX_USER_AVATAR_SIZE) {
        res.status(413).json({ error: 'File too large (max 1MB)' })
        return
      }

      const contentType = req.headers['content-type'] || ''
      const ext = ALLOWED_CONTENT_TYPES[contentType]
      if (!ext) {
        res.status(400).json({
          error: `Unsupported file type: ${contentType}. Allowed: PNG, JPG, WEBP, SVG`,
        })
        return
      }

      try {
        const userDir = getUserAvatarDir(fs)
        if (!fs.existsSync(userDir)) {
          fs.mkdirSync(userDir, { recursive: true })
        }

        // Reset any previous variant first — keeping a stale .png
        // alongside a fresh .svg makes the resolver pick the wrong
        // file based on the SUPPORTED_EXTS scan order.
        deleteUserAvatar(fs)

        const filePath = join(userDir, `${USER_AVATAR_FILE_STEM}${ext}`)
        fs.writeFileSync(filePath, body)

        const relative = `user/${USER_AVATAR_FILE_STEM}${ext}`
        const persisted = updateSettingAvatar(fs, relative)
        if (!persisted) {
          // Roll back the file so the on-disk state stays in sync
          // with `setting.json` (avoids a "saved" indicator that
          // disappears on next reload because the path was never
          // recorded anywhere).
          deleteUserAvatar(fs)
          res
            .status(409)
            .json({ error: 'setting.json is missing — complete onboarding first' })
          return
        }

        res.json({ success: true, path: `/avatars/${relative}` })
      } catch (err) {
        userAvatarLog.error({ err }, 'User avatar upload failed')
        res.status(500).json({ error: 'Failed to save avatar' })
      }
    },
  )

  router.delete('/avatar', (_req, res) => {
    try {
      const deleted = deleteUserAvatar(fs)
      // Always clear the persisted path so the renderer falls back
      // to the auto-generated SVG, even if no file was on disk
      // (e.g. setting.json drifted because of a manual edit).
      const persisted = updateSettingAvatar(fs, null)
      if (!persisted) {
        res
          .status(409)
          .json({ error: 'setting.json is missing — complete onboarding first' })
        return
      }
      if (!deleted) {
        // Match the agent avatar route's contract: 404 makes it easy
        // to distinguish "no upload yet" from "delete failed".
        res.status(404).json({ error: 'No user avatar found' })
        return
      }
      res.json({ success: true })
    } catch (err) {
      userAvatarLog.error({ err }, 'User avatar delete failed')
      res.status(500).json({ error: 'Failed to delete avatar' })
    }
  })

  router.get('/avatar', (_req, res) => {
    const avatarPath = resolveUserAvatarPath(fs)
    if (!avatarPath) {
      res.status(404).json({ error: 'No avatar found' })
      return
    }
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(avatarPath, (err) => {
      if (err) {
        userAvatarLog.error({ err, avatarPath }, 'User avatar sendFile failed')
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read avatar' })
        }
      }
    })
  })

  return router
}

export { resolveUserAvatarRelativeName }
