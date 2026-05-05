/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Renderer-side helpers that localise the synthetic "Claude (default)"
 * agent surfaced by the server. The server returns stable English
 * tokens for `displayName` / `role` / `description` (architect §6.11)
 * and the renderer overrides them per locale via the i18n catalog.
 *
 * User-authored and bundled agents always pass through unchanged —
 * their copy lives in their own definition file and is not subject
 * to KB's locale.
 */
import type { AgentInfo } from '../types'
import { t } from '../i18n'

export function getAgentDisplayName(agent: Pick<AgentInfo, 'displayName' | 'isSystem'>): string {
  if (agent.isSystem) return t('agent.default.displayName')
  return agent.displayName
}

export function getAgentRole(agent: Pick<AgentInfo, 'role' | 'isSystem'>): string | undefined {
  if (agent.isSystem) return t('agent.default.role')
  return agent.role
}

export function getAgentDescription(
  agent: Pick<AgentInfo, 'description' | 'isSystem'>,
): string | undefined {
  if (agent.isSystem) return t('agent.default.description')
  return agent.description
}
