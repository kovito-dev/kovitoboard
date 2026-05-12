/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { randomUUID } from 'crypto'
import { DirectFsLayer } from './fs-layer'
import { loadConfig, resolveProjectRoot, resolveProjectRootWithSource } from './config'
import { ensureKovitoboardDir, ensureLogsDir, getUploadDir } from './paths'
import { initLogger, serverLogger, childLogger, flushAndExit, setupKbContext } from './logger'
import { enforcePreflight, runPreflightChecks } from './preflight'
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
import { createCaptureRouter } from './routes/capture-routes'
import { getMenuTsPath } from './services/menu-extractor'
import { scanSampleRecipes, getSampleRecipes, refreshInstallStatus } from './services/recipe-scanner'
import { parseRecipe, RecipeParseError } from './recipe-parser'
import { inspectRecipe } from './recipe-inspector'
import {
  validateProposedAppId,
  findAvailableAppId,
} from './services/app-id-collision'
import { readAppManifest } from './services/app-manifest'
import { buildAppRemovalPrompt } from '../shared/app-removal-prompt'
import { readRecipeHistory, appendRecipeHistory, generateHistoryId } from './recipe-history'
import {
  issueInstallSession,
  consumeInstallSession,
  approvedScopesMatch,
  approvedCapturesMatch,
  apiSectionMatches,
} from './recipe-install-sessions'
import {
  scanAppDirectory,
  exportAsMarkdown,
  validateAppId,
  AppIdBoundaryError,
} from './recipe-exporter'
import type { RecipeParseRequest, RecipeExportRequest } from '../shared/recipe-types'
import type {
  ServerToClientEvent,
  ClientToServerEvent,
  TrustPromptRespondPayload,
  ClientLogPayload,
} from '../shared/ws-events'
import { RecipeManifestStore } from './recipeManifestStore'
import { dispatch as dispatchHandler } from './handlerDispatcher'
import type {
  KbCallRequest,
  KbCallResponse,
  RecipeManifest,
  CaptureKind,
} from './recipe/apiTypes'
import { isValidCaptureKind } from './recipe/apiTypes'
import { validateMarkInstalledRequest } from './recipe/markInstalledValidator'
import { registerHandler } from './handlers/registry'
import type { Scope } from './handlers/types'
import { HANDLER_LIMITS } from './handlers/types'
import {
  validatePathForArtifactRead,
  prepareArtifactPathContext,
} from './artifact-path-validator'
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
//
// The auth guard is mounted BEFORE `express.json()` so an unauthorized
// request short-circuits with 401 / 403 before we spend cycles on
// JSON body parsing. Without this ordering an attacker could keep the
// server busy parsing megabyte-sized JSON bodies even though the
// request would ultimately be rejected.
app.use('/api', verifyTokenAndOrigin)
app.use(express.json())

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/api/ws', verifyClient: verifyWsClient })

// --- File access abstraction layer ---
// v0.1.0 only provides DirectFsLayer (direct Node.js fs / chokidar calls).
// All modules receive it via DI so it can be swapped for Plugin support (v0.2.0+).
const fs = new DirectFsLayer()

const config = loadConfig(fs)

// Project root (base path for .claude/agents, .kovitoboard/, etc.)
// Resolved first because ClaudeBridge uses it as its default cwd.
// We grab the source too so the config router can echo it back to
// the renderer (ProjectRootBanner needs it to flag a cwd-fallback as
// a warning state).
const { path: projectRoot, source: projectRootSource } =
  resolveProjectRootWithSource(fs)

// Auto-create `.kovitoboard/` directory on first launch
ensureKovitoboardDir(fs)

// DEC-017: Initialize the structured logger before anything else that
// might want to log. The logs directory must exist before pino-roll
// opens its rotating stream. The setting is read here (synchronous)
// so the logger can pick up `logging.retentionDays` if configured.
ensureLogsDir(fs)

// supervisor-startup.md v1.2 §5.3 step 7 / §6.9: validate runtime
// prerequisites (PF-1 tmux 3.4+, PF-2 Node 20+, PF-3 claude CLI on
// PATH) before the heavy initialisation work below. Failures bypass
// the pino pipeline (which is built two lines down) and surface
// through bootstrap console output, mirroring log-config.ts. The
// `KOVITOBOARD_SKIP_PREFLIGHT=1` escape hatch is documented for
// CI / E2E only.
enforcePreflight(runPreflightChecks())

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

// Cached context for `validatePathForArtifactRead`. Built via
// `prepareArtifactPathContext` so `projectRoot` and `uploadDir`
// are canonicalized exactly once at server startup — the validator
// itself only canonicalizes the per-request `requestedPath`. The
// preview pane can poll `/api/artifact{,/raw}` repeatedly, so
// avoiding redundant `realpath` syscalls on every hit is worth
// the one-time setup cost. See `prepareArtifactPathContext` for
// the canonical-context invariant.
const artifactPathCtx = prepareArtifactPathContext({
  projectRoot,
  uploadDir: getUploadDir(),
  fs,
})

// --- Route modules ---
// Routers handle sub-paths like /api/config/setting, so mount them
// before the existing app.get('/api/config') to give them priority
app.use('/api/config', createConfigRouter(fs, projectRoot, projectRootSource))
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
// Capture endpoints (v0.2.0 Phase 1 prompt-injection ①, opt-in
// mechanism). Mounted on top of /api/app so a recipe-app caller
// invokes it via `window.kb.capture.<kind>` while the surrounding
// kb-bridge already routes through the same namespace. See
// `docs/specs/http-api-contract.md` v1.3 §10.6 and
// `docs/specs/app-directory-extension.md` v1.2 §10.5.2.
app.use(
  '/api/app/capture',
  createCaptureRouter({
    manifestStore,
    projectRoot,
    logger: apiLogger,
  }),
)

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
    // Security-limits breaches return a generic envelope without
    // leaking path / size details to the caller (spec §6.2). The
    // structured warn log was already emitted by `checkParserLimit`
    // at the parser boundary with the forensic fields operators
    // need; emitting a second warn here would double the log
    // volume on the very path attackers can flood, so the route
    // layer only translates the exception into the HTTP envelope.
    if (err instanceof RecipeParseError) {
      res.status(err.context.httpStatus).json({
        error:
          err.context.httpStatus === 413
            ? 'Recipe exceeds the maximum allowed size'
            : 'Recipe exceeds an allowed limit',
      })
      return
    }
    const message = err instanceof Error ? err.message : 'Failed to parse recipe'
    apiLogger.error({ err }, 'Recipe parse error')
    res.status(400).json({ error: message })
  }
})

// `POST /api/recipes/apply` — removed in v0.2.x.
//
// The deprecated apply flow was withdrawn alongside the temporary
// disable of `/api/recipes/install` (recipe-system.md §10.6 /
// http-api-contract.md §4.3.8.A / §10.1.1). Removing the route's
// internals — agent resolution, applyRecipe transform, tmux send —
// physically eliminates the attack surface that depended on the
// client-supplied inspection verdict. There is no re-enable plan;
// callers should migrate to `/api/recipes/install` once it ships
// again in v0.3.0 alongside the KovitoHub signed publisher model.
app.post('/api/recipes/apply', (_req, res) => {
  // Log at info — every retry from a stale v0.1.x client lands here
  // during the rollout window, and warn-level emissions would let any
  // automated probe inflate the log volume cheaply. The audit trail
  // is still produced (see http-api-contract.md §4.3.8.A) so
  // attempts remain visible.
  apiLogger.info(
    { route: '/api/recipes/apply' },
    'POST /api/recipes/apply was removed in v0.2.x. ' +
    'The deprecated apply flow was withdrawn along with recipe install temporary disable.',
  )
  res.status(410).json({
    error: 'RecipeApplyRemoved',
    message:
      'POST /api/recipes/apply has been removed in v0.2.x. The deprecated apply flow ' +
      'was withdrawn along with recipe install temporary disable.',
    details: {
      endpoint: '/api/recipes/apply',
      kbVersion: '0.2.x',
      plannedReenable: 'not planned (use /api/recipes/install in v0.3.0)',
      grandfatherDocs: 'docs/specs/recipe-system.md §10.6',
    },
  })
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

    // `validateAppId` enforces the `app-name` regex from
    // `app-directory-extension.md` and rejects RESERVED_DIRS. Any
    // failure throws `AppIdBoundaryError`, which we map to a 400
    // `InvalidAppId` in the catch block below alongside the same
    // class thrown from `scanAppDirectory`'s realpath escape check.
    const validatedAppId = validateAppId(appId)

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

    const scan = scanAppDirectory(fs, validatedAppId)

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
      res.status(400).json({ error: `No artifacts found under app/${validatedAppId}/` })
      return
    }

    // Recipe-installed apps carry their `api:` declarations in the
    // manifest; user-authored apps do not. Pass `null` in the latter
    // case so the writer omits the `api:` section, leaving the
    // receiving install flow to surface the missing-handler warning.
    const manifest = manifestStore.get(validatedAppId)
    const api = manifest ? manifest.api : null

    // Build the recipe document in memory and stream it as a download.
    // Nothing is written to disk on the server side — the browser is
    // responsible for saving the file (see DEC-024 #5 follow-up,
    // 2026-05-04: directory format and explicit outputPath dropped).
    const markdown = exportAsMarkdown(fs, validatedAppId, scan, metadata, api)
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
    if (err instanceof AppIdBoundaryError) {
      // Both the route-layer `validateAppId` call and the symlink
      // escape check inside `scanAppDirectory` raise this. Mapping
      // them to the same 400 keeps the boundary policy uniform: the
      // client gets `InvalidAppId` whether the input was malformed
      // or the resolved path tried to leave `app/`.
      apiLogger.warn(
        { route: '/api/recipes/export', err: { name: err.name, message: err.message } },
        'invalid appId',
      )
      // Reply with the curated client-safe message (`err.clientMessage`)
      // — never `err.message`. The latter intentionally carries the
      // offending `appId`, the regex literal, or the canonical realpath
      // strings that the symlink escape branch builds, all of which we
      // keep server-side only (the warn log above retains them for
      // operator diagnostics).
      res.status(400).json({ error: 'InvalidAppId', message: err.clientMessage })
      return
    }
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
    // `validateAppId` rejects non-string inputs as well, so we feed the
    // raw query value in directly; the response is a uniform 400
    // `InvalidAppId` for any malformed query, which keeps the policy
    // aligned with `/api/recipes/export`.
    const validatedAppId = validateAppId(req.query?.appId)
    const result = scanAppDirectory(fs, validatedAppId)
    res.json(result)
  } catch (err) {
    if (err instanceof AppIdBoundaryError) {
      apiLogger.warn(
        { route: '/api/recipes/app-scan', err: { name: err.name, message: err.message } },
        'invalid appId',
      )
      // Reply with the curated client-safe message (`err.clientMessage`)
      // — never `err.message`. The latter intentionally carries the
      // offending `appId`, the regex literal, or the canonical realpath
      // strings that the symlink escape branch builds, all of which we
      // keep server-side only (the warn log above retains them for
      // operator diagnostics).
      res.status(400).json({ error: 'InvalidAppId', message: err.clientMessage })
      return
    }
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

// `POST /api/recipes/install` — temporarily disabled in v0.2.x.
//
// Recipe install is blocked during the prompt-injection defence
// design freeze and the KovitoHub central-distribution preparation
// (recipe-system.md §10.6 / http-api-contract.md §4.3.8.A /
// §10.1.1). Returning 410 Gone here keeps the install handover
// prompt builder, install-session store, and tmux delivery path
// intact for v0.3.0 re-enable under the signed publisher model,
// while making sure no caller can mint a fresh install handover
// while v0.2.x is in the field. Existing install-grandfather
// surfaces (manifest read, uninstall, export, dispatcher) stay
// operational — see recipe-system.md §10.6.3.
app.post('/api/recipes/install', (_req, res) => {
  // Log at info — every retry from a stale v0.1.x client lands here
  // during the rollout window, and warn-level emissions would let any
  // automated probe inflate the log volume cheaply. The audit trail
  // is still produced (see http-api-contract.md §4.3.8.A) so
  // attempts remain visible.
  apiLogger.info(
    { route: '/api/recipes/install' },
    'POST /api/recipes/install is temporarily disabled in v0.2.x. ' +
    'Re-enable is planned for v0.3.0 with the KovitoHub signed publisher model.',
  )
  res.status(410).json({
    error: 'RecipeInstallDisabled',
    message:
      'Recipe install is disabled in v0.2.x. KovitoHub sync release is planned for v0.3.0.',
    details: {
      endpoint: '/api/recipes/install',
      kbVersion: '0.2.x',
      plannedReenable: 'v0.3.0 (KovitoHub signed publisher model + developer sideload mode)',
      grandfatherDocs: 'docs/specs/recipe-system.md §10.6',
    },
  })
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
    const {
      appId,
      approvedScopes,
      approvedCaptures,
      recipeVersion,
      recipeSource,
      recipeHash,
      installNonce,
      api,
    } = validation.value

    // Idempotency first: if a history record with the same (recipeId,
    // appId, hash, action='install') already exists AND the current
    // manifest at that `appId` still describes the same install,
    // return ok without consuming the nonce or rewriting state. The
    // agent retried `mark-installed` — a perfectly normal recovery
    // path. Doing the history check before nonce consumption is
    // critical because the nonce is one-shot; the legitimate retry
    // would otherwise hit `consumeInstallSession()` and get back
    // null on the second call, and the handler would 403 a
    // successful install that just happened to be acknowledged
    // twice.
    //
    // Crucially we cross-check the manifest store: a stale history
    // entry left over from a previous install (uninstalled, or
    // re-installed with a different hash) must NOT short-circuit
    // here. Without that guard a forged or replayed mark-installed
    // call could be acknowledged as success even though no manifest
    // was actually written for the current install — see
    // codex-review attempt-5 finding #1.
    const existingHistory = readRecipeHistory(fs)
    const existingManifestForRetry = manifestStore.get(appId)
    const stateConsistentWithHistory =
      existingManifestForRetry !== null &&
      existingManifestForRetry.recipeId === recipeIdParam &&
      existingManifestForRetry.hash === recipeHash
    const alreadyRecorded =
      stateConsistentWithHistory &&
      existingHistory.some(
        (h) =>
          h.action !== 'uninstall' &&
          h.recipeId === recipeIdParam &&
          h.hash === recipeHash &&
          // `appId` is now a first-class field on RecipeHistoryEntry.
          // Legacy entries without it cannot satisfy a strict
          // (recipeId, appId, hash) idempotency match anyway, so the
          // strict comparison preserves the prior behaviour for
          // pre-v0.2.0 install rows.
          h.appId === appId,
      )
    if (alreadyRecorded) {
      res.json({ ok: true })
      return
    }

    // Partial-success recovery: the manifest at `appId` already
    // describes this exact install (same recipeId + hash) but no
    // history row was written. That can happen when a previous
    // attempt persisted the manifest, then crashed before
    // `appendRecipeHistory` had a chance to run — the nonce was
    // already consumed, so a naive retry would 403 a half-finished
    // install with no obvious recovery.
    //
    // We acknowledge the call so the agent can move on, but we
    // deliberately do NOT replay the body into the audit history.
    // The body is unauthenticated on this branch (the nonce is
    // already gone, and the manifest existence — which is
    // server-owned trusted state — is what authorises the success
    // response). Letting the body's `recipeVersion` / `recipeSource`
    // ride into recipe-history.jsonl on the strength of "the
    // manifest happens to match" would let any caller who knows
    // `(recipeId, appId, recipeHash)` rewrite the install audit
    // line for that app, which is itself a tampering vector. The
    // resulting audit gap is rare (it only manifests when the
    // original install crashed mid-write) and operators can
    // diagnose it through the warn log emitted here.
    if (stateConsistentWithHistory) {
      apiLogger.warn(
        { recipeId: recipeIdParam, appId },
        'mark-installed: partial-success recovery — manifest already persisted from a prior attempt without a history entry. Acknowledging without rewriting history; an operator can fill the audit gap manually if needed.',
      )
      res.json({ ok: true })
      return
    }

    // -- Cross-app overwrite check --
    //
    // The install nonce binds recipeId / recipeHash / approvedScopes /
    // api but the agent picks `appId` only after the install handover
    // has run (Step 2 of the playbook resolves collisions through
    // /api/apps/check-id-availability). A stolen nonce reused with a
    // different `appId` would otherwise let the caller plant the
    // session's manifest into an unrelated app namespace. Refuse the
    // call when an existing manifest at this `appId` does not already
    // belong to the same recipe install — the legitimate retry path
    // is covered by the history-record dedup above, which would have
    // already short-circuited if this `appId` was the original
    // destination.
    //
    // Reuse the manifest read above so the path stays a single store
    // hit per request.
    const existingManifest = existingManifestForRetry
    if (
      existingManifest &&
      (existingManifest.recipeId !== recipeIdParam ||
        existingManifest.hash !== recipeHash)
    ) {
      apiLogger.warn(
        {
          recipeId: recipeIdParam,
          appId,
          existingRecipeId: existingManifest.recipeId,
          existingHash: existingManifest.hash,
        },
        'mark-installed rejected: appId already bound to a different recipe install',
      )
      res.status(403).json({
        error:
          `App "${appId}" is already bound to a different recipe install. ` +
          'Pick a different appId or uninstall the existing app via ' +
          '/api/apps/:appId/request-removal before retrying.',
      })
      return
    }

    // -- Install-session check --
    //
    // The nonce is one-shot: lookup deletes the entry whether or not
    // it is still valid, so a repeated call cannot replay the
    // install. The history-record dedup above already short-circuits
    // legitimate retries before this point.
    //
    // We deliberately do not differentiate between "no such nonce",
    // "expired nonce", and "approvedScopes / recipeHash / api
    // mismatch" in the response message: the handler answers 403 in
    // every case, and revealing which dimension failed would leak
    // shape information about the nonce store.
    const session = consumeInstallSession(installNonce)
    if (
      session === null ||
      session.recipeId !== recipeIdParam ||
      session.recipeHash !== recipeHash ||
      session.recipeVersion !== recipeVersion ||
      session.recipeSource !== recipeSource ||
      !approvedScopesMatch(session.approvedScopes, approvedScopes) ||
      !approvedCapturesMatch(session.approvedCaptures, approvedCaptures) ||
      !apiSectionMatches(session.apiCanonical, api)
    ) {
      apiLogger.warn(
        { recipeId: recipeIdParam, appId, hasSession: session !== null },
        'mark-installed rejected: install-session mismatch',
      )
      res.status(403).json({
        error:
          'Install session check failed. The nonce is unknown, expired, ' +
          'or the body does not match what KB inspected at install time. ' +
          'Restart the install via /api/recipes/install to obtain a fresh nonce.',
      })
      return
    }

    // Persist the recipe-side manifest. The dispatcher's
    // `manifestStore.refresh()` (or `loadAll()`) re-reads this file
    // when it needs to resolve handler calls.
    //
    // `trustLevel` is hard-coded to `'unknown'` in v0.2.x: the
    // KovitoHub signed-publisher path that distinguishes
    // `'code-trusted'` vs `'code-trusted (sideloaded)'` ships in
    // v0.3.0 alongside the recipe-install re-enable, so today every
    // newly-minted manifest matches a grandfather-migrated one. The
    // trust-marker handoff (`v02x-phase1-trust-marker-preamble-
    // warning-request.md`) takes ownership of populating richer
    // values when the install path comes back. See recipe-system.md
    // v1.4 §6.10.3〜§6.10.4.
    const manifest: RecipeManifest = {
      appId,
      recipeId: recipeIdParam,
      recipeVersion,
      hash: recipeHash,
      installedAt: new Date().toISOString(),
      approvedScopes,
      approvedCaptures,
      trustLevel: 'unknown',
      api: api ?? { scopes: [], calls: [] },
    }
    manifestStore.save(manifest)

    // Append the install record to recipe-history.jsonl. The
    // recipeId field stores the recipe author's id (per DEC-024
    // D-8); the appId is captured as a first-class field on the
    // entry so callers can attribute history rows to a specific
    // app instance even when the same recipe was installed under
    // multiple appIds. Older entries in the same file may still
    // omit `appId` and hold the install's KB-local identifier in
    // `menu[0]`; `findHistoryMatch` and `entryMatchesRecipeId`
    // already cope with that fallback.
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
      appId,
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

// --- Recipe Uninstall API (deprecated) ---
//
// This endpoint used to perform an end-to-end recipe uninstall —
// remove artifacts, strip menu entries, delete the manifest, and
// append an `action: 'uninstall'` history row — but the UI uninstall
// button it served was retired in DEC-024 D-6. App removal now goes
// through `POST /api/apps/:appId/request-removal`, which hands an
// agent the deletion playbook (`buildAppRemovalPrompt`); the agent
// performs the actual filesystem mutation directly. No surveyed
// caller (UI, tests, agent templates, agent-ref) reaches this route
// anymore.
//
// Returning 410 makes any remaining caller fail loudly — a silent
// success here would let an obsolete client believe it had cleaned
// up state when nothing happened, which is harder to diagnose than
// a clear "endpoint gone, use the replacement" message. The body
// names the replacement so an operator who hits this in a log can
// migrate without spelunking.
//
// The uninstall-only helpers (`findLatestInstallEntry`, and the
// `removeMenuEntry` import that fed this handler) are dropped at
// the same time so they cannot quietly accumulate callers. Removing
// the route entirely is deferred to a follow-up cleanup PR.

app.post('/api/recipes/uninstall', (req, res) => {
  const requestedRecipeId =
    typeof (req.body as { recipeId?: unknown } | undefined)?.recipeId === 'string'
      ? (req.body as { recipeId: string }).recipeId
      : null
  apiLogger.warn(
    { recipeId: requestedRecipeId },
    'Deprecated /api/recipes/uninstall called; use POST /api/apps/:appId/request-removal instead',
  )
  res.status(410).json({
    error:
      'POST /api/recipes/uninstall is deprecated. Use POST /api/apps/:appId/request-removal ' +
      'to remove an installed app via the agent-driven removal flow.',
    deprecatedSince: 'v0.2.0',
    replacement: 'POST /api/apps/:appId/request-removal',
  })
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
  const validation = validatePathForArtifactRead(filePath, artifactPathCtx)
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error })
    return
  }
  const result = readArtifact(fs, validation.resolved)
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
  // Pass the size cap so a single oversized file cannot stream
  // unbounded bytes through `res.sendFile`. The cap matches the
  // `read-file` handler so callers see a consistent limit whether
  // they reach the file via the dispatcher or this preview route.
  const validation = validatePathForArtifactRead(filePath, artifactPathCtx, {
    maxSize: HANDLER_LIMITS.READ_FILE_MAX_SIZE,
  })
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error })
    return
  }
  res.sendFile(validation.resolved)
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

  // L1 fake-claude harness cannot execute the install handover prompt
  // (the fake agent does not parse markdown), so the helper that
  // exercises the dispatcher cannot wait for the agent to call
  // mark-installed and never sees the install nonce. This shortcut
  // hands the harness a freshly-issued nonce bound to the same
  // recipeId / hash / scopes the real install endpoint would have
  // saved, so subsequent calls to `mark-installed` succeed under the
  // production code path. The endpoint is unreachable in any build
  // that does not export `KB_E2E_MODE=1`, so the attack surface is
  // confined to test runs.
  app.post('/api/recipes/_test/issue-nonce', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { recipeId, recipeHash, recipeVersion, recipeSource } = body
    const approvedScopes = body.approvedScopes
    const approvedCaptures = body.approvedCaptures
    const apiSection = body.api
    if (typeof recipeId !== 'string' || recipeId.length === 0) {
      res.status(400).json({ error: 'recipeId must be a non-empty string' })
      return
    }
    if (typeof recipeHash !== 'string' || recipeHash.length === 0) {
      res.status(400).json({ error: 'recipeHash must be a non-empty string' })
      return
    }
    if (!Array.isArray(approvedScopes) || !approvedScopes.every((s) => typeof s === 'string')) {
      res
        .status(400)
        .json({ error: 'approvedScopes must be an array of strings' })
      return
    }
    // approvedCaptures is optional on this test harness for backward
    // compatibility — existing L1 specs that did not declare any
    // capture continue to pass an empty installNonce binding. New
    // tests that exercise the opt-in surface send the array
    // explicitly so the mark-installed validator can compare against
    // the stored session.
    let approvedCapturesList: CaptureKind[] = []
    if (approvedCaptures !== undefined) {
      if (!Array.isArray(approvedCaptures) || !approvedCaptures.every(isValidCaptureKind)) {
        res
          .status(400)
          .json({ error: 'approvedCaptures must be an array of valid capture kinds' })
        return
      }
      approvedCapturesList = approvedCaptures as CaptureKind[]
    }
    const issueResult = issueInstallSession({
      recipeId,
      recipeHash,
      recipeVersion: typeof recipeVersion === 'string' ? recipeVersion : '',
      recipeSource: typeof recipeSource === 'string' ? recipeSource : '',
      approvedScopes: approvedScopes as Scope[],
      approvedCaptures: approvedCapturesList,
      api: apiSection ?? null,
    })
    if (!issueResult.ok) {
      if (issueResult.reason === 'invalid_api') {
        res.status(400).json({ error: 'api section too deep or cyclic' })
        return
      }
      res.status(503).json({ error: 'Install-session store at capacity' })
      return
    }
    res.json({ ok: true, installNonce: issueResult.nonce })
  })

  // Companion to `_test/issue-nonce`: lets the L1 helper drop a
  // pre-existing manifest for a given `appId` before issuing a new
  // install nonce. Without this, the cross-app overwrite check on
  // mark-installed (which legitimately rejects the second install
  // of a different recipe into the same `appId`) would block the
  // suite's repeated installs of TEST_RECIPE_ID across tests.
  app.post('/api/recipes/_test/clear-manifest', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { appId } = body
    // Reuse the same `appId` validator the production mark-installed
    // path uses. Without this guard a literal `../something` could
    // escape the manifest namespace under `manifestStore.delete()`,
    // which derives a filesystem path from `appId`.
    const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
    if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
      res
        .status(400)
        .json({ error: 'appId must match /^[a-z][a-z0-9-]{0,63}$/' })
      return
    }
    manifestStore.delete(appId)
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
