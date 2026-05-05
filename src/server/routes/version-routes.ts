/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * version-routes — HTTP layer for the version-display feature
 * (`v0.1.0-version-display.md` §4.5).
 *
 *   GET  /api/version          aggregated snapshot (KB + Claude Code +
 *                              cached release info + disabledBy)
 *   POST /api/version/recheck  bypass cache; refetch GitHub Releases.
 *                              Returns 403 when checking is disabled.
 *
 * `POST /api/version/start-upgrade` arrives in Phase C alongside the
 * "request upgrade" UI affordance.
 */
import { Router } from 'express'
import type { FileAccessLayer } from '../fs-layer'
import { getVersionInfoSnapshot, resolveDisabledBy } from '../version-info'
import { getLatestRelease, isOutdated, readCache } from '../github-releases-client'
import { readSetting } from '../setting-manager'
import { buildUpgradePrompt } from '../services/upgrade-prompts'
import { lazyChildLogger } from '../logger'

const log = lazyChildLogger('version-routes')

/**
 * Outcome of a session-start invocation, returned by the
 * `startUpgradeSession` callback. Mirrors the shape of
 * `POST /api/sessions/new` so the renderer can navigate using the
 * same identifiers.
 */
export interface UpgradeSessionStartResult {
  via: 'tmux' | 'claude-bridge'
  windowName?: string
  processId?: string
}

interface CreateVersionRouterDeps {
  fs: FileAccessLayer
  trustPatterns: { primaryTestedVersion: string; bestEffortVersions: string[] }
  /**
   * Callback that wraps the existing tmux/ClaudeBridge session-start
   * flow. Injected from index.ts (which owns the bridges) so this
   * router does not import the entire server bootstrap. We do not
   * forward `origin` — upgrade sessions go through the Sessions
   * surface, not the ambient sidebar.
   */
  startUpgradeSession?: (args: {
    agentId: string
    message: string
  }) => Promise<UpgradeSessionStartResult>
}

export function createVersionRouter(deps: CreateVersionRouterDeps): Router {
  const router = Router()
  const { fs, trustPatterns, startUpgradeSession } = deps

  router.get('/', async (_req, res) => {
    const snapshot = getVersionInfoSnapshot(fs, trustPatterns)
    const disabledBy = resolveDisabledBy(fs)

    // Read cached release info without triggering a fresh fetch — the
    // GET endpoint should be side-effect free. A separate background
    // refresh on startup populates the cache (see index.ts wiring).
    let release = readCache(fs)
    let isUpToDate = true
    let latest: string | null = null
    let latestCheckedAt: string | null = null
    let latestFetchSucceeded = false

    if (release) {
      latest = release.latestTag
      latestCheckedAt = release.checkedAt
      latestFetchSucceeded = release.fetchSucceeded
      isUpToDate = !isOutdated(snapshot.kb.current, release.latestTag)
    }

    res.json({
      kb: {
        current: snapshot.kb.current,
        latest,
        latestCheckedAt,
        latestFetchSucceeded,
        isUpToDate,
        source: release?.source ?? null,
      },
      claudeCode: {
        detected: snapshot.claudeCode.detected,
        primaryTested: snapshot.claudeCode.primaryTested,
        tier: snapshot.claudeCode.tier,
      },
      config: {
        versionCheckEnabled: disabledBy === null,
        disabledBy,
      },
    })
  })

  router.post('/start-upgrade', async (req, res) => {
    if (!startUpgradeSession) {
      res.status(501).json({ error: 'Upgrade dispatch is not configured' })
      return
    }

    const body = req.body as { agentId?: unknown }
    if (typeof body.agentId !== 'string' || body.agentId.trim().length === 0) {
      res.status(400).json({ error: 'agentId must be a non-empty string' })
      return
    }
    const agentId = body.agentId.trim()

    const snapshot = getVersionInfoSnapshot(fs, trustPatterns)
    const cached = readCache(fs)
    const latestTag = cached?.latestTag ?? null

    if (!latestTag) {
      res.status(409).json({
        error: 'Latest release info is not available; run /api/version/recheck first',
      })
      return
    }
    if (!isOutdated(snapshot.kb.current, latestTag)) {
      res.status(409).json({ error: 'KovitoBoard is already up to date' })
      return
    }

    const setting = readSetting(fs)
    // Mirror the renderer fallback (`i18n/index.ts` FALLBACK_LOCALE).
    const locale = setting?.locale ?? 'en'
    const message = buildUpgradePrompt({
      currentVersion: snapshot.kb.current,
      latestVersion: latestTag.replace(/^v/, ''),
      locale,
    })

    try {
      const result = await startUpgradeSession({ agentId, message })
      res.json({ success: true, ...result })
    } catch (err) {
      log.warn({ err }, 'start-upgrade dispatch failed')
      res.status(500).json({ error: 'Failed to start upgrade session' })
    }
  })

  router.post('/recheck', async (_req, res) => {
    const disabledBy = resolveDisabledBy(fs)
    if (disabledBy !== null) {
      res.status(403).json({
        error: 'Version checking is disabled',
        disabledBy,
      })
      return
    }

    const snapshot = getVersionInfoSnapshot(fs, trustPatterns)
    try {
      const fresh = await getLatestRelease(fs, {
        force: true,
        kbVersion: snapshot.kb.current,
      })
      // `null` here means disabledBy flipped between resolve and fetch
      // (e.g. env unset mid-flight) — surface as 403 for symmetry.
      if (!fresh) {
        res.status(403).json({ error: 'Version checking is disabled' })
        return
      }
      res.json({
        latest: fresh.latestTag,
        latestCheckedAt: fresh.checkedAt,
        latestFetchSucceeded: fresh.fetchSucceeded,
        isUpToDate: !isOutdated(snapshot.kb.current, fresh.latestTag),
      })
    } catch (err) {
      // getLatestRelease is supposed to be fail-silent; this catches
      // anything that slipped past (e.g. fs.writeFile permission error
      // on the cache file). Still respond 200 so the UI can render
      // the "couldn't reach upstream" affordance instead of going red.
      log.warn({ err }, 'recheck propagated unexpected error')
      res.json({
        latest: null,
        latestCheckedAt: new Date().toISOString(),
        latestFetchSucceeded: false,
        isUpToDate: true,
      })
    }
  })

  return router
}
