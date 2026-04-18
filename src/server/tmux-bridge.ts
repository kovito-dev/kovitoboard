import { execFileSync } from 'child_process'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer } from './fs-layer'

/**
 * Validate a string as a tmux window name / agent ID.
 * Allowed: alphanumeric, hyphens, underscores (1-64 chars)
 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidTmuxName(name: string): boolean {
  return VALID_NAME_PATTERN.test(name)
}

/**
 * Derive tmux session name from the project name.
 * Example: projects/my-team -> "kovitoboard-my-team"
 * Characters not allowed in tmux session names (dots, colons) are replaced with hyphens.
 */
function resolveTmuxSessionName(fs: FileAccessLayer): string {
  const projectDir = basename(resolveProjectRoot(fs))
  const sanitized = projectDir.replace(/[.:]/g, '-')
  return `kovitoboard-${sanitized}`
}

export interface TmuxWindow {
  /** Window index */
  index: number
  /** Window name (= agent ID) */
  name: string
  /** Whether the window is active */
  active: boolean
}

export interface TmuxSendResult {
  success: boolean
  error?: string
}

/**
 * Send messages to Claude CLI agents via tmux
 *
 * Prerequisites:
 * - tmux session "kovitoboard-{project}" exists
 * - Each window has an agent running (window name = agent ID)
 *
 * Send methods:
 * - Short messages: sent directly via tmux send-keys
 * - Long/special characters: safely sent via tmp file -> load-buffer -> paste-buffer
 */
export class TmuxBridge {
  private fs: FileAccessLayer
  private _sessionName: string | null = null

  constructor(fs: FileAccessLayer) {
    this.fs = fs
  }

  /**
   * tmux session name (project-name-based, lazily evaluated)
   *
   * Derived from resolveProjectRoot(fs) on first access.
   * Not evaluated at module load time to avoid fs dependency ordering issues.
   *
   * During E2E tests: if the KOVITOBOARD_E2E_TMUX_SESSION environment variable is set,
   * use that session name. In production mode this is a no-op (when the env var is not set,
   * behavior is unchanged).
   * @see docs/design/fake-claude-design.md §5-3 approach A
   */
  get sessionName(): string {
    if (!this._sessionName) {
      const e2eSession = process.env.KOVITOBOARD_E2E_TMUX_SESSION
      this._sessionName = e2eSession || resolveTmuxSessionName(this.fs)
    }
    return this._sessionName
  }

  /**
   * Convert agent ID to tmux window name.
   * KovitoBoard: returns the agent ID as-is for the window name.
   */
  resolveWindowName(agentId: string): string {
    return agentId
  }

  /**
   * Get the mapping table.
   * Dynamically built from the actual window list.
   */
  getAgentWindowMap(): Record<string, string> {
    const windows = this.listWindows()
    const map: Record<string, string> = {}
    for (const w of windows) {
      if (w.name !== 'main') {
        // window name = agent ID = mapping target
        map[w.name] = w.name
      }
    }
    return map
  }

  /**
   * Check if the KovitoBoard tmux session exists.
   * Explicitly sets stdio: 'pipe' to prevent stderr from leaking to the console.
   */
  hasSession(): boolean {
    try {
      execFileSync('tmux', ['has-session', '-t', this.sessionName], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /**
   * Get the window list for the KovitoBoard session.
   */
  listWindows(): TmuxWindow[] {
    try {
      const output = execFileSync('tmux', [
        'list-windows', '-t', this.sessionName,
        '-F', '#{window_index}|#{window_name}|#{window_active}',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

      if (!output) return []

      return output.split('\n').map((line) => {
        const [index, name, active] = line.split('|')
        return {
          index: Number(index),
          name,
          active: active === '1',
        }
      })
    } catch {
      return []
    }
  }

  /**
   * Send a message to the specified window (agent).
   *
   * @param windowName Window name (agent ID)
   * @param message Message to send
   */
  sendMessage(windowName: string, message: string): TmuxSendResult {
    if (!isValidTmuxName(windowName)) {
      return { success: false, error: `Invalid window name: "${windowName}"` }
    }

    // Check KovitoBoard session exists
    if (!this.hasSession()) {
      return { success: false, error: `tmux session "${this.sessionName}" does not exist` }
    }

    // Check window exists
    const windows = this.listWindows()
    const target = windows.find((w) => w.name === windowName)
    if (!target) {
      return {
        success: false,
        error: `Window "${windowName}" not found. Existing windows: ${windows.map((w) => w.name).join(', ') || '(none)'}`,
      }
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      this.sendViaBuffer(tmuxTarget, message)

      console.log(`[tmux-bridge] Send complete: ${tmuxTarget} (${message.length} chars)`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] Send error: ${tmuxTarget}`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Clear the existing session then send a new message.
   */
  async clearAndSendMessage(windowName: string, message: string): Promise<TmuxSendResult> {
    if (!isValidTmuxName(windowName)) {
      return { success: false, error: `Invalid window name: "${windowName}"` }
    }

    if (!this.hasSession()) {
      return { success: false, error: `tmux session "${this.sessionName}" does not exist` }
    }

    const windows = this.listWindows()
    const target = windows.find((w) => w.name === windowName)
    if (!target) {
      return {
        success: false,
        error: `Window "${windowName}" not found. Existing windows: ${windows.map((w) => w.name).join(', ') || '(none)'}`,
      }
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      execFileSync('tmux', ['send-keys', '-t', tmuxTarget, '/clear', 'Enter'], { stdio: 'pipe' })
      console.log(`[tmux-bridge] /clear sent: ${tmuxTarget}`)

      const ready = await this.waitForPrompt(tmuxTarget, 15000)
      if (!ready) {
        console.warn(`[tmux-bridge] Prompt detection timeout: ${tmuxTarget} (proceeding with fallback send)`)
      }

      this.sendViaBuffer(tmuxTarget, message)

      console.log(`[tmux-bridge] clear+send complete: ${tmuxTarget} (${message.length} chars)`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] clear+send error: ${tmuxTarget}`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Wait for the input prompt to appear after agent startup.
   * Called from index.ts before sending a message right after a new launch.
   */
  async waitForAgentReady(windowName: string, timeoutMs: number): Promise<boolean> {
    const tmuxTarget = `${this.sessionName}:${windowName}`
    return this.waitForPrompt(tmuxTarget, timeoutMs)
  }

  /**
   * Wait for prompt to appear.
   */
  private async waitForPrompt(tmuxTarget: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      try {
        const output = execFileSync('tmux', [
          'capture-pane', '-t', tmuxTarget, '-p', '-S', '-5',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        const lines = output.split('\n').filter((l) => l.trim())
        const lastLines = lines.slice(-3).join(' ')
        if (lastLines.includes('❯') && lastLines.includes('⏵')) {
          console.log(`[tmux-bridge] Prompt detected: ${tmuxTarget} (${Date.now() - startTime}ms)`)
          return true
        }
      } catch {
        // Ignore capture-pane failures and continue
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    return false
  }

  /**
   * Safely send a message via load-buffer -> paste-buffer -> Enter.
   */
  private sendViaBuffer(tmuxTarget: string, message: string): void {
    const tmpFile = join(tmpdir(), `kovitoboard-tmux-${randomUUID()}.txt`)

    try {
      const sanitized = message
        .replace(/\r\n/g, '\\n')
        .replace(/[\r\n]/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim()

      if (!sanitized) {
        throw new Error('Message is empty after sanitization')
      }

      console.log(`[tmux-bridge] Preparing to send: ${sanitized.length} chars`)

      this.fs.writeFileSync(tmpFile, sanitized, 'utf-8')

      execFileSync('tmux', [
        'load-buffer', tmpFile,
        ';', 'paste-buffer', '-r', '-t', tmuxTarget,
        ';', 'send-keys', '-t', tmuxTarget, 'Enter',
      ], { stdio: 'pipe' })
    } finally {
      try { this.fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  }

  /**
   * Create the KovitoBoard session if it does not exist.
   */
  ensureSession(): void {
    if (this.hasSession()) return

    const projectRoot = resolveProjectRoot(this.fs)
    execFileSync('tmux', [
      'new-session', '-d', '-s', this.sessionName, '-n', 'main', '-c', projectRoot,
    ], { stdio: 'pipe' })
    console.log(`[tmux-bridge] Session "${this.sessionName}" created (cwd: ${projectRoot})`)
  }

  /**
   * Start an agent in a new window.
   *
   * Phase 5+: Auto-approval of the trust prompt at startup has been removed (spec sections 3-3 / 5-3-3).
   * If an initial folder trust prompt appears, it is picked up by the detection loop
   * (trust-prompt-detector) and relayed to the UI.
   */
  async startAgent(agentId: string, windowName?: string, cwd?: string): Promise<TmuxSendResult> {
    if (!isValidTmuxName(agentId)) {
      return { success: false, error: `Invalid agent ID: "${agentId}"` }
    }
    const name = windowName || agentId
    if (windowName && !isValidTmuxName(windowName)) {
      return { success: false, error: `Invalid window name: "${windowName}"` }
    }
    const workDir = cwd || resolveProjectRoot(this.fs)

    const windows = this.listWindows()
    if (windows.find((w) => w.name === name)) {
      return { success: false, error: `Window "${name}" already exists` }
    }

    this.ensureSession()

    try {
      execFileSync('tmux', [
        'new-window', '-t', this.sessionName, '-n', name, '-c', workDir,
        'claude', '--agent', agentId,
      ], { stdio: 'pipe' })
      console.log(`[tmux-bridge] Agent started: ${name} (${agentId}) in ${workDir}`)

      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] Agent start error:`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Start a generic job in a new tmux window with `claude` in interactive mode.
   *
   * Unlike startAgent (which uses --agent flag), this starts claude without
   * arguments, allowing the caller to send an arbitrary prompt via sendMessage.
   *
   * Intended for app-level background jobs (e.g., Research Reports).
   */
  startJobWindow(windowName: string, cwd?: string): TmuxSendResult {
    if (!isValidTmuxName(windowName)) {
      return { success: false, error: `Invalid window name: "${windowName}"` }
    }
    const workDir = cwd || resolveProjectRoot(this.fs)

    const windows = this.listWindows()
    if (windows.find((w) => w.name === windowName)) {
      return { success: false, error: `Window "${windowName}" already exists` }
    }

    this.ensureSession()

    try {
      execFileSync('tmux', [
        'new-window', '-t', this.sessionName, '-n', windowName, '-c', workDir,
        'claude',
      ], { stdio: 'pipe' })
      console.log(`[tmux-bridge] Job window started: ${windowName} in ${workDir}`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] Job window start error:`, errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Kill (close) a tmux window by name.
   *
   * Idempotent: returns true if the window was killed or did not exist.
   */
  killWindow(windowName: string): boolean {
    if (!isValidTmuxName(windowName)) return false
    if (!this.hasSession()) return true // session gone → window is already gone

    try {
      execFileSync('tmux', [
        'kill-window', '-t', `${this.sessionName}:${windowName}`,
      ], { stdio: 'pipe' })
      console.log(`[tmux-bridge] Window killed: ${windowName}`)
      return true
    } catch {
      // Window may not exist — that's fine (idempotent)
      return true
    }
  }

  /**
   * Get the current pane content of a window.
   *
   * Called from the Phase 5 detection loop (capture-pane -p -S -<lines> -E -).
   * Also useful for debugging.
   */
  capturePane(windowName: string, lines?: number): string | null {
    if (!isValidTmuxName(windowName)) return null
    try {
      const lineCount = lines || 50
      const output = execFileSync('tmux', [
        'capture-pane', '-t', `${this.sessionName}:${windowName}`, '-p', '-S', `-${lineCount}`,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      return output
    } catch {
      return null
    }
  }

  /**
   * Receive a user response from trust-prompt-detector and send-keys to tmux.
   *
   * @param windowName Target window name
   * @param keys Key sequence to send (trailing `\n` is converted to `Enter` key)
   * @param literal If `true`, send via `send-keys -l` (literal mode, for fallback UX)
   * @returns Whether the send was successful
   */
  sendTrustPromptKeys(windowName: string, keys: string, literal = false): boolean {
    if (!isValidTmuxName(windowName)) {
      console.warn(`[tmux-bridge] Invalid window name: "${windowName}"`)
      return false
    }
    if (!this.hasSession()) {
      console.warn(`[tmux-bridge] tmux session "${this.sessionName}" does not exist`)
      return false
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      const args = ['send-keys', '-t', tmuxTarget]
      if (literal) {
        args.push('-l', '--', keys)
      } else {
        // Convert trailing `\n` to Enter key
        const parts = parseKeysForSendKeys(keys)
        args.push('--', ...parts)
      }
      execFileSync('tmux', args, { stdio: 'pipe' })
      console.log(`[tmux-bridge] trust-prompt response sent: ${tmuxTarget} keys=${JSON.stringify(keys)} literal=${literal}`)
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[tmux-bridge] trust-prompt response send error: ${tmuxTarget}`, errorMsg)
      return false
    }
  }
}

/**
 * Convert `"1\n"` -> `["1", "Enter"]` / `"Enter"` -> `["Enter"]`
 *
 * tmux `send-keys` accepts key names (`Enter`, `Escape`, etc.) and regular characters
 * as multiple arguments. The spec section 5-1 `choices[].keys` uses `"2\n"` format,
 * but since sending raw `\n` complicates escape interpretation, trailing `\n` is
 * converted to `Enter`.
 */
export function parseKeysForSendKeys(keys: string): string[] {
  if (keys.length === 0) return []
  if (keys.endsWith('\n')) {
    const prefix = keys.slice(0, -1)
    return prefix ? [prefix, 'Enter'] : ['Enter']
  }
  return [keys]
}
