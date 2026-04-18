/**
 * 設定 API ルーター
 *
 * GET  /api/config/setting  — KovitoBoard 設定の取得
 * PUT  /api/config/setting  — KovitoBoard 設定の更新
 */
import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting, writeSetting, validateSetting } from '../setting-manager'

export function createConfigRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // GET /api/config/setting
  router.get('/setting', (_req, res) => {
    const setting = readSetting(fs)
    if (!setting) {
      res.json(null)
      return
    }
    res.json(setting)
  })

  // PUT /api/config/setting
  router.put('/setting', (req, res) => {
    const body = req.body
    if (!validateSetting(body)) {
      res.status(400).json({ error: 'Invalid setting data' })
      return
    }
    try {
      writeSetting(fs, body)
      res.json({ success: true })
    } catch (err) {
      console.error('[config-routes] Failed to write setting:', err)
      res.status(500).json({ error: 'Failed to write setting' })
    }
  })

  return router
}
