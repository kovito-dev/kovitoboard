/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Hook for polling server admin status.
 *
 * Polls GET /api/admin/status every 5 seconds and combines
 * the result with WebSocket connection state to derive an
 * overall indicator state.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { createLogger } from '../lib/logger'
import { kbFetch } from '../lib/kbFetch'

const log = createLogger('useAdminStatus')

const API_BASE = '/api'
const POLL_INTERVAL = 5_000

export type IndicatorState = 'healthy' | 'degraded' | 'down' | 'unknown'

export interface AdminStatusData {
  status: 'healthy' | 'degraded'
  be: { alive: boolean; uptimeMs: number; pid: number }
  tmux: { alive: boolean; session: string }
  agents: Array<{ id: string; status: string }>
}

export interface AdminStatusResult {
  /** Raw status data from the last successful poll (null if not yet fetched) */
  data: AdminStatusData | null
  /** Computed indicator state (combines poll + WS state) */
  indicatorState: IndicatorState
  /** Whether the server is believed to have been stopped via admin/stop */
  isStopped: boolean
  /** Mark the server as stopped (called after POST /api/admin/stop) */
  markStopped: () => void
  /** Reset stopped state (called when server comes back) */
  clearStopped: () => void
}

export function useAdminStatus(wsConnected: boolean): AdminStatusResult {
  const [data, setData] = useState<AdminStatusData | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [isStopped, setIsStopped] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await kbFetch(`${API_BASE}/admin/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: AdminStatusData = await res.json()
      setData(json)
      setFetchFailed(false)

      // Server came back after being stopped
      if (isStopped) {
        window.location.reload()
      }
    } catch (err) {
      log.warn({ err }, 'Failed to poll admin status')
      setFetchFailed(true)
    }
  }, [isStopped])

  // Polling
  useEffect(() => {
    poll() // initial fetch
    timerRef.current = setInterval(poll, POLL_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [poll])

  // Compute indicator state
  let indicatorState: IndicatorState = 'unknown'
  if (!wsConnected || fetchFailed) {
    indicatorState = 'down'
  } else if (data) {
    indicatorState = data.status === 'healthy' ? 'healthy' : 'degraded'
  }

  const markStopped = useCallback(() => setIsStopped(true), [])
  const clearStopped = useCallback(() => setIsStopped(false), [])

  return {
    data,
    indicatorState,
    isStopped,
    markStopped,
    clearStopped,
  }
}
