/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Admin API router
 *
 * GET  /api/admin/status      — Server health + tmux + agent status
 * GET  /api/admin/git-status  — Git repo state of the KB checkout
 *                                (branch, sha, dirty flag). Returns
 *                                `{ tracked: false }` when the install
 *                                has no .git directory (npm package /
 *                                zip download / future packaged form)
 * POST /api/admin/restart     — Restart server. Preferred path: SIGUSR2 to
 *                                the supervisor (pid via KOVITOBOARD_SUPERVISOR_PID).
 *                                Fallback: process.exit(42) — only effective when
 *                                the server is launched without `tsx watch`,
 *                                which otherwise swallows the exit code.
 * POST /api/admin/stop        — Stop server (exit code 0 → supervisor terminates)
 *
 * @see DEC-016 (dev-mode canonical)
 */
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Router } from 'express'
import type { TmuxBridge } from '../tmux-bridge'
import { lazyChildLogger } from '../logger'

const adminLog = lazyChildLogger('admin-routes')

export interface AdminStatusResponse {
  status: 'healthy' | 'degraded'
  be: { alive: boolean; uptimeMs: number; pid: number }
  tmux: { alive: boolean; session: string }
  agents: Array<{ id: string; status: 'running' | 'unknown' }>
}

/**
 * Body of `GET /api/admin/git-status`.
 *
 * `tracked: false` means the KB install has no `.git` directory —
 * legitimate for npm-package / zip-download distributions, not a
 * KB-side error. The popover renders this case as a neutral "not a
 * git checkout" line rather than a red status.
 */
export type GitStatusResponse =
  | { tracked: false }
  | {
      tracked: true
      branch: string | null
      sha: string | null
      dirty: boolean
    }

/**
 * Locate the KB checkout root (package.json + .git live here).
 *
 * dev:   src/server/routes/ -> ../../..
 * build: dist/server/routes/ -> ../../..
 *
 * Both layouts resolve to the repo root because `dist/` is a sibling
 * of `src/`, not a deeper-nested copy.
 */
function resolveRepoRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return resolve(__dirname, '../../..')
}

/** Run `git <args>` in the repo root and capture trimmed stdout. */
function runGit(args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd: resolveRepoRoot(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return out.toString('utf-8').trim()
  } catch {
    return null
  }
}

export function createAdminRouter(
  tmuxBridge: TmuxBridge,
  serverStartTime: number,
): Router {
  const router = Router()

  // GET /api/admin/status
  router.get('/status', (_req, res) => {
    const now = Date.now()
    const uptimeMs = now - serverStartTime

    // Check tmux session health
    let tmuxAlive = false
    try {
      tmuxAlive = tmuxBridge.hasSession()
    } catch (err) {
      adminLog.warn({ err }, 'tmux health check failed, treating as inactive')
      tmuxAlive = false
    }

    // List active agent windows (exclude "main" shell window)
    const agents = tmuxBridge
      .listWindows()
      .filter((w) => w.name !== 'main')
      .map((w) => ({
        id: w.name,
        status: 'running' as const,
      }))

    // Overall status
    const status: AdminStatusResponse['status'] = !tmuxAlive
      ? 'degraded'
      : 'healthy'

    const body: AdminStatusResponse = {
      status,
      be: { alive: true, uptimeMs, pid: process.pid },
      tmux: { alive: tmuxAlive, session: tmuxBridge.sessionName },
      agents,
    }

    res.json(body)
  })

  // GET /api/admin/git-status
  router.get('/git-status', (_req, res) => {
    const repoRoot = resolveRepoRoot()
    const gitDir = resolve(repoRoot, '.git')

    if (!existsSync(gitDir)) {
      const body: GitStatusResponse = { tracked: false }
      res.json(body)
      return
    }

    const branchRaw = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    const shaRaw = runGit(['rev-parse', '--short', 'HEAD'])
    const statusRaw = runGit(['status', '--porcelain'])

    const body: GitStatusResponse = {
      tracked: true,
      branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
      sha: shaRaw,
      // `git status --porcelain` is empty (after trim) when the working
      // tree matches HEAD. Anything non-empty -> dirty. We do not
      // attempt to parse the porcelain output here; the popover only
      // surfaces a boolean indicator.
      dirty: typeof statusRaw === 'string' && statusRaw.length > 0,
    }
    res.json(body)
  })

  // POST /api/admin/restart
  router.post('/restart', (_req, res) => {
    res.json({ ok: true, message: 'Server restart initiated' })

    // Preferred path: signal the supervisor (kb-start.mjs) directly.
    // The supervisor sets KOVITOBOARD_SUPERVISOR_PID in our environment
    // so we can reach it without relying on process.ppid (which points
    // to `tsx watch`, not the supervisor).
    const rawPid = process.env.KOVITOBOARD_SUPERVISOR_PID
    const supPid = rawPid ? Number.parseInt(rawPid, 10) : NaN
    if (Number.isFinite(supPid) && supPid > 0) {
      adminLog.info(
        `[KovitoBoard] Restart requested via UI. Sending SIGUSR2 to supervisor (pid=${supPid})...`,
      )
      setTimeout(() => {
        try {
          process.kill(supPid, 'SIGUSR2')
        } catch (err) {
          // Supervisor unreachable — fall back to exit 42 so any
          // outer wrapper (or `npm run prod` style direct launch)
          // can still pick it up.
          const msg = err instanceof Error ? err.message : String(err)
          adminLog.warn(
            `[KovitoBoard] SIGUSR2 to supervisor failed: ${msg}. Falling back to exit 42.`,
          )
          process.exit(42)
        }
      }, 100)
      return
    }

    // Fallback: no supervisor pid available (e.g. `npm run prod` or a
    // direct `tsx src/server/index.ts` invocation). Exit with code 42.
    adminLog.info(
      '[KovitoBoard] Restart requested via UI. Exiting with code 42 (no supervisor pid)...',
    )
    setTimeout(() => process.exit(42), 100)
  })

  // POST /api/admin/stop
  router.post('/stop', (_req, res) => {
    res.json({ ok: true, message: 'Server stop initiated' })
    adminLog.info(
      '[KovitoBoard] Stop requested via UI. Exiting normally...',
    )
    setTimeout(() => process.exit(0), 100)
  })

  return router
}
