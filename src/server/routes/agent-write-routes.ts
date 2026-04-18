/**
 * Agent create/update REST API router
 *
 * POST   /api/agents/create        — Create an agent from a template
 * GET    /api/agents/:id/sections   — Get current values of structured fields
 * PUT    /api/agents/:id            — Update agent attributes
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

  // POST /api/agents/create — Create an agent from a template
  router.post('/create', (req, res) => {
    const body = req.body as Partial<CreateAgentOptions>

    // Validate required parameters
    if (!body.templateId || typeof body.templateId !== 'string') {
      res.status(400).json({ error: 'templateId is required' })
      return
    }
    if (!body.agentId || typeof body.agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' })
      return
    }

    // Sanitize optional parameters
    const options: CreateAgentOptions = {
      templateId: body.templateId,
      agentId: body.agentId,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      locale: body.locale === 'en' ? 'en' : 'ja',
      customizations: sanitizeCustomizations(body.customizations),
    }

    const result = createAgentFromTemplate(fs, options)

    if (!result.success) {
      // 409 for conflict with existing agent
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

  // GET /api/agents/:id/sections — Get current values of structured fields
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

  // PUT /api/agents/:id — Update agent attributes
  router.put('/:id', (req, res) => {
    const agentId = req.params.id
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'Invalid agent ID' })
      return
    }

    const body = req.body as Partial<UpdateAgentOptions>

    // At least one field to update is required
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

/** Sanitize the customizations object */
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
