import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, isAbsolute, resolve, normalize, dirname } from 'path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { randomUUID } from 'crypto'
import { DirectFsLayer } from './fs-layer'
import { loadConfig, resolveProjectRoot } from './config'
import { ensureKovitoboardDir, getUploadDir } from './paths'
import { SessionManager } from './session-manager'
import { Watcher } from './watcher'
import { loadAgentDefinitions, loadSessionAgentRecords, buildSessionAgentMap, getAgentDefinitionContent } from './agent-reader'
import { ClaudeBridge } from './claude-bridge'
import { TmuxBridge, isValidTmuxName } from './tmux-bridge'
import { DataFileWatcher } from './data-file-watcher'
import { readBasicSettings, readSkills, readAutomations, readIntegrations, readRules } from './settings-reader'
import { readArtifact } from './artifact-reader'
import { TrustPromptDetector, loadTrustPatterns } from './trust-prompt-detector'
import type { SendMessageRequest, NewSessionRequest, TmuxSendRequest, TmuxStartAgentRequest } from './types'
import { mountAppApiRoutes } from './app-api-loader'
import { parseRecipe } from './recipe-parser'
import { inspectRecipe } from './recipe-inspector'
import { applyRecipe } from './recipe-applicator'
import { readRecipeHistory, appendRecipeHistory, generateHistoryId } from './recipe-history'
import { scanAppDirectory, exportAsDirectory, exportAsMarkdown } from './recipe-exporter'
import type { RecipeParseRequest, RecipeApplyRequest, RecipeExportRequest } from '../shared/recipe-types'
import type {
  ServerToClientEvent,
  ClientToServerEvent,
  TrustPromptRespondPayload,
} from '../shared/ws-events'

const PORT = Number(process.env.PORT) || 3001

const app = express()
app.use(express.json())

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '0')  // Disabled as recommended for modern browsers
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",  // Tailwind inline styles
    "img-src 'self' data:",
  ].join('; '))
  next()
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// --- File access abstraction layer ---
// v0.1.0 only provides DirectFsLayer (direct Node.js fs / chokidar calls).
// All modules receive it via DI so it can be swapped for Plugin support (v0.2.0+).
const fs = new DirectFsLayer()

const config = loadConfig(fs)

// Project root (base path for .claude/agents, .kovitoboard/, etc.)
// Resolved first because ClaudeBridge uses it as its default cwd
const projectRoot = resolveProjectRoot(fs)

// Auto-create `.kovitoboard/` directory on first launch
ensureKovitoboardDir(fs)

const sessionManager = new SessionManager()
const watcher = new Watcher(config, sessionManager, fs)
const claudeBridge = new ClaudeBridge(projectRoot)
const tmuxBridge = new TmuxBridge(fs)

/**
 * Ensure a tmux window exists for the specified agent.
 * If the window does not exist, automatically creates a tmux session + window
 * and starts a Claude Code agent.
 *
 * @returns { windowName, justStarted } — justStarted=true indicates the agent was newly started
 */
async function ensureTmuxAgent(agentId: string): Promise<{ windowName: string; justStarted: boolean } | null> {
  // Return existing window name if already running
  if (tmuxBridge.hasSession()) {
    const windows = tmuxBridge.listWindows()
    const existing = windows.find((w) => w.name === agentId)
    if (existing) return { windowName: existing.name, justStarted: false }
  }

  // Auto-create tmux session + agent window
  const result = await tmuxBridge.startAgent(agentId)
  if (result.success) {
    console.log(`[auto-tmux] Agent "${agentId}" auto-started via tmux`)
    return { windowName: agentId, justStarted: true }
  }

  console.warn(`[auto-tmux] Failed to start agent "${agentId}" via tmux: ${result.error}`)
  return null
}

// Data file watcher: auto-detect direct edits to agent files
// === When adding a new data Manager ===
// Pass DataFileWatcher to its constructor and call register().
// See the file header comment in data-file-watcher.ts for details.
// NOTE (v0.1.0): Task management is out of scope for v0.1.0, so currently no
//                Manager is registered with DataFileWatcher. To be added in v0.1.1+.
const _dataFileWatcher = new DataFileWatcher(fs, {
  usePolling: config.watcher.usePolling,
  pollInterval: config.watcher.pollInterval,
})
void _dataFileWatcher

/**
 * Resolve the requested file path and verify it is within projectRoot.
 * Returns a safe absolute path, or null if the path is invalid.
 */
function resolveAndValidatePath(requestedPath: string): string | null {
  const resolved = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : normalize(resolve(projectRoot, requestedPath))

  // Verify the path is under projectRoot (projectRoot itself is also allowed)
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    return null
  }
  return resolved
}

// --- REST API ---
app.get('/api/sessions', (_req, res) => {
  res.json(sessionManager.getSessions())
})

app.get('/api/sessions/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id)
  if (!session) { res.status(404).json({ error: 'Session not found' }); return }
  res.json(session)
})

app.get('/api/config', (_req, res) => {
  res.json(config)
})

// Agent list (definitions + session statistics)
app.get('/api/agents', (_req, res) => {
  const agents = loadAgentDefinitions(fs, config)
  const records = loadSessionAgentRecords(fs, config)
  const sessionAgentMap = buildSessionAgentMap(records)

  // Get session statuses and aggregate per agent
  const sessions = sessionManager.getSessions()
  const agentSessionCounts = new Map<string, { active: number; total: number }>()

  for (const session of sessions) {
    const agentType = sessionAgentMap.get(session.id)
    if (!agentType) continue

    const counts = agentSessionCounts.get(agentType) || { active: 0, total: 0 }
    counts.total++
    if (session.status === 'active' || session.status === 'thinking' || session.status === 'waiting') {
      counts.active++
    }
    agentSessionCounts.set(agentType, counts)
  }

  // Attach session statistics to agent info
  for (const agent of agents) {
    const counts = agentSessionCounts.get(agent.id) || { active: 0, total: 0 }
    agent.activeSessionCount = counts.active
    agent.totalSessionCount = counts.total
  }

  res.json(agents)
})

// Agent definition raw content
app.get('/api/agents/:id/definition', (req, res) => {
  const agentId = req.params.id
  const content = getAgentDefinitionContent(fs, config, agentId)
  if (content === null) {
    res.status(404).json({ error: 'Agent definition not found' })
    return
  }
  res.json({ content })
})

// Session-agent association mapping
app.get('/api/session-agent-map', (_req, res) => {
  res.json(sessionManager.getSessionAgentMap())
})

// Manually set agentId on a session
app.post('/api/sessions/:id/set-agent', (req, res) => {
  const sessionId = req.params.id
  const { agentId } = req.body as { agentId: string }

  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' })
    return
  }

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  sessionManager.setAgentId(sessionId, agentId)
  res.json({ success: true })
})

// Deactivate all active sessions for an agent (set to idle)
app.post('/api/agents/:agentId/deactivate-sessions', (req, res) => {
  const { agentId } = req.params
  const deactivated = sessionManager.deactivateAgentSessions(agentId)
  res.json({ success: true, deactivated })
})

// --- Claude CLI integration API ---

// Send message to an existing session
app.post('/api/sessions/:id/send', async (req, res) => {
  const sessionId = req.params.id
  const { message } = req.body as SendMessageRequest

  if (typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message must be a non-empty string' })
    return
  }
  if (message.length > 100000) {
    res.status(400).json({ error: 'message exceeds maximum length (100000 chars)' })
    return
  }

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  // Auto-start tmux: if the session is associated with an agent, try sending via tmux
  const agentId = session.agentId
  if (agentId) {
    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (tmuxAgent) {
      const result = tmuxBridge.sendMessage(tmuxAgent.windowName, message.trim())
      if (result.success) {
        res.json({ success: true, via: 'tmux', windowName: tmuxAgent.windowName })
        return
      }
      console.warn(`[API] tmux send failed, falling back to ClaudeBridge: ${result.error}`)
    }
  }

  // Fallback: ClaudeBridge (--print mode)
  const sessionCwd = session.events.find(e => e.metadata.cwd)?.metadata.cwd

  try {
    const processId = claudeBridge.sendToSession(sessionId, message.trim(), sessionCwd)
    res.json({ success: true, processId, via: 'claude-bridge' })
  } catch (err) {
    console.error('[API] Session send error:', err)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Start a new session
app.post('/api/sessions/new', async (req, res) => {
  const { agentId, message, cwd } = req.body as NewSessionRequest

  if (typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message must be a non-empty string' })
    return
  }
  if (message.length > 100000) {
    res.status(400).json({ error: 'message exceeds maximum length (100000 chars)' })
    return
  }
  if (agentId !== undefined && typeof agentId !== 'string') {
    res.status(400).json({ error: 'agentId must be a string' })
    return
  }

  // Auto-start tmux: if agentId is specified, try sending via tmux
  if (agentId) {
    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (tmuxAgent) {
      let result: { success: boolean; error?: string }
      if (tmuxAgent.justStarted) {
        // Just started: the agent launch itself starts a new session,
        // so send the message directly after waiting for the prompt
        const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, 15000)
        if (!ready) {
          console.warn(`[API] Prompt wait timeout for agent "${agentId}"`)
        }
        result = tmuxBridge.sendMessage(tmuxAgent.windowName, message.trim())
      } else {
        // Already running: end existing session with /clear then send new message
        result = await tmuxBridge.clearAndSendMessage(tmuxAgent.windowName, message.trim())
      }
      if (result.success) {
        res.json({ success: true, via: 'tmux', windowName: tmuxAgent.windowName })
        return
      }
      console.warn(`[API] tmux send failed, falling back to ClaudeBridge: ${result.error}`)
    }
  }

  // Fallback: ClaudeBridge (--print mode)
  try {
    const processId = claudeBridge.startNewSession(message.trim(), agentId, cwd)
    res.json({ success: true, processId, via: 'claude-bridge' })
  } catch (err) {
    console.error('[API] New session start error:', err)
    res.status(500).json({ error: 'Failed to start new session' })
  }
})

// Get process status
app.get('/api/process/:id', (req, res) => {
  const proc = claudeBridge.getProcess(req.params.id)
  if (!proc) {
    res.status(404).json({ error: 'Process not found' })
    return
  }
  res.json({
    id: proc.id,
    sessionId: proc.sessionId,
    agentId: proc.agentId,
    status: proc.status,
    startedAt: proc.startedAt,
  })
})

// --- tmux integration API ---

app.get('/api/tmux/status', (_req, res) => {
  const hasSession = tmuxBridge.hasSession()
  const windows = hasSession ? tmuxBridge.listWindows() : []
  const agentWindowMap = hasSession ? tmuxBridge.getAgentWindowMap() : {}
  res.json({ hasSession, sessionName: tmuxBridge.sessionName, windows, agentWindowMap })
})

app.post('/api/tmux/send', (req, res) => {
  const { windowName, message } = req.body as TmuxSendRequest

  if (typeof windowName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(windowName)) {
    res.status(400).json({ error: 'windowName must match /^[a-zA-Z0-9_-]+$/' })
    return
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message must be a non-empty string' })
    return
  }
  if (message.length > 100000) {
    res.status(400).json({ error: 'message exceeds maximum length (100000 chars)' })
    return
  }

  const result = tmuxBridge.sendMessage(windowName, message.trim())
  if (result.success) {
    res.json({ success: true })
  } else {
    res.status(400).json({ success: false, error: result.error })
  }
})

app.post('/api/tmux/clear-and-send', async (req, res) => {
  const { windowName, message } = req.body as TmuxSendRequest

  if (typeof windowName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(windowName)) {
    res.status(400).json({ error: 'windowName must match /^[a-zA-Z0-9_-]+$/' })
    return
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message must be a non-empty string' })
    return
  }
  if (message.length > 100000) {
    res.status(400).json({ error: 'message exceeds maximum length (100000 chars)' })
    return
  }

  const result = await tmuxBridge.clearAndSendMessage(windowName, message.trim())
  if (result.success) {
    res.json({ success: true })
  } else {
    res.status(400).json({ success: false, error: result.error })
  }
})

app.post('/api/tmux/start-agent', async (req, res) => {
  const { agentId, windowName, cwd } = req.body as TmuxStartAgentRequest

  if (!agentId || typeof agentId !== 'string') {
    res.status(400).json({ error: 'agentId is required and must be a string' })
    return
  }
  if (!isValidTmuxName(agentId)) {
    res.status(400).json({ error: 'agentId contains invalid characters for tmux' })
    return
  }
  if (windowName !== undefined && (typeof windowName !== 'string' || !isValidTmuxName(windowName))) {
    res.status(400).json({ error: 'windowName contains invalid characters for tmux' })
    return
  }

  const result = await tmuxBridge.startAgent(agentId, windowName, cwd)
  if (result.success) {
    res.json({ success: true })
  } else {
    res.status(400).json({ success: false, error: result.error })
  }
})

app.get('/api/tmux/capture/:windowName', (req, res) => {
  if (!isValidTmuxName(req.params.windowName)) {
    res.status(400).json({ error: 'Invalid window name' })
    return
  }
  const content = tmuxBridge.capturePane(req.params.windowName)
  if (content === null) {
    res.status(404).json({ error: 'Window not found or capture failed' })
    return
  }
  res.json({ content })
})

// --- Settings API ---

app.get('/api/settings/basic', (_req, res) => {
  try {
    const settings = readBasicSettings(fs, projectRoot)
    res.json(settings)
  } catch (err) {
    console.error('[API] Basic settings read error:', err)
    res.status(500).json({ error: 'Failed to read basic settings' })
  }
})

app.get('/api/settings/skills', (_req, res) => {
  try {
    const skills = readSkills(fs, projectRoot)
    res.json({ skills })
  } catch (err) {
    console.error('[API] Skills read error:', err)
    res.status(500).json({ error: 'Failed to read skills' })
  }
})

app.get('/api/settings/automations', (_req, res) => {
  try {
    const automations = readAutomations(fs, projectRoot)
    res.json(automations)
  } catch (err) {
    console.error('[API] Automations read error:', err)
    res.status(500).json({ error: 'Failed to read automations' })
  }
})

app.get('/api/settings/integrations', (_req, res) => {
  try {
    const integrations = readIntegrations(fs, projectRoot)
    res.json({ integrations })
  } catch (err) {
    console.error('[API] Integrations read error:', err)
    res.status(500).json({ error: 'Failed to read integrations' })
  }
})

app.get('/api/settings/rules', (_req, res) => {
  try {
    const rules = readRules(fs, projectRoot)
    res.json({ rules })
  } catch (err) {
    console.error('[API] Rules read error:', err)
    res.status(500).json({ error: 'Failed to read rules' })
  }
})

// --- Recipe API ---

app.post('/api/recipes/parse', async (req, res) => {
  try {
    const { source } = req.body as RecipeParseRequest
    if (typeof source !== 'string' || source.trim().length === 0) {
      res.status(400).json({ error: 'source must be a non-empty string' })
      return
    }

    const recipe = parseRecipe(source.trim(), fs)
    const inspection = await inspectRecipe(recipe)

    res.json({ recipe, inspection })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse recipe'
    console.error('[API] Recipe parse error:', err)
    res.status(400).json({ error: message })
  }
})

app.post('/api/recipes/apply', async (req, res) => {
  try {
    const { recipe, inspection, agentId } = req.body as RecipeApplyRequest

    if (!recipe || !recipe.metadata) {
      res.status(400).json({ error: 'recipe is required' })
      return
    }
    if (!inspection) {
      res.status(400).json({ error: 'inspection is required' })
      return
    }
    // Re-validate: blocked recipes cannot be applied
    if (inspection.verdict === 'blocked') {
      res.status(403).json({ error: 'Cannot apply a recipe with blocked verdict' })
      return
    }

    // Determine tmux window to send to
    const windowName = agentId || tmuxBridge.listWindows()[0]?.name
    if (!windowName) {
      res.status(400).json({ error: 'No tmux window available. Start an agent first.' })
      return
    }

    const result = await applyRecipe(recipe, tmuxBridge, windowName)
    if (!result.success) {
      res.status(500).json({ error: result.error || 'Failed to apply recipe' })
      return
    }

    // Record history
    const historyId = generateHistoryId(fs)
    appendRecipeHistory(fs, {
      id: historyId,
      name: recipe.metadata.name,
      version: recipe.metadata.version,
      author: recipe.metadata.author,
      source: recipe.sourcePath,
      hash: recipe.hash,
      appliedAt: new Date().toISOString(),
      artifacts: recipe.artifacts.map((a) => a.path),
      menu: recipe.menu.map((m) => m.id),
    })

    res.json({ success: true, historyId })
  } catch (err) {
    console.error('[API] Recipe apply error:', err)
    res.status(500).json({ error: 'Failed to apply recipe' })
  }
})

app.get('/api/recipes/history', (_req, res) => {
  try {
    const history = readRecipeHistory(fs)
    res.json(history)
  } catch (err) {
    console.error('[API] Recipe history error:', err)
    res.status(500).json({ error: 'Failed to read recipe history' })
  }
})

app.post('/api/recipes/export', (req, res) => {
  try {
    const { metadata, format, outputPath } = req.body as RecipeExportRequest

    if (!metadata || typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
      res.status(400).json({ error: 'metadata.name is required' })
      return
    }
    if (!metadata.description || typeof metadata.description !== 'string') {
      res.status(400).json({ error: 'metadata.description is required' })
      return
    }
    if (!metadata.version || typeof metadata.version !== 'string') {
      res.status(400).json({ error: 'metadata.version is required' })
      return
    }
    if (format !== 'directory' && format !== 'markdown') {
      res.status(400).json({ error: 'format must be "directory" or "markdown"' })
      return
    }
    if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
      res.status(400).json({ error: 'outputPath is required' })
      return
    }

    const scan = scanAppDirectory(fs)
    if (scan.artifacts.length === 0) {
      res.status(400).json({ error: 'No artifacts found in app/ directory' })
      return
    }

    if (format === 'directory') {
      exportAsDirectory(fs, scan, metadata, outputPath.trim())
    } else {
      exportAsMarkdown(fs, scan, metadata, outputPath.trim())
    }

    res.json({ success: true, outputPath: outputPath.trim() })
  } catch (err) {
    console.error('[API] Recipe export error:', err)
    res.status(500).json({ error: 'Failed to export recipe' })
  }
})

app.get('/api/recipes/app-scan', (_req, res) => {
  try {
    const result = scanAppDirectory(fs)
    res.json(result)
  } catch (err) {
    console.error('[API] App scan error:', err)
    res.status(500).json({ error: 'Failed to scan app/ directory' })
  }
})

// --- File upload API ---

const UPLOAD_DIR = getUploadDir()
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Initialize upload directory
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// Periodically delete old uploaded files
function cleanupUploads() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return
    const now = Date.now()
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
      const filePath = join(UPLOAD_DIR, file)
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs > UPLOAD_TTL_MS) {
        fs.unlinkSync(filePath)
      }
    }
  } catch { /* Ignore cleanup failures */ }
}
cleanupUploads()
setInterval(cleanupUploads, 60 * 60 * 1000) // Every hour

function getExtFromContentType(contentType: string, originalName?: string): string {
  // Get extension from original filename
  if (originalName) {
    const dotIdx = originalName.lastIndexOf('.')
    if (dotIdx > 0) return originalName.slice(dotIdx)
  }
  // Infer from Content-Type
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'text/csv': '.csv',
  }
  return map[contentType] || '.bin'
}

app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  try {
    const body = req.body as Buffer
    if (!body || body.length === 0) {
      res.status(400).json({ error: 'Empty file' })
      return
    }
    if (body.length > MAX_FILE_SIZE) {
      res.status(413).json({ error: 'File too large (max 20MB)' })
      return
    }

    const contentType = req.headers['content-type'] || 'application/octet-stream'
    const originalName = req.headers['x-original-filename'] as string | undefined
    const ext = getExtFromContentType(contentType, originalName)

    const uuid = randomUUID().slice(0, 12)
    const fileName = `upload-${uuid}${ext}`
    const filePath = join(UPLOAD_DIR, fileName)

    fs.writeFileSync(filePath, body)

    res.json({
      success: true,
      filePath,
      fileName,
      size: body.length,
      contentType,
    })
  } catch (err) {
    console.error('[API] Upload error:', err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// --- File preview API ---

app.get('/api/artifact', (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    res.status(400).json({ error: 'path is required' })
    return
  }
  const resolved = resolveAndValidatePath(filePath)
  if (!resolved) {
    res.status(403).json({ error: 'Access denied: path is outside project root' })
    return
  }
  const result = readArtifact(fs, resolved)
  if (!result) {
    res.status(404).json({ error: 'File not found' })
    return
  }
  res.json(result)
})

app.get('/api/artifact/raw', (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    res.status(400).json({ error: 'path is required' })
    return
  }
  const resolved = resolveAndValidatePath(filePath)
  if (!resolved) {
    res.status(403).json({ error: 'Access denied: path is outside project root' })
    return
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File not found' })
    return
  }
  res.sendFile(resolved)
})

// Mount user-defined API routes from app/api/
await mountAppApiRoutes(app, fs)

// Production: serve built static files
app.use(express.static(join(__dirname, '../../dist')))

// SPA fallback: serve index.html for all non-API, non-WS routes
// Express 5 requires named wildcard parameters (path-to-regexp v8)
app.get('{*path}', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.sendFile(join(__dirname, '../../dist/index.html'))
})

// --- WebSocket: real-time event broadcasting ---
function broadcast(type: string, payload: unknown): void
function broadcast(event: ServerToClientEvent): void
function broadcast(typeOrEvent: string | ServerToClientEvent, payload?: unknown): void {
  const msg =
    typeof typeOrEvent === 'string'
      ? JSON.stringify({ type: typeOrEvent, payload })
      : JSON.stringify(typeOrEvent)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

sessionManager.on('new_event', (sessionId: string, event: unknown) => {
  broadcast('new_event', { sessionId, event })
})

sessionManager.on('status_change', (sessionId: string, status: string) => {
  broadcast('status_change', { sessionId, status })
})

sessionManager.on('new_session', (summary: unknown) => {
  broadcast('new_session', { summary })
})

claudeBridge.on('process_end', (processId: string, status: string, exitCode: number) => {
  broadcast('process_end', { processId, status, exitCode })
})

// --- Trust Prompt Detector startup ---
// Follows spec `docs/specs/trust-prompt-relay.md` v1.1.
// Detects trust prompts per tmux window and relays them to the UI via WebSocket.
//
// Pattern definitions are loaded from `trust-patterns.json`, resolved relative to
// this file (import.meta.url), so it works in both dev (`src/server/`) and
// production (`dist/server/`) by referencing the JSON in the same directory.
// For production builds, `package.json` build script copies to `dist/server/trust-patterns.json`
// (since tsc does not emit .json files).
const trustPatternsPath = fileURLToPath(new URL('./trust-patterns.json', import.meta.url))
const trustPatterns = loadTrustPatterns(fs, trustPatternsPath)
const trustPromptDetector = new TrustPromptDetector(
  tmuxBridge,
  trustPatterns,
  (event) => broadcast(event),
  fs,
)
trustPromptDetector.start()

// Known client-to-server event types (whitelist)
const KNOWN_WS_EVENT_TYPES = new Set<ClientToServerEvent['type']>([
  'trust_prompt_respond',
])

// --- WebSocket: client -> server (trust prompt response handling) ---
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      console.warn('[WS] Received invalid JSON, ignoring')
      return
    }

    // Validate top-level structure: must have a string `type` field
    if (typeof parsed.type !== 'string') {
      console.warn('[WS] Message missing string "type" field, ignoring')
      return
    }

    // Ignore unknown event types
    if (!KNOWN_WS_EVENT_TYPES.has(parsed.type as ClientToServerEvent['type'])) {
      console.warn(`[WS] Unknown event type: "${parsed.type}", ignoring`)
      return
    }

    if (parsed.type === 'trust_prompt_respond') {
      handleTrustPromptRespond(parsed.payload as TrustPromptRespondPayload)
    }
  })
})

function handleTrustPromptRespond(payload: TrustPromptRespondPayload): void {
  // Validate required fields and their types
  if (!payload || typeof payload !== 'object') {
    console.warn('[WS] trust_prompt_respond: payload must be an object')
    return
  }
  if (typeof payload.promptId !== 'string' || payload.promptId.length === 0) {
    console.warn('[WS] trust_prompt_respond: promptId must be a non-empty string')
    return
  }
  if (typeof payload.windowName !== 'string' || payload.windowName.length === 0) {
    console.warn('[WS] trust_prompt_respond: windowName must be a non-empty string')
    return
  }
  if (!payload.response || typeof payload.response !== 'object') {
    console.warn('[WS] trust_prompt_respond: response must be an object')
    return
  }

  const { promptId, windowName, response } = payload

  if (response.mode === 'choice') {
    // Validate choiceId is a non-empty string
    if (typeof response.choiceId !== 'string' || response.choiceId.length === 0) {
      console.warn('[WS] trust_prompt_respond: choiceId must be a non-empty string')
      return
    }
    // The UI sends only choiceId; the actual key sequence conversion is performed
    // by the detector using choices (state.lastChoices) from the most recent notification.
    // This design prevents the UI from injecting arbitrary keys.
    const ok = trustPromptDetector.respondChoice(windowName, promptId, response.choiceId)
    if (!ok) {
      console.warn(
        `[WS] trust_prompt_respond (choice) failed: ${windowName} ${promptId}`,
      )
    }
  } else if (response.mode === 'raw-keys') {
    // Validate rawKeys is a string within the allowed length range
    if (typeof response.rawKeys !== 'string' || response.rawKeys.length < 1 || response.rawKeys.length > 500) {
      console.warn('[WS] trust_prompt_respond: rawKeys must be a string (1-500 chars)')
      return
    }
    const ok = trustPromptDetector.respondRawKeys(windowName, promptId, response.rawKeys)
    if (!ok) {
      console.warn(
        `[WS] trust_prompt_respond (raw-keys) failed: ${windowName} ${promptId}`,
      )
    }
  } else {
    console.warn(`[WS] trust_prompt_respond: unknown response mode: "${(response as { mode: string }).mode}"`)
  }
}

// --- Startup ---
watcher.start()

server.listen(PORT, () => {
  console.log(`[kovitoboard] Server started: http://localhost:${PORT}`)
  console.log(`[kovitoboard] WebSocket: ws://localhost:${PORT}`)
  console.log(`[kovitoboard] Watching: ${config.claudeDir}/projects/`)
})
