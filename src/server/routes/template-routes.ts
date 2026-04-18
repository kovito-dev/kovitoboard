/**
 * テンプレート API ルーター
 *
 * GET /api/templates/agents      — エージェントテンプレート一覧
 * GET /api/templates/agents/:id  — エージェントテンプレート内容
 */
import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { listAgentTemplates, getAgentTemplateContent } from '../template-reader'

export function createTemplateRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // GET /api/templates/agents
  router.get('/', (_req, res) => {
    const templates = listAgentTemplates(fs)
    res.json(templates)
  })

  // GET /api/templates/agents/:id
  router.get('/:id', (req, res) => {
    const locale = (req.query.locale as 'ja' | 'en') || 'ja'
    const content = getAgentTemplateContent(fs, req.params.id, locale)
    if (!content) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    res.json({ id: req.params.id, locale, content })
  })

  return router
}
