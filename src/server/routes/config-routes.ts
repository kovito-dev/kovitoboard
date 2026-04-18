/**
 * 設定 API ルーター
 *
 * GET  /api/config/setting       — KovitoBoard 設定の取得
 * PUT  /api/config/setting       — KovitoBoard 設定の更新
 * POST /api/config/setup-agent-ref — agent-ref シンボリックリンク作成
 */
import { Router } from 'express'
import { join, resolve } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting, writeSetting, validateSetting } from '../setting-manager'
import { resolveProjectRoot } from '../config'

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

  // POST /api/config/setup-agent-ref
  // KovitoBoard の docs/agent-ref/ を親プロジェクトにシンボリックリンクする
  router.post('/setup-agent-ref', (_req, res) => {
    try {
      const projectRoot = resolveProjectRoot(fs)
      const kbRoot = resolve(projectRoot, 'kovitoboard')
      const source = join(kbRoot, 'docs', 'agent-ref')
      const targetDir = join(projectRoot, 'docs')
      const targetLink = join(targetDir, 'agent-ref')

      // source が存在しない場合はスキップ
      if (!fs.existsSync(source)) {
        res.json({ success: true, skipped: true, reason: 'source docs/agent-ref/ not found' })
        return
      }

      // target が既に存在する場合はスキップ（既存ファイルを壊さない）
      if (fs.existsSync(targetLink)) {
        res.json({ success: true, skipped: true, reason: 'docs/agent-ref/ already exists' })
        return
      }

      // docs/ ディレクトリがなければ作成
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }

      // シンボリックリンク作成
      fs.symlinkSync(source, targetLink, 'dir')
      res.json({ success: true, skipped: false, link: targetLink, target: source })
    } catch (err) {
      console.error('[config-routes] Failed to create agent-ref symlink:', err)
      res.status(500).json({ error: 'Failed to create agent-ref symlink' })
    }
  })

  return router
}
