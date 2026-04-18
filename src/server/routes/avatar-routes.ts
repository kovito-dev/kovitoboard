/**
 * Agent avatar image REST API router
 *
 * POST   /api/agents/:name/avatar — Upload avatar
 * DELETE /api/agents/:name/avatar — Delete custom avatar
 * GET    /api/agents/:name/avatar — Resolve and serve avatar file
 */

import { Router } from 'express'
import express from 'express'
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { resolveAvatarPath, getCustomDir, deleteCustomAvatar } from '../services/avatar-resolver'

const MAX_AVATAR_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

/** Validate agent name (prevent directory traversal) */
function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

export function createAvatarRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // POST /api/agents/:name/avatar — Upload avatar
  router.post(
    '/:name/avatar',
    express.raw({ type: ['image/*', 'image/svg+xml'], limit: '2mb' }),
    (req, res) => {
      const agentName = req.params.name

      if (!isValidAgentName(agentName)) {
        res.status(400).json({ error: 'Invalid agent name' })
        return
      }

      const body = req.body as Buffer
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'Empty file' })
        return
      }
      if (body.length > MAX_AVATAR_SIZE) {
        res.status(413).json({ error: 'File too large (max 2MB)' })
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
        const customDir = getCustomDir(fs)
        if (!fs.existsSync(customDir)) {
          fs.mkdirSync(customDir, { recursive: true })
        }

        // Delete existing files with all extensions (one image per agent policy)
        deleteCustomAvatar(fs, agentName)

        // Save the new image
        const filePath = join(customDir, `${agentName}${ext}`)
        fs.writeFileSync(filePath, body)

        res.json({ success: true, path: `/avatars/custom/${agentName}${ext}` })
      } catch (err) {
        console.error('[avatar-routes] Upload failed:', err)
        res.status(500).json({ error: 'Failed to save avatar' })
      }
    },
  )

  // DELETE /api/agents/:name/avatar — Delete avatar (custom only)
  router.delete('/:name/avatar', (req, res) => {
    const agentName = req.params.name
    if (!isValidAgentName(agentName)) {
      res.status(400).json({ error: 'Invalid agent name' })
      return
    }

    try {
      const deleted = deleteCustomAvatar(fs, agentName)
      if (!deleted) {
        res.status(404).json({ error: 'No custom avatar found' })
        return
      }
      res.json({ success: true })
    } catch (err) {
      console.error('[avatar-routes] Delete failed:', err)
      res.status(500).json({ error: 'Failed to delete avatar' })
    }
  })

  // GET /api/agents/:name/avatar — Resolve and serve avatar file
  // custom -> default -> 404 (frontend generates fallback SVG)
  router.get('/:name/avatar', (req, res) => {
    const agentName = req.params.name
    if (!isValidAgentName(agentName)) {
      res.status(400).json({ error: 'Invalid agent name' })
      return
    }

    const avatarPath = resolveAvatarPath(fs, agentName)
    if (!avatarPath) {
      res.status(404).json({ error: 'No avatar found' })
      return
    }

    // res.sendFile requires an absolute path (resolveAvatarPath returns one)
    // Cache-Control: no-cache ensures immediate reflection after upload
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(avatarPath, (err) => {
      if (err) {
        console.error('[avatar-routes] sendFile failed:', err)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read avatar' })
        }
      }
    })
  })

  return router
}
