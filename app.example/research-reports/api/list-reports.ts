/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * GET /api/ext/research-reports/list-reports
 *
 * Returns a list of all research jobs with their latest status.
 * Reads jobs.jsonl for the base data and merges each job's status.json.
 * Results are sorted by startedAt descending (newest first).
 */
import { Router } from 'express'
import { join } from 'path'
import { DefaultFileAccessLayer } from '../../../src/server/fs-layer'

// User-extension structured logger (DEC-017 v1.3 §11).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (globalThis as any).kbContext.logger('research-reports')

const router = Router()

const DATA_DIR = join(process.cwd(), '.kovitoboard', 'research-reports')

const fs = new DefaultFileAccessLayer()

interface JobEntry {
  jobId: string
  theme: string
  status: string
  startedAt: string
  finishedAt?: string
}

router.get('/', (_req, res) => {
  try {
    const jobsFile = join(DATA_DIR, 'jobs.jsonl')
    if (!fs.existsSync(jobsFile)) {
      res.json({ reports: [] })
      return
    }

    const content = fs.readFileSync(jobsFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const reports: JobEntry[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { jobId: string; theme: string; startedAt: string }
        const statusFile = join(DATA_DIR, entry.jobId, 'status.json')

        let status = 'unknown'
        let startedAt = entry.startedAt
        let finishedAt: string | undefined

        if (fs.existsSync(statusFile)) {
          const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
          status = statusData.status || 'unknown'
          startedAt = statusData.startedAt || entry.startedAt
          finishedAt = statusData.finishedAt
        }

        reports.push({
          jobId: entry.jobId,
          theme: entry.theme,
          status,
          startedAt,
          ...(finishedAt && { finishedAt }),
        })
      } catch {
        // Skip malformed lines
      }
    }

    // Sort by startedAt descending (newest first)
    reports.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

    res.json({ reports })
  } catch (err) {
    log.error({ err }, 'list-reports error')
    res.status(500).json({ error: 'internal-error' })
  }
})

export default router
