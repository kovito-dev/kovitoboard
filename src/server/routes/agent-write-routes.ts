/**
 * エージェント作成 REST API ルーター
 *
 * POST /api/agents/create — テンプレートからエージェントを作成
 */

import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { createAgentFromTemplate, type CreateAgentOptions } from '../agent-writer'

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
