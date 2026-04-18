/**
 * エージェントアバター画像の REST API ルーター
 *
 * POST   /api/agents/:name/avatar — アバターアップロード
 * DELETE /api/agents/:name/avatar — カスタムアバター削除
 * GET    /api/agents/:name/avatar — アバター解決（ファイル配信）
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

/** エージェント名バリデーション（ディレクトリトラバーサル防止） */
function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

export function createAvatarRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // POST /api/agents/:name/avatar — アバターアップロード
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

        // 既存の同名ファイルを全拡張子分削除（1エージェント1画像の原則）
        deleteCustomAvatar(fs, agentName)

        // 新しい画像を保存
        const filePath = join(customDir, `${agentName}${ext}`)
        fs.writeFileSync(filePath, body)

        res.json({ success: true, path: `/avatars/custom/${agentName}${ext}` })
      } catch (err) {
        console.error('[avatar-routes] Upload failed:', err)
        res.status(500).json({ error: 'Failed to save avatar' })
      }
    },
  )

  // DELETE /api/agents/:name/avatar — アバター削除（custom のみ）
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

  // GET /api/agents/:name/avatar — アバター解決（ファイル配信）
  // custom -> default -> 404（フロントエンドがフォールバック SVG を生成）
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

    // res.sendFile は絶対パスが必要（resolveAvatarPath は絶対パスを返す）
    // Cache-Control: no-cache でアップロード後の即時反映を保証
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
