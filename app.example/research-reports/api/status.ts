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
    console.error('[research-reports] status error:', err)
    res.status(500).json({ error: 'internal-error' })
  }
})

export default router
