/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useState } from 'react'
import type { AmbientSidebarSetting, KovitoboardSetting } from '../../shared/setting-types'
import { createLogger } from '../lib/logger'

const log = createLogger('useSidebarSettings')

/**
 * useSidebarSettings — read/write the `ambientSidebar` slice of
 * `.kovitoboard/setting.json` from the renderer (DEC-020 / EU8).
 *
 * The KovitoBoard config API is whole-document on PUT (see
 * config-routes.ts), so every mutation here re-fetches the current
 * setting, patches the ambientSidebar slice, and PUTs it back. We
 * apply changes optimistically and revert on failure to keep the UI
 * responsive even on slow disks.
 *
 * Hook semantics:
 *   - `loading = true` until the first GET completes
 *   - When the setting file does not exist (pre-onboarding), the hook
 *     yields the default empty configuration but writes are no-ops
 *     (writing would 400 against validateSetting). UI mounting is
 *     gated by onboardingComplete so this only matters for safety.
 */

export const DEFAULT_AMBIENT_SIDEBAR_SETTING: AmbientSidebarSetting = {
  pinned: {},
  globalDefault: null,
  openByDefault: false,
}

export interface UseSidebarSettingsResult {
  /** Current ambientSidebar configuration. Defaults until the first fetch resolves. */
  settings: AmbientSidebarSetting
  /** True until the initial fetch completes. */
  loading: boolean
  /** Pin an agent for the given appId. Pass `null` to clear the pin. */
  setPin: (appId: string, agentId: string | null) => Promise<void>
  /** Update the global fallback agent. */
  setGlobalDefault: (agentId: string | null) => Promise<void>
  /** Toggle whether the sidebar opens on app launch. */
  setOpenByDefault: (value: boolean) => Promise<void>
}

async function fetchSetting(): Promise<KovitoboardSetting | null> {
  const res = await fetch('/api/config/setting')
  if (!res.ok) return null
  const data = (await res.json()) as KovitoboardSetting | null
  return data
}

async function putSetting(setting: KovitoboardSetting): Promise<void> {
  const res = await fetch('/api/config/setting', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setting),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PUT /api/config/setting failed: ${res.status} ${text}`)
  }
}

export function useSidebarSettings(): UseSidebarSettingsResult {
  const [settings, setSettings] = useState<AmbientSidebarSetting>(DEFAULT_AMBIENT_SIDEBAR_SETTING)
  const [loading, setLoading] = useState(true)
  // Cache the full setting so writes can patch without an extra GET.
  // null = setting file does not exist yet (e.g. pre-onboarding); writes are no-ops.
  const [fullSetting, setFullSetting] = useState<KovitoboardSetting | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSetting()
      .then((data) => {
        if (cancelled) return
        setFullSetting(data)
        if (data?.ambientSidebar) {
          setSettings(data.ambientSidebar)
        }
      })
      .catch((err) => {
        log.warn({ err }, 'Failed to load setting; using defaults')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(
    async (next: AmbientSidebarSetting) => {
      // Optimistic
      const previous = settings
      setSettings(next)

      // No-op when setting file does not exist yet (pre-onboarding)
      if (!fullSetting) {
        log.debug('setting file absent; skipping persist')
        return
      }

      const merged: KovitoboardSetting = { ...fullSetting, ambientSidebar: next }
      try {
        await putSetting(merged)
        setFullSetting(merged)
      } catch (err) {
        log.warn({ err }, 'Failed to persist ambientSidebar; reverting')
        setSettings(previous)
        throw err
      }
    },
    [settings, fullSetting],
  )

  const setPin = useCallback(
    async (appId: string, agentId: string | null) => {
      await persist({
        ...settings,
        pinned: { ...settings.pinned, [appId]: agentId },
      })
    },
    [persist, settings],
  )

  const setGlobalDefault = useCallback(
    async (agentId: string | null) => {
      await persist({ ...settings, globalDefault: agentId })
    },
    [persist, settings],
  )

  const setOpenByDefault = useCallback(
    async (value: boolean) => {
      await persist({ ...settings, openByDefault: value })
    },
    [persist, settings],
  )

  return { settings, loading, setPin, setGlobalDefault, setOpenByDefault }
}
