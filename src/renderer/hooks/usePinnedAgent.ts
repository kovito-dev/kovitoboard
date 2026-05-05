/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import type { AgentInfo } from '../types'
import type { AmbientSidebarSetting } from '../../shared/setting-types'

/**
 * usePinnedAgent — resolve the current screen's appId and the agent
 * pinned to it (DEC-020 / EU8).
 *
 * appId resolution rules (spec §2.5):
 *   - `/recipes...`        → 'recipes'
 *   - `/ext/<id>...`       → 'ext/<id>'
 *   - other builtin pages  → page id (currently unused: the sidebar is
 *                            suppressed on /agents and /sessions)
 *   - unknown route        → null  (the picker shows global default
 *                            but the pin button is disabled)
 *
 * Resolution order (spec §2.4 implied by ScreenLabel + global default):
 *   1. `pinned[appId]` if set to a string
 *   2. `globalDefault` otherwise
 *   3. null when neither is set or the resolved id no longer matches
 *      a known agent (deleted agent fallback, spec §2.5)
 *
 * IMPORTANT (Kobi-prerequisite removal, spec §2.5):
 *   The fallback for a deleted agent is the *unselected* state. Do NOT
 *   silently substitute kovito-concierge or any other hardcoded ID.
 */

export interface UsePinnedAgentResult {
  /** Stable identifier for the current screen, or null when unresolved. */
  appId: string | null
  /** Agent pinned to this screen after deleted-agent fallback. */
  pinnedAgentId: string | null
  /** Pin (or clear) an agent for the current screen. */
  pin: (agentId: string | null) => Promise<void>
}

/**
 * Resolve the appId for the current location. Returns null when the
 * route doesn't map to a sidebar-relevant screen — the sidebar UI is
 * already suppressed on /agents and /sessions, so this only fires
 * during edge cases (404, unknown route).
 */
export function resolveAppId(pathname: string): string | null {
  if (pathname.startsWith('/recipes')) return 'recipes'
  if (pathname.startsWith('/ext/')) {
    const parts = pathname.split('/')
    const id = parts[2]
    if (!id) return null
    return `ext/${id}`
  }
  // Builtin screens that may host the sidebar in the future. Currently
  // /agents and /sessions are suppressed at the App.tsx level.
  if (pathname.startsWith('/agents')) return 'agents'
  if (pathname.startsWith('/sessions')) return 'sessions'
  return null
}

export function usePinnedAgent(
  agents: AgentInfo[],
  settings: AmbientSidebarSetting,
  setPin: (appId: string, agentId: string | null) => Promise<void>,
): UsePinnedAgentResult {
  const location = useLocation()

  const appId = useMemo(() => resolveAppId(location.pathname), [location.pathname])

  const pinnedAgentId = useMemo<string | null>(() => {
    if (!appId) return null
    const knownIds = new Set(agents.map((a) => a.id))

    // 1. per-screen pin
    const pinned = settings.pinned[appId]
    if (pinned && knownIds.has(pinned)) return pinned

    // 2. global default
    if (settings.globalDefault && knownIds.has(settings.globalDefault)) {
      return settings.globalDefault
    }

    // 3. deleted-agent or unset → unselected
    return null
  }, [appId, agents, settings])

  const pin = useCallback(
    async (agentId: string | null) => {
      if (!appId) return
      await setPin(appId, agentId)
    },
    [appId, setPin],
  )

  return { appId, pinnedAgentId, pin }
}
