/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useState } from 'react'
import { createLogger } from '../lib/logger'

const log = createLogger('useVersionInfo')

/**
 * useVersionInfo — fetch and refresh `/api/version`
 * (`v0.1.0-version-display.md` §4.5).
 *
 * Single fetch on mount, plus an explicit `recheck` action that
 * forces a fresh GitHub Releases poll. We deliberately do not poll
 * on a timer: the BE itself caches for 24 h by default, and the
 * "currently active version" never changes mid-process. The header
 * banner and the popover share the same hook instance via prop
 * threading from TitleBar → { VersionHeaderBadge, StatusIndicator
 * → VersionPanel }, so a single fetch covers both surfaces.
 */

export type ClaudeCodeTier = 'primary' | 'best-effort' | 'out-of-range' | 'unknown'
export type DisabledBy = 'env' | 'config' | null

export interface VersionInfoResponse {
  kb: {
    current: string
    latest: string | null
    latestCheckedAt: string | null
    latestFetchSucceeded: boolean
    isUpToDate: boolean
    source: string | null
  }
  claudeCode: {
    detected: string | null
    primaryTested: string
    tier: ClaudeCodeTier
  }
  config: {
    versionCheckEnabled: boolean
    disabledBy: DisabledBy
  }
}

/** Response shape from POST /api/version/start-upgrade. */
export interface StartUpgradeResult {
  via: 'tmux' | 'claude-bridge'
  windowName?: string
  processId?: string
}

export interface UseVersionInfoResult {
  /** Latest fetched snapshot, or null while loading / on error. */
  data: VersionInfoResponse | null
  /** True until the very first fetch resolves (success or error). */
  loading: boolean
  /** True while a recheck POST is in flight. */
  rechecking: boolean
  /**
   * Trigger a forced recheck against GitHub Releases. Returns the
   * outcome so the caller can render success / failure inline.
   * Throws on disabled (caller should hide the button instead).
   */
  recheck: () => Promise<void>
  /**
   * Request an upgrade dispatch (`v0.1.0-version-display.md` §6).
   * Posts to /api/version/start-upgrade with the picked agentId; the
   * BE generates the localized prompt + launches the existing
   * tmux/ClaudeBridge flow. Throws on validation / 5xx so the caller
   * can surface a toast.
   */
  startUpgrade: (agentId: string) => Promise<StartUpgradeResult>
  /** Last error message (initial fetch or recheck), cleared on success. */
  error: string | null
}

async function fetchVersionInfo(): Promise<VersionInfoResponse> {
  const res = await fetch('/api/version')
  if (!res.ok) throw new Error(`GET /api/version failed: ${res.status}`)
  return (await res.json()) as VersionInfoResponse
}

export function useVersionInfo(): UseVersionInfoResult {
  const [data, setData] = useState<VersionInfoResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [rechecking, setRechecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initial fetch on mount.
  useEffect(() => {
    let cancelled = false
    fetchVersionInfo()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        log.warn({ err }, 'Failed to load /api/version')
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const recheck = useCallback(async (): Promise<void> => {
    setRechecking(true)
    try {
      const res = await fetch('/api/version/recheck', { method: 'POST' })
      if (!res.ok) {
        throw new Error(`POST /api/version/recheck failed: ${res.status}`)
      }
      // The recheck response only carries the kb half; rather than
      // merge partial state, refetch the whole thing so the popover
      // has internally consistent kb + claudeCode + config blocks.
      const fresh = await fetchVersionInfo()
      setData(fresh)
      setError(null)
    } catch (err: unknown) {
      log.warn({ err }, 'Failed to recheck KB version')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRechecking(false)
    }
  }, [])

  const startUpgrade = useCallback(async (agentId: string): Promise<StartUpgradeResult> => {
    const res = await fetch('/api/version/start-upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(body.error || `POST /api/version/start-upgrade failed: ${res.status}`)
    }
    return (await res.json()) as StartUpgradeResult
  }, [])

  return { data, loading, rechecking, recheck, startUpgrade, error }
}
