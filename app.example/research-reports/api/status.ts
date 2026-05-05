/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * GET /api/ext/research-reports/status?jobId=xxx
 *
 * Returns the current status of a research job by reading its status.json.
 * When a job is completed or failed, cleans up the tmux window as a side effect.
 */
import { Router } from 'express'
import { join } from 'path'
import { TmuxBridge } from '../../../src/server/tmux-bridge'
import { DefaultFileAccessLayer } from '../../../src/server/fs-layer'

// User-extension structured logger (DEC-017 v1.3 §11).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (globalThis as any).kbContext.logger('research-reports')

const router = Router()

const DATA_DIR = join(process.cwd(), '.kovitoboard', 'research-reports')

const fs = new DefaultFileAccessLayer()
const tmux = new TmuxBridge(fs)

/** Track which windows have already been cleaned up (avoid repeated kill attempts) */
const cleanedUp = new Set<string>()

router.get('/', (req, res) => {
  try {
    const jobId = String(req.query.jobId || '')
    if (!jobId) {
      res.status(400).json({ error: 'jobId-required' })
      return
    }

    const statusFile = join(DATA_DIR, jobId, 'status.json')
    if (!fs.existsSync(statusFile)) {
      res.status(404).json({ error: 'not-found' })
      return
    }

    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))

    // Clean up tmux window when job is done (idempotent)
    if ((status.status === 'completed' || status.status === 'failed') && !cleanedUp.has(jobId)) {
      const windowName = `job-${jobId}`
      tmux.killWindow(windowName)
      cleanedUp.add(jobId)
    }

    res.json({
      jobId,
      status: status.status,
      startedAt: status.startedAt,
      ...(status.finishedAt && { finishedAt: status.finishedAt }),
      ...(status.error && { error: status.error }),
    })
  } catch (err) {
    log.error({ err }, 'status error')
    res.status(500).json({ error: 'internal-error' })
  }
})

export default router
