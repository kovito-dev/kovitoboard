/**
 * Configuration API router
 *
 * GET  /api/config/setting       — Get KovitoBoard settings
 * PUT  /api/config/setting       — Update KovitoBoard settings
 * GET  /api/config/project-root  — Return the projectRoot resolved at startup (DEC-009)
 * POST /api/config/setup-agent-ref — Create agent-ref symlink
 */
import { Router } from 'express'
import { join, resolve } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import { readSetting, writeSetting, validateSetting } from '../setting-manager'

export function createConfigRouter(fs: FileAccessLayer, projectRoot: string): Router {
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

  // GET /api/config/project-root (DEC-009: for Step 3 display)
  router.get('/project-root', (_req, res) => {
    res.json({ projectRoot })
  })

  // POST /api/config/setup-agent-ref
  // Create a symlink from KovitoBoard's docs/agent-ref/ into the parent project
  router.post('/setup-agent-ref', (_req, res) => {
    try {
      const kbRoot = resolve(projectRoot, 'kovitoboard')
      const source = join(kbRoot, 'docs', 'agent-ref')
      const targetDir = join(projectRoot, 'docs')
      const targetLink = join(targetDir, 'agent-ref')

      // Skip if source does not exist
      if (!fs.existsSync(source)) {
        res.json({ success: true, skipped: true, reason: 'source docs/agent-ref/ not found' })
        return
      }

      // Skip if target already exists (avoid overwriting existing files)
      if (fs.existsSync(targetLink)) {
        res.json({ success: true, skipped: true, reason: 'docs/agent-ref/ already exists' })
        return
      }

      // Create docs/ directory if it does not exist
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }

      // Create the symlink
      fs.symlinkSync(source, targetLink, 'dir')
      res.json({ success: true, skipped: false, link: targetLink, target: source })
    } catch (err) {
      console.error('[config-routes] Failed to create agent-ref symlink:', err)
      res.status(500).json({ error: 'Failed to create agent-ref symlink' })
    }
  })

  return router
}
