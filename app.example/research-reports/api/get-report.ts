/**
 * GET /api/ext/research-reports/get-report?jobId=xxx
 *
 * Returns the full report content including the markdown body and sources.
 * Only returns data when the job is completed.
 */
import { Router } from 'express'
import { join } from 'path'
import { DefaultFileAccessLayer } from '../../../src/server/fs-layer'

const router = Router()

const DATA_DIR = join(process.cwd(), '.kovitoboard', 'research-reports')

const fs = new DefaultFileAccessLayer()

router.get('/', (req, res) => {
  try {
    const jobId = String(req.query.jobId || '')
    if (!jobId) {
      res.status(400).json({ error: 'jobId-required' })
      return
    }

    const jobDir = join(DATA_DIR, jobId)
    const statusFile = join(jobDir, 'status.json')

    if (!fs.existsSync(statusFile)) {
      res.status(404).json({ error: 'not-found' })
      return
    }

    const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))

    // Only return report content when completed
    if (statusData.status !== 'completed') {
      res.status(409).json({ error: 'not-completed', status: statusData.status })
      return
    }

    // Read the theme from jobs.jsonl
    let theme = ''
    const jobsFile = join(DATA_DIR, 'jobs.jsonl')
    if (fs.existsSync(jobsFile)) {
      const lines = fs.readFileSync(jobsFile, 'utf-8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.jobId === jobId) {
            theme = entry.theme || ''
            break
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Read report.md
    const reportFile = join(jobDir, 'report.md')
    const report = fs.existsSync(reportFile)
      ? fs.readFileSync(reportFile, 'utf-8')
      : ''

    // Read sources.json
    const sourcesFile = join(jobDir, 'sources.json')
    let sources: Array<{ url: string; title: string; fetchedAt: string }> = []
    if (fs.existsSync(sourcesFile)) {
      try {
        const sourcesData = JSON.parse(fs.readFileSync(sourcesFile, 'utf-8'))
        sources = sourcesData.sources || []
      } catch {
        // Ignore malformed sources
      }
    }

    res.json({
      jobId,
      theme,
      status: 'completed',
      report,
      sources,
    })
  } catch (err) {
    console.error('[research-reports] get-report error:', err)
    res.status(500).json({ error: 'internal-error' })
  }
})

export default router
