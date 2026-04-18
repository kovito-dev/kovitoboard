/**
 * エージェント作成・更新 REST API ルーター
 *
 * POST   /api/agents/create        — テンプレートからエージェントを作成
 * GET    /api/agents/:id/sections   — 構造化フィールドの現在値を取得
 * PUT    /api/agents/:id            — エージェント属性を更新
 */

import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import {
  createAgentFromTemplate,
  updateAgentSections,
  extractMarkerSections,
  isValidAgentId,
  type CreateAgentOptions,
  type UpdateAgentOptions,
} from '../agent-writer'

export function createAgentWriteRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // POST /api/agents/create — テンプレートからエージェント作成
  router.post('/create', (req, res) => {
    const body = req.body as Partial<CreateAgentOptions>

    // 必須パラメータのバリデーション
    if (!body.templateId || typeof body.templateId !== 'string') {
      res.status(400).json({ error: 'templateId is required' })
      return
    }
    if (!body.agentId || typeof body.agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' })
      return
    }

    // オプションパラメータのサニタイズ
    const options: CreateAgentOptions = {
      templateId: body.templateId,
      agentId: body.agentId,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      locale: body.locale === 'en' ? 'en' : 'ja',
      customizations: sanitizeCustomizations(body.customizations),
    }

    const result = createAgentFromTemplate(fs, options)

    if (!result.success) {
      // 既存エージェントとの衝突は 409
      const status = result.error?.includes('already exists') ? 409 : 400
      res.status(status).json({ error: result.error })
      return
    }

    res.status(201).json({
      success: true,
      agentId: options.agentId,
      filePath: result.filePath,
    })
  })

  // GET /api/agents/:id/sections — 構造化フィールドの現在値を取得
  router.get('/:id/sections', (req, res) => {
    const agentId = req.params.id
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'Invalid agent ID' })
      return
    }

    const sections = extractMarkerSections(fs, agentId)
    if (!sections) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }

    res.json(sections)
  })

  // PUT /api/agents/:id — エージェント属性を更新
  router.put('/:id', (req, res) => {
    const agentId = req.params.id
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'Invalid agent ID' })
      return
    }

    const body = req.body as Partial<UpdateAgentOptions>

    // 少なくとも 1 つの更新項目が必要
    if (body.displayName === undefined && !body.sections) {
      res.status(400).json({ error: 'At least one field to update is required (displayName or sections)' })
      return
    }

    const options: UpdateAgentOptions = {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      sections: sanitizeCustomizations(body.sections),
    }

    const result = updateAgentSections(fs, agentId, options)

    if (!result.success) {
      const status = result.error?.includes('not found') ? 404
        : result.error?.includes('markers') ? 422
        : 400
      res.status(status).json({ error: result.error })
      return
    }

    res.json({ success: true })
  })

  return router
}

/** customizations オブジェクトのサニタイズ */
function sanitizeCustomizations(
  raw: unknown,
): CreateAgentOptions['customizations'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const obj = raw as Record<string, unknown>
  const result: NonNullable<CreateAgentOptions['customizations']> = {}
  let hasValue = false

  if (typeof obj.personality === 'string') {
    result.personality = obj.personality
    hasValue = true
  }
  if (typeof obj.toneSample === 'string') {
    result.toneSample = obj.toneSample
    hasValue = true
  }
  if (typeof obj.extraInstructions === 'string') {
    result.extraInstructions = obj.extraInstructions
    hasValue = true
  }

  return hasValue ? result : undefined
}
