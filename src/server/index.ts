import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, isAbsolute, resolve, normalize } from 'path'
import { randomUUID } from 'crypto'
import { DirectFsLayer } from './fs-layer'
import { loadConfig, resolveProjectRoot } from './config'
import { ensureKovitoboardDir, getUploadDir } from './paths'
import { SessionManager } from './session-manager'
import { Watcher } from './watcher'
import { loadAgentDefinitions, loadSessionAgentRecords, buildSessionAgentMap } from './agent-reader'
import { ClaudeBridge } from './claude-bridge'
import { TmuxBridge, isValidTmuxName } from './tmux-bridge'
import { DataFileWatcher } from './data-file-watcher'
import { readBasicSettings, readSkills, readAutomations, readIntegrations, readRules } from './settings-reader'
import { readArtifact } from './artifact-reader'
import { TrustPromptDetector, INITIAL_PATTERNS } from './trust-prompt-detector'
import type { SendMessageRequest, NewSessionRequest, TmuxSendRequest, TmuxStartAgentRequest } from './types'
import type {
  ServerToClientEvent,
  ClientToServerEvent,
  TrustPromptRespondPayload,
} from '../shared/ws-events'

const PORT = Number(process.env.PORT) || 3001

const app = express()
app.use(express.json())

// セキュリティヘッダー
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '0')  // 最新ブラウザでは無効化が推奨
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// --- ファイルアクセス抽象化レイヤ ---
// v0.1.0 では DirectFsLayer（Node.js fs / chokidar 直接呼び出し）のみ提供。
// Plugin 対応（v0.2.0 以降）で差し替え可能にするため、全モジュールに DI する。
const fs = new DirectFsLayer()

const config = loadConfig(fs)

// プロジェクトルート（.claude/agents や .kovitoboard/ 等のデータ参照基点）
// ClaudeBridge がデフォルト cwd として利用するため、先に解決する
const projectRoot = resolveProjectRoot(fs)

// `.kovitoboard/` ディレクトリを初回起動時に自動作成
ensureKovitoboardDir(fs)

const sessionManager = new SessionManager()
const watcher = new Watcher(config, sessionManager, fs)
const claudeBridge = new ClaudeBridge(projectRoot)
const tmuxBridge = new TmuxBridge(fs)

// データファイル監視: エージェントの直接編集を自動検知
// === 新しいデータ Manager を追加する場合 ===
// DataFileWatcher をコンストラクタに渡して register() を呼ぶこと。
// 詳細は data-file-watcher.ts のファイル冒頭コメントを参照。
// NOTE (v0.1.0): タスク管理機能は v0.1.0 スコープ外のため、現状 DataFileWatcher に
//                register() する Manager は存在しない。v0.1.1 以降で追加予定。
const _dataFileWatcher = new DataFileWatcher(fs, {
  usePolling: config.watcher.usePolling,
  pollInterval: config.watcher.pollInterval,
})
void _dataFileWatcher

/**
 * リクエストされたファイルパスを解決し、projectRoot 配下であることを検証する。
 * 安全な絶対パスを返す。不正なパスの場合は null を返す。
 */
function resolveAndValidatePath(requestedPath: string): string | null {
  const resolved = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : normalize(resolve(projectRoot, requestedPath))

  // projectRoot 配下であることを確認（projectRoot 自体も許可）
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

// エージェント一覧（定義 + セッション統計付き）
app.get('/api/agents', (_req, res) => {
  const agents = loadAgentDefinitions(fs, config)
  const records = loadSessionAgentRecords(fs, config)
  const sessionAgentMap = buildSessionAgentMap(records)

  // 各セッションのステータスを取得してエージェントごとに集計
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

  // エージェント情報にセッション統計を反映
  for (const agent of agents) {
    const counts = agentSessionCounts.get(agent.id) || { active: 0, total: 0 }
    agent.activeSessionCount = counts.active
    agent.totalSessionCount = counts.total
  }

  res.json(agents)
})

// セッション-エージェント紐づけマッピング
app.get('/api/session-agent-map', (_req, res) => {
  res.json(sessionManager.getSessionAgentMap())
})

// セッションに agentId を手動設定
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

// エージェントのアクティブセッションをすべて idle に変更
app.post('/api/agents/:agentId/deactivate-sessions', (req, res) => {
  const { agentId } = req.params
  const deactivated = sessionManager.deactivateAgentSessions(agentId)
  res.json({ success: true, deactivated })
})

// --- Claude CLI 連携 API ---

// 既存セッションにメッセージを送信
app.post('/api/sessions/:id/send', (req, res) => {
  const sessionId = req.params.id
  const { message } = req.body as SendMessageRequest

  if (!message || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const sessionCwd = session.events.find(e => e.metadata.cwd)?.metadata.cwd

  try {
    const processId = claudeBridge.sendToSession(sessionId, message.trim(), sessionCwd)
    res.json({ success: true, processId })
  } catch (err) {
    console.error('[API] セッション送信エラー:', err)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// 新規セッションを開始
app.post('/api/sessions/new', (req, res) => {
  const { agentId, message, cwd } = req.body as NewSessionRequest

  if (!message || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  try {
    const processId = claudeBridge.startNewSession(message.trim(), agentId, cwd)
    res.json({ success: true, processId })
  } catch (err) {
    console.error('[API] 新規セッション開始エラー:', err)
    res.status(500).json({ error: 'Failed to start new session' })
  }
})

// プロセス状態取得
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

// --- tmux 連携 API ---

app.get('/api/tmux/status', (_req, res) => {
  const hasSession = tmuxBridge.hasSession()
  const windows = hasSession ? tmuxBridge.listWindows() : []
  const agentWindowMap = hasSession ? tmuxBridge.getAgentWindowMap() : {}
  res.json({ hasSession, sessionName: tmuxBridge.sessionName, windows, agentWindowMap })
})

app.post('/api/tmux/send', (req, res) => {
  const { windowName, message } = req.body as TmuxSendRequest

  if (!windowName || !message?.trim()) {
    res.status(400).json({ error: 'windowName and message are required' })
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

  if (!windowName || !message?.trim()) {
    res.status(400).json({ error: 'windowName and message are required' })
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

  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' })
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

// --- 設定 API ---

app.get('/api/settings/basic', (_req, res) => {
  try {
    const settings = readBasicSettings(fs, projectRoot)
    res.json(settings)
  } catch (err) {
    console.error('[API] 基本設定読み取りエラー:', err)
    res.status(500).json({ error: 'Failed to read basic settings' })
  }
})

app.get('/api/settings/skills', (_req, res) => {
  try {
    const skills = readSkills(fs, projectRoot)
    res.json({ skills })
  } catch (err) {
    console.error('[API] スキル読み取りエラー:', err)
    res.status(500).json({ error: 'Failed to read skills' })
  }
})

app.get('/api/settings/automations', (_req, res) => {
  try {
    const automations = readAutomations(fs, projectRoot)
    res.json(automations)
  } catch (err) {
    console.error('[API] 自動処理読み取りエラー:', err)
    res.status(500).json({ error: 'Failed to read automations' })
  }
})

app.get('/api/settings/integrations', (_req, res) => {
  try {
    const integrations = readIntegrations(fs, projectRoot)
    res.json({ integrations })
  } catch (err) {
    console.error('[API] 外部連携読み取りエラー:', err)
    res.status(500).json({ error: 'Failed to read integrations' })
  }
})

app.get('/api/settings/rules', (_req, res) => {
  try {
    const rules = readRules(fs, projectRoot)
    res.json({ rules })
  } catch (err) {
    console.error('[API] ルール読み取りエラー:', err)
    res.status(500).json({ error: 'Failed to read rules' })
  }
})

// --- ファイルアップロード API ---

const UPLOAD_DIR = getUploadDir()
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000 // 24時間

// アップロードディレクトリの初期化
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// 古いアップロードファイルを定期的に削除
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
  } catch { /* クリーンアップ失敗は無視 */ }
}
cleanupUploads()
setInterval(cleanupUploads, 60 * 60 * 1000) // 1時間ごと

function getExtFromContentType(contentType: string, originalName?: string): string {
  // オリジナルファイル名から拡張子を取得
  if (originalName) {
    const dotIdx = originalName.lastIndexOf('.')
    if (dotIdx > 0) return originalName.slice(dotIdx)
  }
  // Content-Type から推定
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
    console.error('[API] アップロードエラー:', err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// --- ファイルプレビュー API ---

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

// 本番時: ビルド済みの静的ファイルを配信
app.use(express.static(join(__dirname, '../../dist')))

// --- WebSocket: リアルタイムイベント配信 ---
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

// --- Trust Prompt Detector 起動 ---
// 仕様書 `docs/specs/trust-prompt-relay.md` v1.1 準拠。
// tmux ウィンドウ単位で信頼プロンプトを検知し、WebSocket で UI に中継する。
const trustPromptDetector = new TrustPromptDetector(
  tmuxBridge,
  INITIAL_PATTERNS,
  (event) => broadcast(event),
)
trustPromptDetector.start()

// --- WebSocket: クライアント → サーバー（trust prompt 応答受信） ---
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let parsed: ClientToServerEvent
    try {
      parsed = JSON.parse(data.toString()) as ClientToServerEvent
    } catch {
      console.warn('[WS] 不正な JSON を受信')
      return
    }

    if (parsed.type === 'trust_prompt_respond') {
      handleTrustPromptRespond(parsed.payload)
    }
  })
})

function handleTrustPromptRespond(payload: TrustPromptRespondPayload): void {
  const { promptId, windowName, response } = payload

  if (response.mode === 'choice') {
    // UI は choiceId のみを送り、実際のキー列への変換は detector が
    // 直近通知時の choices（state.lastChoices）から行う。
    // これにより UI 側から任意のキーを送り込めない設計とする。
    const ok = trustPromptDetector.respondChoice(windowName, promptId, response.choiceId)
    if (!ok) {
      console.warn(
        `[WS] trust_prompt_respond (choice) 失敗: ${windowName} ${promptId}`,
      )
    }
  } else if (response.mode === 'raw-keys') {
    const ok = trustPromptDetector.respondRawKeys(windowName, promptId, response.rawKeys)
    if (!ok) {
      console.warn(
        `[WS] trust_prompt_respond (raw-keys) 失敗: ${windowName} ${promptId}`,
      )
    }
  }
}

// --- 起動 ---
watcher.start()

server.listen(PORT, () => {
  console.log(`[kovitoboard] サーバー起動: http://localhost:${PORT}`)
  console.log(`[kovitoboard] WebSocket: ws://localhost:${PORT}`)
  console.log(`[kovitoboard] 監視対象: ${config.claudeDir}/projects/`)
})
