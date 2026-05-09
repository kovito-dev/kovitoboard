/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, isAbsolute, resolve, normalize, dirname, basename } from 'path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { randomUUID } from 'crypto'
import { DirectFsLayer } from './fs-layer'
import { loadConfig, resolveProjectRoot, resolveProjectRootWithSource } from './config'
import { ensureKovitoboardDir, ensureLogsDir, getUploadDir } from './paths'
import { initLogger, serverLogger, childLogger, flushAndExit, setupKbContext } from './logger'
import { SessionManager } from './session-manager'
import { Watcher } from './watcher'
import { loadAgentDefinitions, loadSessionAgentRecords, buildSessionAgentMap, getAgentDefinitionContent, appendSessionAgentRecord } from './agent-reader'
import { ClaudeBridge } from './claude-bridge'
import { TmuxBridge, isValidTmuxName } from './tmux-bridge'
import { DataFileWatcher } from './data-file-watcher'
import { readBasicSettings, readSkills, readAutomations, readIntegrations, readRules } from './settings-reader'
import { readArtifact } from './artifact-reader'
import { TrustPromptDetector, loadTrustPatterns } from './trust-prompt-detector'
import { AgentActivityMonitor } from './agent-activity-monitor'
import type { SendMessageRequest, NewSessionRequest, TmuxSendRequest, TmuxStartAgentRequest, SessionOrigin } from './types'
import { mountAppApiRoutes } from './app-api-loader'
import { getInitialPrompt } from './services/initial-prompts'
import { readSetting, writeSetting } from './setting-manager'
import type { KovitoboardSetting } from '../shared/setting-types'
import { createOnboardingRedirect } from './middleware/onboarding-redirect'
import {
  createTokenAndOriginGuard,
  createWsClientVerifier,
  resolveLaunchTokenOrThrow,
} from './middleware/auth'
import { createConfigRouter } from './routes/config-routes'
import { createVersionRouter } from './routes/version-routes'
import {
  detectClaudeCodeVersion,
  loadKbVersion,
  resolveDisabledBy,
} from './version-info'
import { getLatestRelease } from './github-releases-client'
import { createTemplateRouter } from './routes/template-routes'
import { createAvatarRouter } from './routes/avatar-routes'
import { createUserAvatarRouter } from './routes/user-avatar-routes'
import { createRecipeUploadRouter } from './routes/recipe-upload-routes'
import { createAgentWriteRouter } from './routes/agent-write-routes'
import { createAdminRouter } from './routes/admin-routes'
import { createAppRouter } from './routes/app-routes'
import { getMenuTsPath } from './services/menu-extractor'
import { removeMenuEntry } from './services/menu-ts-editor'
import { scanSampleRecipes, getSampleRecipes, refreshInstallStatus } from './services/recipe-scanner'
import { parseRecipe } from './recipe-parser'
import { inspectRecipe } from './recipe-inspector'
import { applyRecipe, buildRecipePrompt } from './recipe-applicator'
import {
  resolveAgentWindowForRecipe,
  buildAgentResolutionError,
} from './services/recipe-agent-resolver'
import {
  validateProposedAppId,
  findAvailableAppId,
} from './services/app-id-collision'
import { readAppManifest } from './services/app-manifest'
import { buildAppRemovalPrompt } from '../shared/app-removal-prompt'
import { readRecipeHistory, appendRecipeHistory, generateHistoryId } from './recipe-history'
import { scanAppDirectory, exportAsMarkdown } from './recipe-exporter'
import type { RecipeParseRequest, RecipeApplyRequest, RecipeExportRequest } from '../shared/recipe-types'
import type {
  ServerToClientEvent,
  ClientToServerEvent,
  TrustPromptRespondPayload,
  ClientLogPayload,
} from '../shared/ws-events'
import { RecipeManifestStore } from './recipeManifestStore'
import { dispatch as dispatchHandler } from './handlerDispatcher'
import { validateApiSection } from './recipe/apiTypes'
import type { KbCallRequest, KbCallResponse, RecipeManifest } from './recipe/apiTypes'
import { validateMarkInstalledRequest } from './recipe/markInstalledValidator'
import { registerHandler } from './handlers/registry'
import { listFilesHandler } from './handlers/categoryA/listFiles'
import { readFileHandler } from './handlers/categoryA/readFile'
import { writeFileHandler } from './handlers/categoryA/writeFile'
import { kvGetHandler } from './handlers/categoryA/kvGet'
import { kvSetHandler } from './handlers/categoryA/kvSet'
import { kvListHandler } from './handlers/categoryA/kvList'
import { kvDeleteHandler } from './handlers/categoryA/kvDelete'
import { notifyHandler } from './handlers/categoryA/notify'
import { exportFileHandler } from './handlers/categoryA/exportFile'
import { getKovitoboardDir } from './paths'

const PORT = Number(process.env.PORT) || 3001
const serverStartTime = Date.now()

// Per-launch authentication token. Resolved once at boot from the env
// var the supervisor (kb-start.mjs) injected. A missing token is fatal:
// the server refuses to start rather than fall through to a degraded
// "no auth" mode, which would silently re-introduce the same-host
// attack surface the token was added to close.
const LAUNCH_TOKEN = resolveLaunchTokenOrThrow()
const verifyTokenAndOrigin = createTokenAndOriginGuard(LAUNCH_TOKEN)
const verifyWsClient = createWsClientVerifier(LAUNCH_TOKEN)

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
    "img-src 'self' data: blob:",
  ].join('; '))
  next()
})

// Per-launch token + Origin allowlist. Scoped to `/api/*` so the
// renderer can still fetch index.html and static assets without the
// token (otherwise it could never bootstrap and read the meta tag
// the token is delivered through). The renderer's kbFetch helper
// adds `X-Kovitoboard-Token` to every API request, and the WebSocket
// upgrade is gated separately by `verifyWsClient` below.
app.use('/api', verifyTokenAndOrigin)

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/api/ws', verifyClient: verifyWsClient })

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

// DEC-017: Initialize the structured logger before anything else that
// might want to log. The logs directory must exist before pino-roll
// opens its rotating stream. The setting is read here (synchronous)
// so the logger can pick up `logging.retentionDays` if configured.
ensureLogsDir(fs)
await initLogger(projectRoot, readSetting(fs))
serverLogger.info({ projectRoot }, 'Logger initialized')

// DEC-017 v1.3 §11: install the user-extension logging context
// (globalThis.kbContext.logger) NOW — before handlers / app/api
// routes are loaded, since those modules typically resolve
// `globalThis.kbContext` at module-evaluation time.
setupKbContext()

// DEC-017 §6: global error handlers — flush logs before exit so the
// last few records survive an abnormal termination.
process.on('uncaughtException', (err) => {
  serverLogger.fatal({ err }, 'Uncaught exception, exiting')
  flushAndExit(1)
})
process.on('unhandledRejection', (reason) => {
  serverLogger.fatal({ err: reason as Error }, 'Unhandled promise rejection, exiting')
  flushAndExit(1)
})

// Per-section component loggers (DEC-017 §4.3). Mirrors existing
// `[bracket]` prefixes so log records remain grep-able by component.
const startupLogger = childLogger('startup')
const apiLogger = childLogger('api')
const wsLogger = childLogger('ws')
const adminLogger = childLogger('admin')
const autoTmuxLogger = childLogger('auto-tmux')

// Scan sample recipes at startup (safe — never throws)
try {
  scanSampleRecipes(fs)
} catch (err) {
  startupLogger.error({ err }, 'Sample recipe scan failed (non-fatal)')
}

// --- Recipe BE: handler registration + manifest store ---
registerHandler(listFilesHandler)
registerHandler(readFileHandler)
registerHandler(writeFileHandler)
registerHandler(kvGetHandler)
registerHandler(kvSetHandler)
registerHandler(kvListHandler)
registerHandler(kvDeleteHandler)
registerHandler(notifyHandler)
registerHandler(exportFileHandler)

const manifestStore = new RecipeManifestStore(getKovitoboardDir(fs), fs)
try {
  manifestStore.loadAll()
} catch (err) {
  startupLogger.error({ err }, 'Manifest store load failed (non-fatal)')
}

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
    autoTmuxLogger.info({ agentId }, 'Agent auto-started via tmux')
    return { windowName: agentId, justStarted: true }
  }

  autoTmuxLogger.warn({ agentId, error: result.error }, 'Failed to start agent via tmux')
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
 * Resolve the requested file path and verify it sits inside one of
 * the allowed roots (the project, or the upload directory). Returns
 * a safe absolute path, or null if the path is invalid.
 *
 * Upload paths (`/tmp/kovitoboard-uploads/...`) need to be readable
 * via `/api/artifact{,/raw}` so the FilePreview pane can render
 * images and files the user just attached to a chat message — those
 * paths live outside `projectRoot`, but they are produced by our
 * own upload endpoint with a UUID-based filename, so allowing reads
 * confined to the upload dir is safe.
 */
function resolveAndValidatePath(requestedPath: string): string | null {
  const resolved = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : normalize(resolve(projectRoot, requestedPath))

  // Project-rooted paths (projectRoot itself is also allowed).
  if (resolved === projectRoot || resolved.startsWith(projectRoot + '/')) {
    return resolved
  }

  // Upload directory. `normalize` already collapsed any `..` segments,
  // so a prefix check on the upload root is enough to keep the read
  // confined to files our own upload endpoint produced.
  const uploadDir = getUploadDir()
  if (resolved === uploadDir || resolved.startsWith(uploadDir + '/')) {
    return resolved
  }

  return null
}

// --- Route modules ---
// Routers handle sub-paths like /api/config/setting, so mount them
// before the existing app.get('/api/config') to give them priority
app.use('/api/config', createConfigRouter(fs, projectRoot))
app.use('/api/templates/agents', createTemplateRouter(fs))
app.use('/api/agents', createAvatarRouter(fs))
app.use(
  '/api/agents',
  createAgentWriteRouter(fs, (payload) => broadcast('agents_changed', payload)),
)
// User avatar (Q11 / SM-4) lives under /api/settings/user/ so it is
// scoped alongside the basic-settings PUT / GET handlers below.
// Mounted on a sibling router rather than embedded in the inline
// block to keep the multipart raw-body parser isolated from the
// JSON parser used by everything else under /api/settings.
app.use('/api/settings/user', createUserAvatarRouter(fs))

// Recipe upload (RC-3): file-picker source. Sits next to the legacy
// path-based /api/recipes/parse endpoint below so the renderer can
// pick whichever surface fits the user's workflow without the two
// crossing wires. The router uses its own json() parser with a
// higher limit so a multi-file recipe payload fits.
app.use('/api/recipes', createRecipeUploadRouter(fs))
app.use('/api/admin', createAdminRouter(tmuxBridge, serverStartTime))
app.use('/api/app', createAppRouter(fs))

// --- /api/version (v0.1.0-version-display.md) ---
// Trust patterns are loaded eagerly here (rather than at L1115 next
// to the detector) so the version router can mount BEFORE the SPA
// fallback below at app.get('{*path}'); otherwise the fallback would
// catch /api/version with a 404. The detector below reuses the same
// trustPatternsConfig variable.
const trustPatternsPathEarly = fileURLToPath(new URL('./trust-patterns.json', import.meta.url))
const trustPatternsConfig = loadTrustPatterns(fs, trustPatternsPathEarly)
app.use('/api/version', createVersionRouter({
  fs,
  trustPatterns: {
    primaryTestedVersion: trustPatternsConfig.primaryTestedVersion,
    bestEffortVersions: trustPatternsConfig.bestEffortVersions,
  },
  // Closure that wraps the same tmux/ClaudeBridge launch flow used by
  // POST /api/sessions/new. The closure captures `tmuxBridge`,
  // `claudeBridge`, etc. by reference, so even though those are
  // declared later in this file, by request time they will have been
  // initialized. Upgrade sessions intentionally do NOT request
  // `origin: "sidebar"` — they live in the standard Sessions surface.
  startUpgradeSession: async ({ agentId, message }) => {
    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (tmuxAgent) {
      let result: { success: boolean; error?: string }
      if (tmuxAgent.justStarted) {
        const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, 45000)
        if (!ready) {
          apiLogger.warn(
            { agentId, timeoutMs: 45000, endpoint: '/api/version/start-upgrade' },
            'Prompt wait timeout for upgrade agent',
          )
        }
        result = await tmuxBridge.sendMessage(tmuxAgent.windowName, message.trim())
      } else {
        result = await tmuxBridge.clearAndSendMessage(tmuxAgent.windowName, message.trim())
      }
      if (result.success) {
        return { via: 'tmux', windowName: tmuxAgent.windowName }
      }
      apiLogger.warn(
        { error: result.error },
        'Upgrade tmux send failed, falling back to ClaudeBridge',
      )
    }
    const processId = claudeBridge.startNewSession(message.trim(), agentId)
    return { via: 'claude-bridge', processId }
  },
}))

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
  // Merge in user display name / project metadata from setting.json and
  // the Markdown-defined agents from .claude/agents/ so the viewer
  // config always reflects the current on-disk state. Without this
  // merge the session view shows "User" / "Default" even after the
  // user has completed onboarding and created agents.
  const setting = readSetting(fs)
  const agentDefs = loadAgentDefinitions(fs, config)

  const mergedAgents: Record<string, { name: string; color: string; avatar?: string; summary?: string }> = {
    ...config.agents,
  }
  for (const a of agentDefs) {
    mergedAgents[a.id] = {
      name: a.displayName || a.id,
      color: a.color,
      avatar: a.avatar,
      summary: a.summary || '',
    }
  }

  const merged = {
    ...config,
    user: {
      ...config.user,
      name: setting?.user?.displayName || config.user.name,
      // Q11 / SM-4 user avatar: surface the relative path persisted
      // by /api/settings/user/avatar so <AgentAvatar avatar={...}>
      // can render the operator's photo on every user message
      // bubble. Falls through to the runtime SVG generator (in
      // <AgentAvatar>) when no upload has been recorded.
      avatar: setting?.user?.avatar ?? undefined,
    },
    agents: mergedAgents,
    project: setting?.project
      ? {
          name: setting.project.name,
          description: setting.project.description,
          concept: config.project?.concept ?? '',
        }
      : config.project,
  }

  res.json(merged)
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
  // Persist the mapping so subsequent restarts or /api/agents requests
  // still know which agent owns this session. Without this the session
  // reverts to the default display name the next time the server
  // starts or re-reads .kovitoboard/session-agents.jsonl.
  try {
    appendSessionAgentRecord(fs, sessionId, agentId)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to persist session-agent record')
  }
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
      const result = await tmuxBridge.sendMessage(tmuxAgent.windowName, message.trim())
      if (result.success) {
        res.json({ success: true, via: 'tmux', windowName: tmuxAgent.windowName })
        return
      }
      apiLogger.warn({ error: result.error }, 'tmux send failed, falling back to ClaudeBridge')
    }
  }

  // Fallback: ClaudeBridge (--print mode)
  const sessionCwd = session.events.find(e => e.metadata.cwd)?.metadata.cwd

  try {
    const processId = claudeBridge.sendToSession(sessionId, message.trim(), sessionCwd)
    res.json({ success: true, processId, via: 'claude-bridge' })
  } catch (err) {
    apiLogger.error({ err }, 'Session send error')
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Start a new session
app.post('/api/sessions/new', async (req, res) => {
  const { agentId, message, cwd, initialPrompt, origin } = req.body as NewSessionRequest

  // If initialPrompt is specified, resolve the prompt text from the dictionary
  let effectiveMessage: string | undefined = message

  if (initialPrompt !== undefined) {
    if (typeof initialPrompt !== 'string' || initialPrompt.trim().length === 0) {
      res.status(400).json({ error: 'initialPrompt must be a non-empty string' })
      return
    }
    const setting = readSetting(fs)
    // English is the OSS fallback when setting.json has not been written
    // yet (first launch) or omits `locale` — mirrors the renderer's
    // `i18n/index.ts` `FALLBACK_LOCALE`.
    const locale = setting?.locale ?? 'en'
    const resolved = getInitialPrompt(initialPrompt, locale)
    if (!resolved) {
      res.status(400).json({ error: `Unknown initialPrompt key: "${initialPrompt}"` })
      return
    }
    effectiveMessage = resolved
  }

  if (typeof effectiveMessage !== 'string' || effectiveMessage.trim().length === 0) {
    res.status(400).json({ error: 'message (or initialPrompt) must be a non-empty string' })
    return
  }
  if (effectiveMessage.length > 100000) {
    res.status(400).json({ error: 'message exceeds maximum length (100000 chars)' })
    return
  }
  if (agentId !== undefined && typeof agentId !== 'string') {
    res.status(400).json({ error: 'agentId must be a string' })
    return
  }
  if (
    origin !== undefined &&
    origin !== 'sidebar' &&
    origin !== 'sessions' &&
    origin !== 'recipe-create-app' &&
    origin !== 'recipe-install' &&
    origin !== 'app-removal'
  ) {
    res.status(400).json({
      error:
        'origin must be "sidebar", "sessions", "recipe-create-app", "recipe-install", or "app-removal"',
    })
    return
  }

  // DEC-020 / EU8: park a pending origin reservation so the resulting
  // session inherits the right origin once the watcher resolves the
  // session's agent. We only reserve when both `agentId` and `origin`
  // are present — `agentId` is the join key on the watcher side.
  if (agentId && origin) {
    sessionManager.reserveOrigin(agentId, origin)
  }

  // Auto-start tmux: if agentId is specified, try sending via tmux
  if (agentId) {
    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (tmuxAgent) {
      let result: { success: boolean; error?: string }
      if (tmuxAgent.justStarted) {
        // Just started: the agent launch itself starts a new session,
        // so send the message directly after waiting for the prompt.
        // Claude Code fetches org / credential info on first launch, so
        // the welcome screen can linger for 15+ seconds before the live
        // prompt appears — wait 45 s before giving up.
        const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, 45000)
        if (!ready) {
          apiLogger.warn(
            { agentId, timeoutMs: 45000, endpoint: req.path },
            'Prompt wait timeout for agent',
          )
        }
        result = await tmuxBridge.sendMessage(tmuxAgent.windowName, effectiveMessage.trim())
      } else {
        // Already running: end existing session with /clear then send new message
        result = await tmuxBridge.clearAndSendMessage(tmuxAgent.windowName, effectiveMessage.trim())
      }
      if (result.success) {
        res.json({ success: true, via: 'tmux', windowName: tmuxAgent.windowName })
        return
      }
      apiLogger.warn({ error: result.error }, 'tmux send failed, falling back to ClaudeBridge')
    }
  }

  // Fallback: ClaudeBridge (--print mode)
  try {
    const processId = claudeBridge.startNewSession(effectiveMessage.trim(), agentId, cwd)
    res.json({ success: true, processId, via: 'claude-bridge' })
  } catch (err) {
    apiLogger.error({ err }, 'New session start error')
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

app.post('/api/tmux/send', async (req, res) => {
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

  const result = await tmuxBridge.sendMessage(windowName, message.trim())
  if (result.success) {
    res.json({ success: true })
  } else {
    res.status(400).json({ success: false, error: result.error })
  }
})

app.post('/api/tmux/interrupt', (req, res) => {
  // Q6 / SS-5: stop button dispatcher. Sends Ctrl-C to the agent's
  // tmux window so Claude Code aborts the in-flight response. The
  // detector loop notices the resulting state change on its own;
  // there is no UI ack beyond the HTTP response.
  const { windowName } = req.body as { windowName?: string }
  if (typeof windowName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(windowName)) {
    res.status(400).json({ error: 'windowName must match /^[a-zA-Z0-9_-]+$/' })
    return
  }
  const ok = tmuxBridge.sendInterrupt(windowName)
  if (ok) {
    res.json({ success: true })
  } else {
    res.status(400).json({ success: false, error: 'failed to send interrupt' })
  }
})

app.post('/api/tmux/clear-and-send', async (req, res) => {
  const { windowName, message, agentId, origin } = req.body as TmuxSendRequest & {
    agentId?: string
    origin?: SessionOrigin
  }

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
  if (agentId !== undefined && typeof agentId !== 'string') {
    res.status(400).json({ error: 'agentId must be a string' })
    return
  }
  if (
    origin !== undefined &&
    origin !== 'sidebar' &&
    origin !== 'sessions' &&
    origin !== 'recipe-create-app' &&
    origin !== 'recipe-install' &&
    origin !== 'app-removal'
  ) {
    res.status(400).json({ error: 'origin has an unsupported value' })
    return
  }

  // Q11 ext / SS-1 fix: park an origin reservation BEFORE the
  // /clear + send pair triggers a new Claude session. Claude Code
  // only emits `agent-setting` when launched with `--agent <id>`
  // (or, more recently, after each /clear-and-send for an
  // already-attached agent process). For the system default agent
  // (Q13 / AA-7) launched via plain `claude`, no such event ever
  // arrives — the SessionManager.ensureSession flow below picks up
  // this reservation and stamps `session.agentId` so downstream
  // consumers (agent-activity-monitor, the Sessions list, etc.)
  // can resolve the new session back to its agent. Skipping when
  // either field is missing keeps the legacy callers (recipe scope,
  // L1 helpers) working without modification.
  if (agentId && origin) {
    sessionManager.reserveOrigin(agentId, origin)
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
    apiLogger.error({ err }, 'Basic settings read error')
    res.status(500).json({ error: 'Failed to read basic settings' })
  }
})

/**
 * Q11 / SM-4: in-place editing of the four basic-settings fields
 * the spec §6.9 declares safe to expose without an agent. Writes a
 * merged copy of `setting.json` so the existing onboarding /
 * versionCheck / ambientSidebar blocks are preserved.
 *
 * Validation mirrors the architect's bounds: displayName 1-50,
 * project.name 1-100, project.description ≤ 200, locale ∈ {ja, en}.
 * `project.path` cannot be edited from this surface — projects are
 * switched via a future "open another project" UI (v0.1.1 backlog).
 */
app.put('/api/settings/basic', (req, res) => {
  const body = (req.body ?? {}) as {
    displayName?: unknown
    locale?: unknown
    projectName?: unknown
    projectDescription?: unknown
  }

  const errors: Record<string, string> = {}

  if (typeof body.displayName !== 'string') {
    errors.displayName = 'displayName must be a string'
  } else {
    const trimmed = body.displayName.trim()
    if (trimmed.length === 0) errors.displayName = 'displayName is required'
    else if (trimmed.length > 50) errors.displayName = 'displayName must be 50 characters or fewer'
  }

  if (body.locale !== 'ja' && body.locale !== 'en') {
    errors.locale = "locale must be either 'ja' or 'en'"
  }

  if (typeof body.projectName !== 'string') {
    errors.projectName = 'projectName must be a string'
  } else {
    const trimmed = body.projectName.trim()
    if (trimmed.length === 0) errors.projectName = 'projectName is required'
    else if (trimmed.length > 100) errors.projectName = 'projectName must be 100 characters or fewer'
  }

  if (body.projectDescription !== undefined && body.projectDescription !== null) {
    if (typeof body.projectDescription !== 'string') {
      errors.projectDescription = 'projectDescription must be a string'
    } else if (body.projectDescription.length > 200) {
      errors.projectDescription = 'projectDescription must be 200 characters or fewer'
    }
  }

  if (Object.keys(errors).length > 0) {
    res.status(400).json({ error: 'Validation failed', fields: errors })
    return
  }

  const existing = readSetting(fs)
  if (!existing) {
    res.status(409).json({ error: 'setting.json is missing — complete onboarding first' })
    return
  }

  const next: KovitoboardSetting = {
    ...existing,
    user: {
      ...existing.user,
      displayName: (body.displayName as string).trim(),
    },
    project: {
      ...existing.project,
      name: (body.projectName as string).trim(),
      description:
        typeof body.projectDescription === 'string'
          ? body.projectDescription.trim()
          : '',
    },
    locale: body.locale as 'ja' | 'en',
  }

  try {
    writeSetting(fs, next)
    apiLogger.info({ displayName: next.user.displayName, locale: next.locale }, 'Basic settings updated')
    res.json({ success: true })
  } catch (err) {
    apiLogger.error({ err }, 'Basic settings write error')
    res.status(500).json({ error: 'Failed to persist basic settings' })
  }
})

app.get('/api/settings/skills', (_req, res) => {
  try {
    const skills = readSkills(fs, projectRoot)
    res.json({ skills })
  } catch (err) {
    apiLogger.error({ err }, 'Skills read error')
    res.status(500).json({ error: 'Failed to read skills' })
  }
})

app.get('/api/settings/automations', (_req, res) => {
  try {
    const automations = readAutomations(fs, projectRoot)
    res.json(automations)
  } catch (err) {
    apiLogger.error({ err }, 'Automations read error')
    res.status(500).json({ error: 'Failed to read automations' })
  }
})

app.get('/api/settings/integrations', (_req, res) => {
  try {
    const integrations = readIntegrations(fs, projectRoot)
    res.json({ integrations })
  } catch (err) {
    apiLogger.error({ err }, 'Integrations read error')
    res.status(500).json({ error: 'Failed to read integrations' })
  }
})

app.get('/api/settings/rules', (_req, res) => {
  try {
    const rules = readRules(fs, projectRoot)
    res.json({ rules })
  } catch (err) {
    apiLogger.error({ err }, 'Rules read error')
    res.status(500).json({ error: 'Failed to read rules' })
  }
})

// --- Recipe API ---

app.get('/api/recipes/sample', (_req, res) => {
  try {
    // Refresh install status against current history before returning
    refreshInstallStatus(fs)
    const recipes = getSampleRecipes()
    res.json(recipes)
  } catch (err) {
    apiLogger.error({ err }, 'Sample recipes error')
    res.status(500).json({ error: 'Failed to get sample recipes' })
  }
})

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
    apiLogger.error({ err }, 'Recipe parse error')
    res.status(400).json({ error: message })
  }
})

app.post('/api/recipes/apply', async (req, res) => {
  // Deprecated in v0.1.0 (DEC-024 #2 / spec F8). The agent-handover
  // install flow at `POST /api/recipes/install` (and the dispatcher
  // setup at `POST /api/recipes/<recipeId>/mark-installed`) supersedes
  // this route. The legacy endpoint is kept for backward compatibility
  // with existing L1 E2E coverage and direct API callers; it will be
  // removed in v0.2.0.
  apiLogger.warn(
    { route: '/api/recipes/apply' },
    'POST /api/recipes/apply is deprecated and will be removed in v0.2.0. ' +
    'Use POST /api/recipes/install with the v2.0 agent-handover flow ' +
    '(spec docs/specs/v0.1.0-recipe-install-handover.md §3.2).',
  )
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

    // Resolve the tmux agent window to send to. We MUST target an
    // interactive `claude --agent <id>` window, not the bare `main`
    // shell tmux creates alongside the session — otherwise the recipe
    // prompt is pasted into bash and silently lost.
    //
    // The resolver reuses an already-running window when one exists,
    // and otherwise auto-launches `kovito-concierge` (or the first
    // registered agent) and waits for the live input prompt before
    // proceeding. Failure modes (no agents / startup failed / startup
    // timeout because of a folder-trust prompt) come back as a
    // structured resolution that we translate into an actionable
    // 409 / 500 / 503 response.
    const resolution = await resolveAgentWindowForRecipe(fs, config, tmuxBridge, {
      preferredAgentId: agentId,
    })
    if (resolution.kind !== 'ready') {
      const { status, error } = buildAgentResolutionError(resolution)
      apiLogger.warn(
        { resolution },
        'Recipe apply aborted: agent window unavailable',
      )
      res.status(status).json({ error })
      return
    }
    const windowName = resolution.windowName

    const result = await applyRecipe(recipe, inspection, tmuxBridge, windowName)
    if (!result.success) {
      res.status(500).json({ error: result.error || 'Failed to apply recipe' })
      return
    }

    // Record history
    const historyId = generateHistoryId(fs)
    appendRecipeHistory(fs, {
      id: historyId,
      action: 'install',
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
    apiLogger.error({ err }, 'Recipe apply error')
    res.status(500).json({ error: 'Failed to apply recipe' })
  }
})

app.get('/api/recipes/history', (_req, res) => {
  try {
    const history = readRecipeHistory(fs)
    res.json(history)
  } catch (err) {
    apiLogger.error({ err }, 'Recipe history error')
    res.status(500).json({ error: 'Failed to read recipe history' })
  }
})

// `recipeId` constraint mirrors `RecipeMetadata.recipeId` (DEC-024 D-8):
// `/^[A-Za-z0-9_\-./@]+$/` and 1〜256 characters. Validated server-side
// even though the modal already enforces it client-side, because export
// writes recipe.yaml verbatim and a malformed id would silently produce
// a recipe that the parser cannot round-trip.
const RECIPE_ID_RE = /^[A-Za-z0-9_\-./@]+$/

/**
 * Build a safe `Content-Disposition` filename from the recipeId.
 *
 * `recipeId` is constrained to `/^[A-Za-z0-9_\-./@]+$/` server-side,
 * but `/` and `@` would still produce awkward filenames on download
 * (path separators / shell quoting). Replace anything outside the
 * filename-safe set with `_` and append `.md`. Pure ASCII so we never
 * need RFC 5987 `filename*=UTF-8''` quoting.
 */
function buildRecipeDownloadFilename(recipeId: string): string {
  const sanitized = recipeId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${sanitized}.md`
}

app.post('/api/recipes/export', (req, res) => {
  try {
    const { appId, metadata } = req.body as RecipeExportRequest

    if (typeof appId !== 'string' || appId.trim().length === 0) {
      res.status(400).json({ error: 'appId is required' })
      return
    }
    if (!metadata || typeof metadata.recipeId !== 'string' || metadata.recipeId.trim().length === 0) {
      res.status(400).json({ error: 'metadata.recipeId is required' })
      return
    }
    if (metadata.recipeId.length > 256 || !RECIPE_ID_RE.test(metadata.recipeId)) {
      res.status(400).json({
        error: 'metadata.recipeId must match /^[A-Za-z0-9_\\-./@]+$/ and be 1–256 chars',
      })
      return
    }
    if (typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
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

    const scan = scanAppDirectory(fs, appId.trim())

    // Refuse export when the app contains custom backend files.
    // Backend route handlers (`app/<appId>/api/*.ts`) live outside
    // the recipe safety boundary — recipe-inspector's path-prefix
    // restriction rejects `api/` at install time, so packaging them
    // would produce a recipe that cannot be re-installed. Instead of
    // silently dropping or repackaging them as `lib`, surface the
    // boundary at the export boundary with an actionable guidance
    // message.
    //
    // The scanner already bounds `customBeFiles` to a fixed sample
    // size (see `recipe-exporter.ts`); we additionally trim the
    // response payload to the first 10 entries so the JSON we ship
    // and the string the modal concatenates stay small even when
    // the sample cap is set higher upstream. `customBeFilesCount`
    // is the accurate total (counted while scanning) and is what
    // the UI uses to show "...and N more". The cap is pure
    // response-shaping: refusal triggers as soon as ≥ 1 file under
    // `app/<appId>/api/` exists, regardless of extension.
    const MAX_CUSTOM_BE_FILES_IN_RESPONSE = 10
    if (scan.customBeFilesCount > 0) {
      const sample = scan.customBeFiles
        .slice(0, MAX_CUSTOM_BE_FILES_IN_RESPONSE)
        .map((f) => f.relativePath)
      // Send only structured data; the user-facing prose is
      // localized client-side (single source of truth for the
      // policy text, no drift between server and i18n catalogs).
      res.status(400).json({
        error: 'CustomBeNotExportable',
        files: sample,
        filesCount: scan.customBeFilesCount,
        filesCountApproximate: scan.customBeFilesCountApproximate,
      })
      return
    }

    if (scan.artifacts.length === 0) {
      res.status(400).json({ error: `No artifacts found under app/${appId.trim()}/` })
      return
    }

    // Recipe-installed apps carry their `api:` declarations in the
    // manifest; user-authored apps do not. Pass `null` in the latter
    // case so the writer omits the `api:` section, leaving the
    // receiving install flow to surface the missing-handler warning.
    const manifest = manifestStore.get(appId.trim())
    const api = manifest ? manifest.api : null

    // Build the recipe document in memory and stream it as a download.
    // Nothing is written to disk on the server side — the browser is
    // responsible for saving the file (see DEC-024 #5 follow-up,
    // 2026-05-04: directory format and explicit outputPath dropped).
    const markdown = exportAsMarkdown(fs, appId.trim(), scan, metadata, api)
    const filename = buildRecipeDownloadFilename(metadata.recipeId.trim())

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'no-store')
    // RE-1: certain Chrome builds raise an "Add ID card?" Digital
    // Credentials prompt on the download response. Explicitly opt the
    // route out of identity-credentials feature policies so the
    // browser does not try to intercept the markdown bytes for
    // FedCM / Digital Credentials parsing.
    res.setHeader('Permissions-Policy', 'identity-credentials-get=(), publickey-credentials-get=()')
    res.send(markdown)
  } catch (err) {
    apiLogger.error(
      {
        err: err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      },
      'Recipe export error',
    )
    res.status(500).json({ error: 'Failed to export recipe' })
  }
})

app.get('/api/recipes/app-scan', (req, res) => {
  try {
    const appId = typeof req.query.appId === 'string' ? req.query.appId : ''
    if (appId.trim().length === 0) {
      res.status(400).json({ error: 'appId query parameter is required' })
      return
    }
    const result = scanAppDirectory(fs, appId.trim())
    res.json(result)
  } catch (err) {
    apiLogger.error({ err }, 'App scan error')
    res.status(500).json({ error: 'Failed to scan app/ directory' })
  }
})

// --- Recipe Install API (DEC-024 #2 / spec §3.2 — agent-handover) ---
//
// v2.0 contract:
//   Input  : { recipe, inspection, agentId, recipeSource }
//   Output : { ok: true, agentId, via, windowName? }
//
// What this endpoint **no longer** does (compared to v1.x):
//   - It does NOT write `app/<artifact.path>` files.
//   - It does NOT edit `app/menu.ts`.
//   - It does NOT save `recipes-installed/<appId>/manifest.json`.
//   - It does NOT mkdir `app/data/<appId>/`.
//   - It does NOT append a `recipe-history.jsonl` install record.
//
// All of the above are now agent responsibilities, walked through
// the 7-step playbook in `recipe-applicator.buildRecipePrompt`. The
// agent reports back via `POST /api/recipes/<recipeId>/mark-installed`,
// which is the surface that persists the manifest + history.
//
// What this endpoint DOES:
//   1. Validates the recipe shape and the agentId.
//   2. Builds the v2.0 install prompt.
//   3. Reserves the install origin so the resulting session inherits
//      `origin: 'recipe-install'` once the watcher picks it up.
//   4. Starts (or reuses) the agent's tmux window and sends the
//      prompt. Mirrors `/api/sessions/new`'s tmux-first behavior so
//      we get the same auto-start / clear-and-send semantics.
//
// The response shape mirrors `/api/sessions/new`: we cannot return a
// Claude `sessionId` synchronously because Claude writes the session
// JSONL only after `--print` returns (the existing `recipe-create-app`
// flow has the same constraint and navigates to
// `/agents/<agentId>?openLatestSession=1` to bridge the gap). The
// renderer follows the same pattern for `recipe-install`.

app.post('/api/recipes/install', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const recipe = body.recipe
    const inspectionInput = body.inspection
    const agentIdRaw = body.agentId
    const recipeSource = body.recipeSource

    // -- Recipe validation (minimal; the parser already vetted shape) --
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
      res.status(400).json({ error: 'recipe is required' })
      return
    }
    const parsed = recipe as Record<string, unknown>
    if (!parsed.metadata || typeof parsed.metadata !== 'object') {
      res.status(400).json({ error: 'recipe.metadata is required' })
      return
    }
    const metadata = parsed.metadata as Record<string, unknown>
    if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
      res.status(400).json({ error: 'recipe.metadata.name is required' })
      return
    }
    if (typeof metadata.recipeId !== 'string' || metadata.recipeId.length === 0) {
      res.status(400).json({ error: 'recipe.metadata.recipeId is required' })
      return
    }

    // The api section is optional in v2.0 — recipes without
    // declarative handlers still install. When present, validate
    // shape early so a malformed api never reaches the prompt.
    if (parsed.api !== undefined && parsed.api !== null) {
      const apiValidation = validateApiSection(parsed.api)
      if (apiValidation) {
        res.status(400).json({ error: `Invalid api section: ${apiValidation}` })
        return
      }
    }

    if (typeof agentIdRaw !== 'string' || agentIdRaw.length === 0) {
      res.status(400).json({ error: 'agentId is required' })
      return
    }
    const agentId = agentIdRaw

    if (
      recipeSource !== 'sample' &&
      recipeSource !== 'import' &&
      recipeSource !== 'url'
    ) {
      res.status(400).json({
        error: 'recipeSource must be one of: sample, import, url',
      })
      return
    }

    // -- Inspection: prefer the FE-provided result, fall back to recompute --
    //
    // The FE has typically just called `/api/recipes/parse` and has
    // a fresh `InspectionResult`. We accept it as a hint to avoid a
    // second inspection pass. When absent / malformed, fall back to
    // a fresh `inspectRecipe` so the prompt's "inspection result"
    // section never goes stale.
    let inspection: Awaited<ReturnType<typeof inspectRecipe>>
    if (
      inspectionInput &&
      typeof inspectionInput === 'object' &&
      typeof (inspectionInput as Record<string, unknown>).pureDeclarative === 'boolean'
    ) {
      inspection = inspectionInput as Awaited<ReturnType<typeof inspectRecipe>>
    } else {
      inspection = await inspectRecipe(parsed as unknown as Parameters<typeof inspectRecipe>[0])
    }

    // -- Build the v2.0 install prompt --
    //
    // Pass the `{ fs, projectRoot }` context so the prompt builder
    // can scan `app/<appId>/manifest.json` and surface a "reinstall
    // detection" section listing every app that already shares this
    // recipeId (DEC-024 #4 / spec §3.5).
    const prompt = buildRecipePrompt(
      parsed as unknown as Parameters<typeof buildRecipePrompt>[0],
      inspection,
      { fs, projectRoot },
    )

    // -- Reserve origin so the resulting session is tagged --
    sessionManager.reserveOrigin(agentId, 'recipe-install')

    // -- Tmux-first delivery (mirrors `/api/sessions/new`) --
    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (!tmuxAgent) {
      apiLogger.warn(
        { agentId, recipeId: metadata.recipeId },
        'Recipe install: failed to start tmux agent window',
      )
      res.status(503).json({
        error: `Could not start tmux agent window for "${agentId}". Make sure tmux is installed and the agent definition exists.`,
      })
      return
    }

    let result: { success: boolean; error?: string }
    if (tmuxAgent.justStarted) {
      // Wait for the prompt before sending. Claude Code's first
      // launch can linger 15+ seconds while it fetches credentials,
      // so we wait up to 45 seconds before giving up.
      const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, 45000)
      if (!ready) {
        apiLogger.warn(
          { agentId, timeoutMs: 45000, endpoint: req.path },
          'Prompt wait timeout for agent (recipe-install)',
        )
      }
      result = await tmuxBridge.sendMessage(tmuxAgent.windowName, prompt)
    } else {
      // Already running: end the existing session with `/clear` and
      // start fresh so the install handover prompt is the first
      // message of the new conversation.
      result = await tmuxBridge.clearAndSendMessage(tmuxAgent.windowName, prompt)
    }

    if (!result.success) {
      apiLogger.error(
        { err: result.error, agentId, recipeId: metadata.recipeId, windowName: tmuxAgent.windowName },
        'Recipe install failed: tmux send returned an error',
      )
      res.status(500).json({
        error: result.error || 'Failed to deliver the install handover prompt to the agent.',
      })
      return
    }

    apiLogger.info(
      { agentId, recipeId: metadata.recipeId, recipeSource, windowName: tmuxAgent.windowName },
      'Recipe install handover dispatched',
    )
    res.json({
      ok: true,
      agentId,
      via: 'tmux',
      windowName: tmuxAgent.windowName,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Recipe install error')
    res.status(500).json({ error: 'Failed to install recipe' })
  }
})

// --- Recipe Mark-Installed API (DEC-024 #2 / spec §3.3) ---
//
// The agent calls this after it has placed the artifacts and written
// `app/<appId>/manifest.json`. KB persists the recipe-side manifest
// at `recipes-installed/<appId>/manifest.json` (the dispatcher's
// scope source) and appends an install record to
// `recipe-history.jsonl`. Idempotent on (appId, recipeId, hash).

app.post('/api/recipes/:recipeId/mark-installed', async (req, res) => {
  try {
    const recipeIdParam = req.params.recipeId
    const validation = validateMarkInstalledRequest(recipeIdParam, req.body)
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error })
      return
    }
    const { appId, approvedScopes, recipeVersion, recipeSource, recipeHash, api } =
      validation.value

    // Idempotency: if a history record with the same (recipeId,
    // appId, hash, action='install') already exists, return ok
    // without rewriting state. The agent retried `mark-installed` —
    // a perfectly normal recovery path.
    const existingHistory = readRecipeHistory(fs)
    const alreadyRecorded = existingHistory.some(
      (h) =>
        h.action !== 'uninstall' &&
        h.recipeId === recipeIdParam &&
        h.hash === recipeHash &&
        // We stored the appId on the history entry under the
        // legacy key; once Phase F splits the field, this reads from
        // a dedicated `appId` field instead.
        (h as { appId?: string }).appId === appId,
    )
    if (alreadyRecorded) {
      res.json({ ok: true })
      return
    }

    // Persist the recipe-side manifest. The dispatcher's
    // `manifestStore.refresh()` (or `loadAll()`) re-reads this file
    // when it needs to resolve handler calls.
    const manifest: RecipeManifest = {
      appId,
      recipeId: recipeIdParam,
      recipeVersion,
      hash: recipeHash,
      installedAt: new Date().toISOString(),
      approvedScopes,
      api: api ?? { scopes: [], calls: [] },
    }
    manifestStore.save(manifest)

    // Append the install record to recipe-history.jsonl. The
    // recipeId field now stores the recipe author's id (per
    // DEC-024 D-8); the appId is captured separately. Older
    // entries in the same file may still hold appId in `recipeId`;
    // `findHistoryMatch` and `entryMatchesRecipeId` already cope.
    const historyId = generateHistoryId(fs)
    appendRecipeHistory(fs, {
      id: historyId,
      action: 'install',
      // legacy `name` field — kept for v0.1.x history readers that
      // do not yet consult `recipeId`.
      name: recipeIdParam,
      version: recipeVersion,
      source: recipeSource,
      hash: recipeHash,
      appliedAt: manifest.installedAt,
      artifacts: [],
      menu: [],
      recipeId: recipeIdParam,
      // Agent-handover history records carry both ids; the upcoming
      // RecipeHistoryEntry shape change formalises `appId` as a
      // first-class field. Until then we cast it through.
      ...({ appId } as Record<string, unknown>),
    })

    apiLogger.info(
      { recipeId: recipeIdParam, appId, recipeVersion, recipeSource },
      'Recipe marked as installed by agent',
    )
    res.json({ ok: true })
  } catch (err) {
    apiLogger.error({ err }, 'mark-installed error')
    res.status(500).json({ error: 'Failed to mark recipe as installed' })
  }
})

// --- App Removal API (DEC-024 #3 / spec §6.3) ---
//
// `POST /api/apps/:appId/request-removal { agentId }` reads the
// app's manifest (best-effort; null is fine), builds the removal
// prompt, reserves origin: 'app-removal', and dispatches the
// agent dialog via tmux. The agent walks the user through `app/`
// cleanup using the 5-step playbook embedded in the prompt.
//
// No new dispatcher / manifest state is mutated by this route — the
// agent does the actual deletion. KB only kicks off the dialog.

const APP_REMOVAL_APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

app.post('/api/apps/:appId/request-removal', async (req, res) => {
  try {
    const appId = req.params.appId
    if (typeof appId !== 'string' || !APP_REMOVAL_APP_ID_PATTERN.test(appId)) {
      res.status(400).json({
        error: 'appId path parameter must match /^[a-z][a-z0-9-]{0,63}$/',
      })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const agentId = body.agentId
    if (typeof agentId !== 'string' || agentId.length === 0) {
      res.status(400).json({ error: 'agentId is required' })
      return
    }

    // Best-effort manifest read. The agent can still complete the
    // removal even when the manifest is missing — it falls back on
    // the app/menu.ts entry and a directory existence check during
    // Step 1.
    const manifest = readAppManifest(fs, projectRoot, appId)
    const displayName = manifest?.displayName ?? appId

    let prompt: string
    try {
      prompt = buildAppRemovalPrompt({ appId, displayName, manifest })
    } catch (err) {
      apiLogger.error({ err, appId }, 'buildAppRemovalPrompt threw')
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to build removal prompt',
      })
      return
    }

    // Reserve origin so the resulting session inherits the
    // 'app-removal' tag (mirrors the recipe-install flow).
    sessionManager.reserveOrigin(agentId, 'app-removal')

    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (!tmuxAgent) {
      apiLogger.warn(
        { agentId, appId },
        'App removal: failed to start tmux agent window',
      )
      res.status(503).json({
        error: `Could not start tmux agent window for "${agentId}". Make sure tmux is installed and the agent definition exists.`,
      })
      return
    }

    let result: { success: boolean; error?: string }
    if (tmuxAgent.justStarted) {
      const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, 45000)
      if (!ready) {
        apiLogger.warn(
          { agentId, timeoutMs: 45000, endpoint: req.path },
          'Prompt wait timeout for agent (app-removal)',
        )
      }
      result = await tmuxBridge.sendMessage(tmuxAgent.windowName, prompt)
    } else {
      result = await tmuxBridge.clearAndSendMessage(tmuxAgent.windowName, prompt)
    }

    if (!result.success) {
      apiLogger.error(
        { err: result.error, agentId, appId, windowName: tmuxAgent.windowName },
        'App removal failed: tmux send returned an error',
      )
      res.status(500).json({
        error: result.error || 'Failed to deliver the removal prompt to the agent.',
      })
      return
    }

    apiLogger.info(
      { agentId, appId, windowName: tmuxAgent.windowName },
      'App removal handover dispatched',
    )
    res.json({
      ok: true,
      agentId,
      via: 'tmux',
      windowName: tmuxAgent.windowName,
    })
  } catch (err) {
    apiLogger.error({ err }, 'App removal error')
    res.status(500).json({ error: 'Failed to request app removal' })
  }
})

// --- Recipe Uninstall API ---

app.post('/api/recipes/uninstall', async (req, res) => {
  try {
    const { recipeId, deleteOwnData } = req.body as {
      recipeId: unknown
      deleteOwnData?: unknown
    }

    if (typeof recipeId !== 'string' || recipeId.length === 0) {
      res.status(400).json({ error: 'recipeId must be a non-empty string' })
      return
    }
    const shouldDeleteOwnData = deleteOwnData === true

    // Pull state we need before mutating anything. Even if the
    // manifest was lost (e.g. the user hand-edited the project), we
    // still want to be able to undo `app/menu.ts` + history, so a
    // missing manifest is a warning rather than a hard error.
    const manifest = manifestStore.get(recipeId)
    if (!manifest) {
      apiLogger.warn(
        { recipeId },
        'Uninstall requested for a recipeId without a manifest; proceeding with best-effort cleanup',
      )
    }

    // Recover the install entry — we use it to know which artifact
    // paths to remove and to preserve metadata (name / hash / version)
    // on the uninstall history record.
    const history = readRecipeHistory(fs)
    const installEntry = findLatestInstallEntry(history, recipeId)
    if (!installEntry && !manifest) {
      res.status(404).json({ error: `No install record found for recipeId "${recipeId}"` })
      return
    }

    // 1. Remove the artifact files. Sourced from the install history
    //    (recipe-applicator wrote them under app/<artifact.path>).
    //    Best-effort: a missing file is fine (we may have been
    //    invoked twice, or the user removed it manually).
    const artifactPaths = installEntry?.artifacts ?? []
    const removedArtifacts: string[] = []
    for (const rel of artifactPaths) {
      // Defensive: never let a `..` segment escape the project's
      // app/ directory. The recipe-applicator only ever writes
      // under app/, so a `..` here would be either a corrupted
      // history record or a malicious one.
      if (rel.split(/[\\/]/).includes('..')) {
        apiLogger.warn({ recipeId, rel }, 'Skipping artifact with traversal segment')
        continue
      }
      const abs = join(projectRoot, 'app', rel)
      if (fs.existsSync(abs)) {
        try {
          fs.unlinkSync(abs)
          removedArtifacts.push(rel)
        } catch (err) {
          apiLogger.warn({ err, abs }, 'Failed to delete artifact during uninstall')
        }
      }
    }

    // 2. Remove menu entries. Each menu entry id from the install
    //    record is stripped from app/menu.ts. We tolerate not-found
    //    (already removed by hand) and log parse-failed (file is in
    //    an unexpected shape).
    const menuIds = installEntry?.menu ?? []
    const menuPath = join(projectRoot, 'app', 'menu.ts')
    const removedMenuIds: string[] = []
    if (menuIds.length > 0 && fs.existsSync(menuPath)) {
      let menuContent = fs.readFileSync(menuPath, 'utf-8')
      let mutated = false
      for (const menuId of menuIds) {
        const result = removeMenuEntry(menuContent, menuId)
        if (result.kind === 'removed') {
          menuContent = result.content
          removedMenuIds.push(menuId)
          mutated = true
        } else if (result.kind === 'parse-failed') {
          apiLogger.warn(
            { recipeId, menuId, reason: result.reason },
            'menu.ts parse failed during uninstall; leaving file untouched',
          )
          break
        }
        // 'not-found' is silent — the entry may have been removed manually.
      }
      if (mutated) {
        // Atomic replace: a partial menu.ts write would surface as a
        // syntax error on the next read and break the entire menu.
        fs.writeFileAtomic(menuPath, menuContent)
      }
    }

    // 3. Remove the manifest. Manifest cache + on-disk file go
    //    together; the manifest dispatcher gates handler calls so
    //    once the manifest is gone the recipe is effectively
    //    deactivated even if some files remain.
    if (manifest) {
      manifestStore.delete(recipeId)
    }
    // Also drop the empty parent directory under recipes-installed/
    // so it does not linger.
    const installedDir = join(getKovitoboardDir(fs), 'recipes-installed', recipeId)
    if (fs.existsSync(installedDir)) {
      try {
        fs.rmSync(installedDir, { recursive: true, force: true })
      } catch (err) {
        apiLogger.warn({ err, installedDir }, 'Failed to remove recipes-installed dir')
      }
    }

    // 4. Optionally delete own-data. Default is to *preserve* user
    //    data unless the caller explicitly opts in via
    //    `deleteOwnData: true`, so a re-install can recover state.
    let ownDataDeleted = false
    const ownDataDir = join(projectRoot, 'app', 'data', recipeId)
    if (shouldDeleteOwnData && fs.existsSync(ownDataDir)) {
      try {
        fs.rmSync(ownDataDir, { recursive: true, force: true })
        ownDataDeleted = true
      } catch (err) {
        apiLogger.warn({ err, ownDataDir }, 'Failed to delete own-data during uninstall')
      }
    }

    // 5. Append the uninstall record to history. The recipe-scanner
    //    walks history in reverse and treats the most recent entry
    //    for a recipe as the source of truth, so this flips the
    //    "installed" badge back to the "before install" lane.
    const historyId = generateHistoryId(fs)
    appendRecipeHistory(fs, {
      id: historyId,
      action: 'uninstall',
      name: installEntry?.name ?? recipeId,
      // `RecipeManifest.recipeVersion` was renamed from the legacy
      // `version` (DEC-024 / spec §3.5). Fall back to the install
      // history entry first because that always carries the
      // recipe's `version` field shape.
      version: installEntry?.version ?? manifest?.recipeVersion ?? '0.0.0',
      author: installEntry?.author,
      source: installEntry?.source ?? '',
      hash: installEntry?.hash ?? manifest?.hash ?? '',
      appliedAt: new Date().toISOString(),
      artifacts: removedArtifacts,
      menu: removedMenuIds,
      recipeId,
      ownDataDeleted,
    })

    apiLogger.info(
      {
        recipeId,
        artifactsRemoved: removedArtifacts.length,
        menuIdsRemoved: removedMenuIds.length,
        ownDataDeleted,
      },
      'Recipe uninstalled',
    )

    res.json({
      success: true,
      historyId,
      recipeId,
      artifactsRemoved: removedArtifacts,
      menuIdsRemoved: removedMenuIds,
      ownDataDeleted,
    })
  } catch (err) {
    apiLogger.error({ err }, 'Recipe uninstall error')
    res.status(500).json({ error: 'Failed to uninstall recipe' })
  }
})

// --- App ID Collision-Avoidance API (DEC-024 D-1) ---

/**
 * Check whether a proposed `appId` is available, and if not,
 * suggest a suffix-numbered alternative. Called by agents (and the
 * future `AppCreateModal`) before they commit to a specific app
 * id, so we never persist two apps under the same key.
 *
 * Spec: docs/specs/v0.1.0-app-id-and-manifest.md §3.1.
 *
 * Wire shape (request / response): see the spec; in short,
 *   { proposedId } -> { available, suggested?, reason? }
 *
 * Error codes:
 *   - 400 when `proposedId` is missing or fails the format regex.
 *   - 500 when the project filesystem cannot be scanned, or when
 *     no free suffix is available within `SUFFIX_MAX_INDEX` tries.
 */
app.post('/api/apps/check-id-availability', (req, res) => {
  try {
    const body = (req.body ?? {}) as { proposedId?: unknown }
    const validation = validateProposedAppId(body.proposedId)
    if (validation.kind === 'invalid') {
      res.status(400).json({ error: validation.reason })
      return
    }
    // `validateProposedAppId` already narrowed `proposedId` to a
    // matching string; cast to keep the type-checker happy without
    // refetching from the body.
    const proposedId = body.proposedId as string

    const result = findAvailableAppId(fs, projectRoot, proposedId)
    if (result.available) {
      res.json({ available: true })
      return
    }
    if (result.suggested == null) {
      // Exhausted the suffix budget — surface as a 500 because the
      // caller cannot recover without a different proposal.
      res.status(500).json({ error: result.reason })
      return
    }
    res.json({
      available: false,
      suggested: result.suggested,
      reason: result.reason,
    })
  } catch (err) {
    apiLogger.error({ err }, 'check-id-availability error')
    res.status(500).json({ error: 'Failed to check app-id availability' })
  }
})

/**
 * Find the most recent `install` entry for a given recipeId. Used by
 * the uninstall endpoint to recover artifact paths and metadata.
 *
 * Matches first by the explicit `recipeId` field (set on entries
 * written after the lifecycle-action change), and falls back to the
 * legacy heuristic ("first menu entry id" derived at install time)
 * for entries written before that field existed.
 */
function findLatestInstallEntry(
  history: import('../shared/recipe-types').RecipeHistoryEntry[],
  recipeId: string,
): import('../shared/recipe-types').RecipeHistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.action === 'uninstall') continue
    if (h.recipeId === recipeId) return h
    // Legacy fallback: install entries written before `recipeId` was
    // captured had `menu: ['<recipeId>', ...]` because the renderer
    // resolves recipeId from the first menu entry id.
    if (Array.isArray(h.menu) && h.menu[0] === recipeId) return h
  }
  return undefined
}

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
    apiLogger.error({ err }, 'Upload error')
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

// Production: serve built static files. `index: false` is critical
// here — without it Express short-circuits `GET /` (and `GET
// /index.html`) by sending the on-disk `dist/index.html` directly,
// which still contains the `<!-- KB:LAUNCH_TOKEN_META -->` placeholder
// that the SPA fallback below replaces with the real token meta tag.
// Letting the static middleware win would boot the renderer without a
// token, and every `/api/*` call would fail with 401 until the user
// manually reloaded.
//
// `index: false` only suppresses directory-default `index.html`
// resolution (e.g. `GET /` falling through to `dist/index.html`); it
// does NOT block an explicit `GET /index.html`. The dedicated route
// below catches that case so a bookmark or curl that targets the file
// by name still receives the substituted HTML.
const distIndexPath = join(__dirname, '../../dist/index.html')
const distIndexCache: string | null = (() => {
  if (process.env.KOVITOBOARD_MODE !== 'prod') return null
  try {
    const raw = fs.readFileSync(distIndexPath, 'utf-8')
    return raw.replace(
      '<!-- KB:LAUNCH_TOKEN_META -->',
      `<meta name="kb-launch-token" content="${LAUNCH_TOKEN}">`,
    )
  } catch {
    // Missing dist is already diagnosed by the explicit check at
    // startup (search for KOVITOBOARD_MODE === 'prod' below); fall
    // through to res.sendFile so any later error is surfaced normally.
    return null
  }
})()

app.get('/index.html', (_req, res) => {
  if (distIndexCache !== null) {
    res.type('html').send(distIndexCache)
    return
  }
  res.sendFile(distIndexPath)
})

app.use(express.static(join(__dirname, '../../dist'), { index: false }))

// Onboarding redirect: redirect to /onboarding if not completed
app.use(createOnboardingRedirect(fs))

// SPA fallback: serve index.html for all non-API, non-WS routes.
// In prod mode the renderer receives a copy of `dist/index.html`
// whose `<!-- KB:LAUNCH_TOKEN_META -->` placeholder has been replaced
// with the real token meta tag (see distIndexCache above). The Vite
// dev server performs the same substitution through its
// `kb-launch-token-injector` plugin (`vite.config.ts`); this branch
// is only reachable for `npm run prod` / packaged distributions
// where Vite is not in the loop.
// Express 5 requires named wildcard parameters (path-to-regexp v8)
app.get('{*path}', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (distIndexCache !== null) {
    res.type('html').send(distIndexCache)
    return
  }
  res.sendFile(distIndexPath)
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

// Persist agent associations claimed eagerly via `originReservation` so
// they survive server restarts. Sessions created by `clearAndSendMessage`
// have no `agent-setting` event in their JSONL — without this record the
// mapping is reconstructed from `.kovitoboard/session-agents.jsonl` only,
// and an unrecorded post-/clear session shows up as the default agent
// after restart.
sessionManager.on('agent_claimed', (sessionId: string, agentId: string) => {
  try {
    appendSessionAgentRecord(fs, sessionId, agentId)
  } catch (err) {
    apiLogger.error(
      { err, sessionId, agentId },
      'Failed to persist eager-claim session-agent record',
    )
  }
})

claudeBridge.on('process_end', (processId: string, status: string, exitCode: number) => {
  broadcast('process_end', { processId, status, exitCode })
})

// --- Trust Prompt Detector startup ---
// Follows spec `docs/specs/trust-prompt-relay.md` v1.1.
// Detects trust prompts per tmux window and relays them to the UI via WebSocket.
// `trustPatternsConfig` was loaded earlier in the file so the version
// router (`/api/version`) could mount before the SPA fallback. The
// detector reuses the same instance.
const trustPromptDetector = new TrustPromptDetector(
  tmuxBridge,
  trustPatternsConfig.patterns,
  (event) => broadcast(event),
  fs,
)
trustPromptDetector.start()

// --- Agent Activity Monitor startup ---
// Samples each tmux pane once per second and broadcasts the most
// recent activity line so the renderer can show "what the agent is
// doing right now" next to its typing indicator. Coexists with the
// trust-prompt detector — the two share `tmux capture-pane` calls but
// run on independent intervals because their responsibilities differ.
//
// Window name maps 1:1 to agent id (see TmuxBridge.resolveWindowName);
// the latest session for that agent is the most recent entry in
// `sessionManager.getSessions()` (already sorted by lastEventAt desc)
// whose agent association matches.
const agentActivityMonitor = new AgentActivityMonitor(
  tmuxBridge,
  (event) => broadcast(event),
  (windowName) => {
    const agentMap = sessionManager.getSessionAgentMap()
    for (const session of sessionManager.getSessions()) {
      if (agentMap[session.id] === windowName) {
        return session.id
      }
    }
    return null
  },
)
agentActivityMonitor.start()

// --- app/menu.ts watcher ---
// Notifies the renderer whenever `app/menu.ts` is created, modified,
// or deleted so freshly-installed recipes appear in the navigation
// without requiring a page reload. chokidar tolerates a path that
// does not yet exist (a project may have no `app/` directory at all
// when KB first boots) and emits `add` once the file appears.
const menuWatcherLog = childLogger('app-menu-watcher')
const menuTsPath = getMenuTsPath(fs)
fs.watch(
  menuTsPath,
  (event) => {
    if (
      event.type === 'add' ||
      event.type === 'change' ||
      event.type === 'unlink'
    ) {
      menuWatcherLog.info({ event: event.type }, 'app/menu.ts changed; broadcasting')
      broadcast({
        type: 'app_menu_changed',
        payload: { event: event.type, ts: Date.now() },
      })
    } else if (event.type === 'error') {
      menuWatcherLog.warn({ err: event.error }, 'app/menu.ts watcher error')
    }
  },
  { ignoreInitial: true },
)

// --- Test-only endpoint: reset detector state (DEC-018 §3.1.4 / P1-4) ---
//
// Frees the per-window `DetectorState` entries inside the trust-prompt
// detector so back-to-back L1 tests cannot leak state through recycled
// tmux window names. The detector keeps running; only its in-memory
// state map is cleared.
//
// Gated behind KB_E2E_MODE so production builds cannot reach this path.
// playwright.config.l1.ts sets this env var when launching webServer.
if (process.env.KB_E2E_MODE === '1') {
  app.post('/api/admin/test-reset-state', (_req, res) => {
    trustPromptDetector.resetState()
    res.json({ ok: true })
  })
}

// --- Agent individual restart (A4-4 / A8) ---
app.post('/api/agents/:id/restart', async (req, res) => {
  const agentId = req.params.id

  // Validate agent exists in definitions
  const agents = loadAgentDefinitions(fs, config)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent) {
    res.status(404).json({ ok: false, error: 'agent not found' })
    return
  }

  try {
    // 1. Kill existing tmux window (idempotent — OK if already dead)
    tmuxBridge.killWindow(agentId)

    // 2. Clean up session-manager state
    sessionManager.deactivateAgentSessions(agentId)

    // 3. Re-spawn agent in a new tmux window
    const result = await tmuxBridge.startAgent(agentId)

    // 4. Broadcast restart event via WebSocket
    broadcast('agent_restarted', { agentId })

    res.json({ ok: true, result })
  } catch (err) {
    adminLogger.error({ err, agentId }, 'Agent restart failed')
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// Known client-to-server event types (whitelist)
const KNOWN_WS_EVENT_TYPES = new Set<string>([
  'trust_prompt_respond',
  'kb-call',
  'client_log',
])

// --- WebSocket: client -> server (trust prompt response handling) ---
wss.on('connection', (ws) => {
  // Replay pending trust-prompt events to the newly connected client.
  // The detector may have broadcast events before any UI client was connected,
  // causing them to be lost. This ensures late-connecting clients receive them.
  const pending = trustPromptDetector.getPendingPrompts()
  for (const event of pending) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event))
    }
  }

  ws.on('message', (data) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      wsLogger.warn('Received invalid JSON, ignoring')
      return
    }

    // Validate top-level structure: must have a string `type` field
    if (typeof parsed.type !== 'string') {
      wsLogger.warn('Message missing string "type" field, ignoring')
      return
    }

    // Ignore unknown event types
    if (!KNOWN_WS_EVENT_TYPES.has(parsed.type as ClientToServerEvent['type'])) {
      wsLogger.warn({ type: parsed.type }, 'Unknown event type, ignoring')
      return
    }

    if (parsed.type === 'trust_prompt_respond') {
      handleTrustPromptRespond(parsed.payload as TrustPromptRespondPayload)
    } else if (parsed.type === 'kb-call') {
      handleKbCall(ws, parsed as unknown as { type: 'kb-call' } & KbCallRequest)
    } else if (parsed.type === 'client_log') {
      handleClientLog(parsed.payload as ClientLogPayload)
    }
  })
})

function handleTrustPromptRespond(payload: TrustPromptRespondPayload): void {
  // Validate required fields and their types
  if (!payload || typeof payload !== 'object') {
    wsLogger.warn('trust_prompt_respond: payload must be an object')
    return
  }
  if (typeof payload.promptId !== 'string' || payload.promptId.length === 0) {
    wsLogger.warn('trust_prompt_respond: promptId must be a non-empty string')
    return
  }
  if (typeof payload.windowName !== 'string' || payload.windowName.length === 0) {
    wsLogger.warn('trust_prompt_respond: windowName must be a non-empty string')
    return
  }
  if (!payload.response || typeof payload.response !== 'object') {
    wsLogger.warn('trust_prompt_respond: response must be an object')
    return
  }

  const { promptId, windowName, response } = payload

  if (response.mode === 'choice') {
    // Validate choiceId is a non-empty string
    if (typeof response.choiceId !== 'string' || response.choiceId.length === 0) {
      wsLogger.warn('trust_prompt_respond: choiceId must be a non-empty string')
      return
    }
    // The UI sends only choiceId; the actual key sequence conversion is performed
    // by the detector using choices (state.lastChoices) from the most recent notification.
    // This design prevents the UI from injecting arbitrary keys.
    const ok = trustPromptDetector.respondChoice(windowName, promptId, response.choiceId)
    if (!ok) {
      wsLogger.warn({ windowName, promptId }, 'trust_prompt_respond (choice) failed')
    }
  } else if (response.mode === 'raw-keys') {
    // Validate rawKeys is a string within the allowed length range
    if (typeof response.rawKeys !== 'string' || response.rawKeys.length < 1 || response.rawKeys.length > 500) {
      wsLogger.warn('trust_prompt_respond: rawKeys must be a string (1-500 chars)')
      return
    }
    const ok = trustPromptDetector.respondRawKeys(windowName, promptId, response.rawKeys)
    if (!ok) {
      wsLogger.warn({ windowName, promptId }, 'trust_prompt_respond (raw-keys) failed')
    }
  } else {
    wsLogger.warn({ mode: (response as { mode: string }).mode }, 'trust_prompt_respond: unknown response mode')
  }
}

// --- WebSocket: client_log handler (DEC-017 v1.2 §10 / design §13.3) ---
// Renderer-emitted log records arrive here. We validate strictly,
// truncate oversize payloads, then re-emit through the server's pino
// logger tagged with `client.<component>` so renderer activity lands
// in the same JSON Lines log file as server activity.
const CLIENT_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const CLIENT_LOG_COMPONENT_MAX = 64
const CLIENT_LOG_MSG_MAX = 4096
const CLIENT_LOG_DATA_MAX_BYTES = 4096

function handleClientLog(payload: ClientLogPayload | undefined): void {
  // Top-level shape check
  if (!payload || typeof payload !== 'object') return

  const { level, component, msg } = payload
  let { data } = payload

  // Strict validation — drop silently to avoid log-spamming if the
  // renderer ever sends malformed records (a misbehaving client should
  // not pollute server logs with detector noise).
  if (typeof level !== 'string' || !CLIENT_LOG_LEVELS.has(level)) return
  if (
    typeof component !== 'string' ||
    component.length === 0 ||
    component.length > CLIENT_LOG_COMPONENT_MAX
  ) return
  if (typeof msg !== 'string' || msg.length > CLIENT_LOG_MSG_MAX) return

  // payload.data size guard (4 KB). On overflow, truncate to a JSON
  // string excerpt and emit a warning so we know it happened.
  if (data !== undefined && data !== null) {
    if (typeof data !== 'object') return
    try {
      const json = JSON.stringify(data)
      if (json.length > CLIENT_LOG_DATA_MAX_BYTES) {
        // Use `sourceComponent` rather than `component` to avoid
        // colliding with the child logger's own `component: 'ws'`
        // base field on the same record.
        wsLogger.warn(
          { sourceComponent: component, originalSize: json.length },
          'client_log payload truncated (>4KB)',
        )
        data = {
          _truncated: true,
          _original_size: json.length,
          _excerpt: json.slice(0, CLIENT_LOG_DATA_MAX_BYTES - 96) + '...[truncated]',
        }
      }
    } catch {
      // Non-serializable data; drop the structured field but keep msg.
      data = { _serializeFailed: true }
    }
  }

  const cl = childLogger(`client.${component}`)
  // Type-safe dispatch — `level` was just validated against the allowed set.
  ;(cl as unknown as Record<string, (obj: unknown, msg?: string) => void>)[level](
    data ?? {},
    msg,
  )
}

// --- WebSocket: kb-call handler (Recipe BE Phase J) ---
// @see recipe-backend-critical-reviews.md §3 (Q-J1: WebSocket adoption)
async function handleKbCall(
  ws: WebSocket,
  msg: { type: 'kb-call' } & KbCallRequest,
): Promise<void> {
  const { requestId, appId, callId, input } = msg

  if (typeof requestId !== 'string' || !requestId) {
    wsLogger.warn('kb-call: requestId is required')
    return
  }
  if (typeof appId !== 'string' || !appId) {
    sendKbCallResponse(ws, requestId, { ok: false, error: { code: 'InvalidArgs', message: 'appId is required' } })
    return
  }
  if (typeof callId !== 'string' || !callId) {
    sendKbCallResponse(ws, requestId, { ok: false, error: { code: 'InvalidArgs', message: 'callId is required' } })
    return
  }

  try {
    const result = await dispatchHandler(
      { appId, callId, input: (input && typeof input === 'object') ? input as Record<string, unknown> : {} },
      manifestStore,
      projectRoot,
    )
    sendKbCallResponse(ws, requestId, result as KbCallResponse['result'])
  } catch (err) {
    wsLogger.error({ err }, 'kb-call dispatch error')
    sendKbCallResponse(ws, requestId, {
      ok: false,
      error: { code: 'Internal', message: 'Dispatch failed' },
    })
  }
}

function sendKbCallResponse(
  ws: WebSocket,
  requestId: string,
  result: KbCallResponse['result'],
): void {
  const response: { type: 'kb-call-response' } & KbCallResponse = {
    type: 'kb-call-response',
    requestId,
    result,
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response))
  }
}

// --- Startup ---

// DEC-014 / DEC-016: Fail fast when production assets are missing.
// This check only fires for `npm run prod` (KOVITOBOARD_MODE=prod).
// `npm start` uses the supervisor (kb-start.mjs) in dev mode with Vite
// HMR, so dist/ is not required.
if (process.env.KOVITOBOARD_MODE === 'prod') {
  const distIndex = join(__dirname, '../../dist/index.html')
  if (!fs.existsSync(distIndex)) {
    serverLogger.fatal(
      "dist/ not found. Run 'npm run build' before 'npm start', or see CONTRIBUTING.md for development setup (npm run dev).",
    )
    flushAndExit(1)
  }
}

watcher.start()

// --- Claude Code version check (DEC-015 Soft policy) ---
// Warn at startup if the installed Claude Code version differs from the
// primary tested version declared in trust-patterns.json. Never blocks
// server startup — all code paths continue gracefully. The detection
// result is also cached in `version-info.ts` so /api/version can return
// it without re-running `claude --version` on every request.

detectClaudeCodeVersion(
  trustPatternsConfig.primaryTestedVersion,
  trustPatternsConfig.bestEffortVersions,
)

// --- Background GitHub Releases refresh (v0.1.0-version-display.md) ---
// Spec §2.3 / §3.2: at startup, populate the on-disk cache when stale,
// so the very first GET /api/version after a fresh install can answer
// "is KB up to date?" without waiting for a network round-trip in the
// HTTP path. fail-silent — never blocks startup.
;(async () => {
  if (resolveDisabledBy(fs) !== null) return
  try {
    const kbVersion = loadKbVersion(fs)
    await getLatestRelease(fs, { kbVersion })
  } catch (err) {
    serverLogger.warn({ err }, 'Background GitHub Releases refresh failed (non-fatal)')
  }
})()

// The supervisor (`tools/kb-start.mjs`) probes for an available port
// before launching us, so EADDRINUSE here is unexpected — typically
// either someone bypassed the supervisor (`tsx src/server/index.ts`
// directly) or another process raced into the port between probe and
// listen. Surface a friendly diagnostic and exit so the operator gets
// an actionable message instead of an unhandled error stack.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    serverLogger.error(
      { port: PORT },
      `Port ${PORT} is already in use. Stop the conflicting process or set ` +
        `PORT=<n> (or run via "npm start -- --port=<n>") and try again.`,
    )
    process.exit(1)
  }
  serverLogger.error({ err }, 'HTTP server failed to start')
  process.exit(1)
})

// Bind to the loopback interface only. KovitoBoard is a local-first
// tool with no authentication layer yet; serving the privileged HTTP
// API and WebSocket bridge to the wider LAN would expose stop/restart,
// recipe install, file read/write, and other admin operations to any
// host that can reach this machine on the chosen port. Pin to
// 127.0.0.1 explicitly so the bind does not depend on Node's
// `dns.lookup` order resolving "localhost" inconsistently across OSes.
server.listen(PORT, '127.0.0.1', () => {
  const { path: projectRoot, source: projectRootSource } = resolveProjectRootWithSource(fs)
  serverLogger.info({ url: `http://127.0.0.1:${PORT}` }, 'Server started')
  serverLogger.info({ url: `ws://127.0.0.1:${PORT}` }, 'WebSocket listening')
  serverLogger.info({ projectRoot, projectRootSource }, 'Project root resolved')
  serverLogger.info({ claudeDir: `${config.claudeDir}/projects/` }, 'Watching Claude Code session directory')
})
