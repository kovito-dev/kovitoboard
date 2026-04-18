/**
 * POST /api/ext/research-reports/start-research
 *
 * Start a new research job. Creates job directory, initializes status,
 * and launches a tmux sub-session with Claude Code to perform the research.
 */
import { Router } from 'express'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { mkdirSync, appendFileSync, renameSync } from 'fs'
import { TmuxBridge } from '../../../src/server/tmux-bridge'
import { DefaultFileAccessLayer } from '../../../src/server/fs-layer'

const router = Router()

const MAX_THEME_LENGTH = 1000
const MAX_CONCURRENT_JOBS = 3
const DATA_DIR = join(process.cwd(), '.kovitoboard', 'research-reports')
const PROMPTS_DIR = join(__dirname, '..', 'prompts')

const fs = new DefaultFileAccessLayer()
const tmux = new TmuxBridge(fs)

/** Generate a job ID: rr-YYYYMMDDTHHmmss-XXXX */
function generateJobId(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', 'T')
  const rand = randomBytes(2).toString('hex') // 4 hex chars
  return `rr-${ts}-${rand}`
}

/** Count running jobs from jobs.jsonl */
function countRunningJobs(): number {
  const jobsFile = join(DATA_DIR, 'jobs.jsonl')
  if (!fs.existsSync(jobsFile)) return 0

  const content = fs.readFileSync(jobsFile, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)
  let running = 0

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const jobDir = join(DATA_DIR, entry.jobId)
      const statusFile = join(jobDir, 'status.json')
      if (fs.existsSync(statusFile)) {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
        if (status.status === 'queued' || status.status === 'running') {
          running++
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return running
}

/** Atomic write: write to tmp file then rename */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
}

router.post('/', async (req, res) => {
  try {
    const { theme } = req.body || {}

    // Validation
    if (!theme || typeof theme !== 'string' || theme.trim().length === 0) {
      res.status(400).json({ error: 'theme-required' })
      return
    }
    if (theme.length > MAX_THEME_LENGTH) {
      res.status(400).json({ error: 'theme-too-long' })
      return
    }

    // Concurrency check
    const running = countRunningJobs()
    if (running >= MAX_CONCURRENT_JOBS) {
      res.status(429).json({ error: 'queue-full', maxConcurrent: MAX_CONCURRENT_JOBS })
      return
    }

    const jobId = generateJobId()
    const jobDir = join(DATA_DIR, jobId)
    const now = new Date().toISOString()

    // Create directories (DATA_DIR first, then job sub-dir)
    mkdirSync(DATA_DIR, { recursive: true })
    mkdirSync(jobDir, { recursive: true })

    // Initialize status.json (atomic write)
    atomicWriteJson(join(jobDir, 'status.json'), {
      status: 'queued',
      startedAt: now,
    })

    // Append to jobs.jsonl
    const jobEntry = JSON.stringify({ jobId, theme: theme.trim(), status: 'queued', startedAt: now })
    appendFileSync(join(DATA_DIR, 'jobs.jsonl'), jobEntry + '\n', 'utf-8')

    // Read and prepare the research prompt
    const promptTemplate = fs.readFileSync(join(PROMPTS_DIR, 'research-agent.md'), 'utf-8')
    const prompt = promptTemplate
      .replace(/\{THEME\}/g, theme.trim())
      .replace(/\{JOB_ID\}/g, jobId)
      .replace(/\{OUTPUT_DIR\}/g, jobDir)

    // Launch tmux sub-session
    const windowName = `job-${jobId}`
    const startResult = tmux.startJobWindow(windowName)
    if (!startResult.success) {
      // Update status to failed
      atomicWriteJson(join(jobDir, 'status.json'), {
        status: 'failed',
        startedAt: now,
        finishedAt: new Date().toISOString(),
        error: `Failed to start tmux window: ${startResult.error}`,
      })
      console.error(`[research-reports] Failed to start job window: ${startResult.error}`)
      res.json({ jobId })
      return
    }

    // Wait for Claude CLI to be ready, then send the prompt
    const ready = await tmux.waitForAgentReady(windowName, 30000)
    if (!ready) {
      console.warn(`[research-reports] Prompt readiness timeout for ${windowName}, sending anyway`)
    }
    tmux.sendMessage(windowName, prompt)

    // Update status to running
    atomicWriteJson(join(jobDir, 'status.json'), {
      status: 'running',
      startedAt: now,
    })

    console.log(`[research-reports] Job started: ${jobId} theme="${theme.trim().slice(0, 50)}"`)
    res.json({ jobId })
  } catch (err) {
    console.error('[research-reports] start-research error:', err)
    res.status(500).json({ error: 'internal-error' })
  }
})

export default router
