/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent create/update REST API router
 *
 * POST   /api/agents/create         — Create an agent from a template
 * POST   /api/agents/create-scratch — Create an agent without a template (AA-3)
 * GET    /api/agents/:id/sections   — Get current values of structured fields
 * PUT    /api/agents/:id            — Update agent attributes
 */

import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import type { AgentsChangedPayload } from '../../shared/ws-events'
import {
  createAgentFromTemplate,
  createAgentFromScratch,
  updateAgentSections,
  extractMarkerSections,
  injectMarkerSections,
  isValidAgentId,
  type CreateAgentOptions,
  type CreateScratchAgentOptions,
  type UpdateAgentOptions,
} from '../agent-writer'
import { readSetting } from '../setting-manager'

/**
 * Resolve the locale to use when picking a template variant.
 *
 * Preference order:
 *   1. The explicit `locale` field on the request body (set by the
 *      onboarding wizard or any caller that knows what it wants).
 *   2. The persisted `setting.json` `locale` (the value the user
 *      committed to on the welcome screen — the AgentCreatePage path
 *      historically did not echo this back to the server).
 *   3. `'ja'` as the legacy default; KB shipped Japanese-first.
 *
 * Without (2), creating an agent from the post-onboarding "create
 * agent" page would always fall back to (3), so an English user who
 * picked English at onboarding would still get the Japanese template
 * pulled in for new agents.
 */
function resolveTemplateLocale(
  fs: FileAccessLayer,
  bodyLocale: unknown,
): 'ja' | 'en' {
  if (bodyLocale === 'en' || bodyLocale === 'ja') return bodyLocale
  const setting = readSetting(fs)
  if (setting?.locale === 'en' || setting?.locale === 'ja') return setting.locale
  return 'ja'
}

/**
 * Notify clients that the on-disk agent set changed. Optional so
 * tests can mount the router without wiring a real WS broadcaster.
 */
export type AgentsChangedBroadcaster = (payload: AgentsChangedPayload) => void

export function createAgentWriteRouter(
  fs: FileAccessLayer,
  notifyAgentsChanged?: AgentsChangedBroadcaster,
): Router {
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
      locale: resolveTemplateLocale(fs, body.locale),
      customizations: sanitizeCustomizations(body.customizations),
    }

    const result = createAgentFromTemplate(fs, options)

    if (!result.success) {
      // 409 for conflict with existing agent
      const status = result.error?.includes('already exists') ? 409 : 400
      res.status(status).json({ error: result.error })
      return
    }

    // Tell connected UIs to refresh their agent list. Without this the
    // create page navigates back to /agents but the new entry stays
    // hidden until the user reloads the tab — useIPC's agent list is
    // WS-driven and only refetches on broadcasted events.
    notifyAgentsChanged?.({ reason: 'created', agentId: options.agentId })

    res.status(201).json({
      success: true,
      agentId: options.agentId,
      filePath: result.filePath,
    })
  })

  // POST /api/agents/create-scratch — Create an agent without a template (AA-3)
  //
  // The template path (above) is the friendly default for users who
  // want to bootstrap from `kovito-concierge` / `kovito-developer` /
  // etc. This route exists so power users can author a brand-new
  // persona with their own system prompt — the AD-3 frontmatter
  // fields (`description` / `model` / `themeColor`) plus a free-
  // form prompt body. Validation mirrors the AD-3 update route
  // (PUT /:id) so the create-then-edit round-trip is consistent.
  router.post('/create-scratch', (req, res) => {
    const body = req.body as Partial<CreateScratchAgentOptions>

    if (typeof body.agentId !== 'string' || body.agentId.length === 0) {
      res.status(400).json({ error: 'agentId is required' })
      return
    }
    if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
      res.status(400).json({ error: 'displayName is required' })
      return
    }
    if (typeof body.description !== 'string' || body.description.trim().length === 0) {
      res.status(400).json({ error: 'description is required' })
      return
    }
    if (typeof body.systemPrompt !== 'string' || body.systemPrompt.trim().length === 0) {
      res.status(400).json({ error: 'systemPrompt is required' })
      return
    }

    // Mirror the AD-3 PUT handler's enums so a value rejected on
    // create cannot somehow squeak through on edit (and vice versa).
    const ALLOWED_MODELS = new Set(['', 'default', 'sonnet', 'opus', 'haiku'])
    if (typeof body.model === 'string' && !ALLOWED_MODELS.has(body.model.trim())) {
      res.status(400).json({
        error: `Invalid model. Allowed: ${Array.from(ALLOWED_MODELS).filter((m) => m).join(', ')}`,
      })
      return
    }
    if (typeof body.themeColor === 'string') {
      const trimmed = body.themeColor.trim()
      if (trimmed !== '' && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
        res.status(400).json({ error: 'themeColor must be a hex color (e.g. #a855f7) or empty' })
        return
      }
    }

    const options: CreateScratchAgentOptions = {
      agentId: body.agentId,
      displayName: body.displayName,
      description: body.description,
      systemPrompt: body.systemPrompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      themeColor: typeof body.themeColor === 'string' ? body.themeColor : undefined,
    }

    const result = createAgentFromScratch(fs, options)

    if (!result.success) {
      const status = result.error?.includes('already exists') ? 409 : 400
      res.status(status).json({ error: result.error })
      return
    }

    notifyAgentsChanged?.({ reason: 'created', agentId: options.agentId })

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
    if (
      body.displayName === undefined &&
      body.description === undefined &&
      body.model === undefined &&
      body.themeColor === undefined &&
      !body.sections
    ) {
      res.status(400).json({ error: 'At least one field to update is required (displayName / description / model / themeColor / sections)' })
      return
    }

    // Q3 / AD-3: validate model against the published Claude dist-tag set.
    // Empty string is allowed (clears the field) and `default` maps to
    // the Claude Code default model.
    const ALLOWED_MODELS = new Set(['', 'default', 'sonnet', 'opus', 'haiku'])
    if (typeof body.model === 'string' && !ALLOWED_MODELS.has(body.model.trim())) {
      res.status(400).json({ error: `Invalid model. Allowed: ${Array.from(ALLOWED_MODELS).filter((m) => m).join(', ')}` })
      return
    }

    // Q3 / AD-3: validate themeColor as a 3- or 6-digit hex string.
    // Empty clears the field; anything else must look like #RGB or #RRGGBB.
    if (typeof body.themeColor === 'string') {
      const trimmed = body.themeColor.trim()
      if (trimmed !== '' && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
        res.status(400).json({ error: 'themeColor must be a hex color (e.g. #a855f7) or empty' })
        return
      }
    }

    const options: UpdateAgentOptions = {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      themeColor: typeof body.themeColor === 'string' ? body.themeColor : undefined,
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

    // Same broadcast as create — keep edit and detail views in sync
    // with the on-disk file across tabs.
    notifyAgentsChanged?.({ reason: 'updated', agentId })

    res.json({ success: true })
  })

  // Q2 / AD-2: append KB:* marker sections to a legacy agent file so
  // the structured editor can take over. The route is idempotent and
  // returns 200 with `alreadyHasMarkers: true` when the file already
  // contains them; clients use that signal to skip the banner without
  // surfacing a confusing error.
  router.post('/:id/inject-markers', (req, res) => {
    const agentId = req.params.id
    if (!isValidAgentId(agentId)) {
      res.status(400).json({ error: 'Invalid agent ID' })
      return
    }
    const result = injectMarkerSections(fs, agentId)
    if (!result.success) {
      const status = result.error?.includes('not found') ? 404 : 400
      res.status(status).json({ error: result.error })
      return
    }
    if (!result.alreadyHasMarkers) {
      notifyAgentsChanged?.({ reason: 'updated', agentId })
    }
    res.json({ success: true, alreadyHasMarkers: !!result.alreadyHasMarkers })
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
