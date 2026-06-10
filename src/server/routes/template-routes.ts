/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Template API router
 *
 * GET /api/templates/agents      — List agent templates
 * GET /api/templates/agents/:id  — Get agent template content
 */
import { Router } from 'express'
import type { Request } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { listAgentTemplates, getAgentTemplateContent } from '../template-reader'

/**
 * Resolve the `?locale=` query param to a supported locale.
 *
 * `req.query.locale` can be a string, array, or object in Express, so it is
 * normalized explicitly: only the exact value `'en'` selects English; every
 * other shape (missing, array, object, unsupported string) falls back to the
 * legacy default `'ja'`.
 */
function parseLocale(req: Request): 'ja' | 'en' {
  return req.query.locale === 'en' ? 'en' : 'ja'
}

export function createTemplateRouter(fs: FileAccessLayer): Router {
  const router = Router()

  // GET /api/templates/agents
  router.get('/', (req, res) => {
    const locale = parseLocale(req)
    const templates = listAgentTemplates(fs, locale)
    res.json(templates)
  })

  // GET /api/templates/agents/:id
  router.get('/:id', (req, res) => {
    const locale = parseLocale(req)
    const content = getAgentTemplateContent(fs, req.params.id, locale)
    if (!content) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    res.json({ id: req.params.id, locale, content })
  })

  return router
}
