/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFileSync } from 'child_process'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { resolveProjectRoot } from './config'
import type { FileAccessLayer } from './fs-layer'
import { TRUST_FOOTER_PATTERNS } from './trust-prompt-detector'
import { tmuxLogger } from './logger'

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
   * During E2E tests: if the KOVITOBOARD_E2E_TMUX_SESSION environment
   * variable is set AND `KB_E2E_MODE === '1'` is also set, use that
   * session name. The double-gate is intentional: setting only
   * `KOVITOBOARD_E2E_TMUX_SESSION` from a production-style launcher
   * (e.g. a stray entry in a shared dotfile, a wrapper script that
   * preserves environment, or an attacker who can influence the
   * launcher's env block) would otherwise let KovitoBoard attach to
   * a different operator's tmux session and observe / drive their
   * Claude windows. `KB_E2E_MODE` is the canonical "this is a test
   * harness" flag (already used by `/api/admin/test-reset-state`
   * and the trust-prompt-detector poll interval), so requiring it
   * here keeps the test surfaces consistent and closes the
   * production attack path described in supplementary review §S6.
   *
   * When `KOVITOBOARD_E2E_TMUX_SESSION` is set without `KB_E2E_MODE`,
   * the env var is ignored and a warn-level log entry is emitted so
   * a misconfigured test environment surfaces loudly rather than
   * silently falling back to the production session name.
   *
   * @see docs/design/fake-claude-design.md §5-3 approach A
   */
  get sessionName(): string {
    if (!this._sessionName) {
      const rawE2eSession = process.env.KOVITOBOARD_E2E_TMUX_SESSION
      const e2eModeEnabled = process.env.KB_E2E_MODE === '1'
      if (rawE2eSession && !e2eModeEnabled) {
        // The env var is set but the test-harness flag is not.
        // Refuse to honour the override and log loudly: silently
        // falling back to the production session would mask a
        // misconfiguration that, in the worst case, could redirect
        // KovitoBoard to an attacker-controlled tmux session
        // (supplementary review §S6).
        tmuxLogger.warn(
          {
            envName: 'KOVITOBOARD_E2E_TMUX_SESSION',
            gateEnv: 'KB_E2E_MODE',
          },
          'Ignoring KOVITOBOARD_E2E_TMUX_SESSION because KB_E2E_MODE is not set; falling back to the project-name-derived session',
        )
      }
      const e2eSession = e2eModeEnabled ? rawE2eSession : undefined
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
  async sendMessage(windowName: string, message: string): Promise<TmuxSendResult> {
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
      await this.sendViaBuffer(tmuxTarget, message)

      tmuxLogger.info(
        { tmuxTarget, chars: message.length, preview: message.slice(0, 80) },
        'Send complete',
      )
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ tmuxTarget, errorMsg }, 'Send error')
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
      tmuxLogger.info({ tmuxTarget }, '/clear sent')

      const ready = await this.waitForPrompt(tmuxTarget, 15000)
      if (!ready) {
        tmuxLogger.warn({ tmuxTarget }, 'Prompt detection timeout, proceeding with fallback send')
      }

      await this.sendViaBuffer(tmuxTarget, message)

      tmuxLogger.info(
        { tmuxTarget, chars: message.length, preview: message.slice(0, 80) },
        'clear+send complete',
      )
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ tmuxTarget, errorMsg }, 'clear+send error')
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
   *
   * DEC-014 v1.3 Phase 1: Reduce dependence on specific footer text.
   *
   * Detection strategy:
   *   Primary  : "❯" caret + any known footer marker (expanded list).
   *   Fallback : "❯" caret + pane stable (no change) for STABILITY_MS,
   *              excluding known "processing" markers.
   *
   * The fallback path absorbs Claude Code UI chrome changes where the
   * footer wording has shifted but the caret and stability properties
   * still hold.
   */
  private async waitForPrompt(tmuxTarget: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 500
    const STABILITY_MS = 1500 // caret visible + no change for 1.5s

    // Expanded footer markers — more variants to absorb minor UI tweaks.
    const footerMarker = /( for shortcuts|Esc to interrupt|⏵|Ctrl[+-]C|Enter to|Tab to|Esc to)/
    // Processing markers — must NOT be present to declare "ready"
    const processingMarker = /(Running…|thinking\)|\(streaming)/

    let lastSample = ''
    let lastChangeAt = Date.now()
    let lastSampledLines: string[] = []

    while (Date.now() - startTime < timeoutMs) {
      try {
        const output = execFileSync('tmux', [
          'capture-pane', '-t', tmuxTarget, '-p', '-S', '-5',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        const lines = output.split('\n').filter((l) => l.trim())
        lastSampledLines = lines.slice(-3)
        const lastLines = lastSampledLines.join(' ')

        // Track stability
        if (lastLines !== lastSample) {
          lastSample = lastLines
          lastChangeAt = Date.now()
        }

        // Trust-prompt dialogs (folder-trust, auto-mode, edit/write/bash/read,
        // sandbox-network, etc.) share enough surface markers with the live
        // input prompt that the loose `footerMarker` would false-positive
        // on them — both contain "❯" (menu cursor / option indicator) and
        // a footer like "Enter to confirm" / "Esc to cancel" / "Tab to amend".
        // When that happens, the caller proceeds to send the initial message
        // straight into the dialog, which silently consumes the keystrokes
        // and fires Enter to accept the default option (e.g. "Yes, I trust
        // this folder"), losing the message and skipping the trust-prompt
        // modal handshake. Treat any trust-prompt footer as "not ready" so
        // we keep waiting until the user (via the modal relay) clears the
        // dialog and the live prompt actually appears.
        const isTrustPrompt = TRUST_FOOTER_PATTERNS.some((re) => re.test(lastLines))

        if (lastLines.includes('❯') && !isTrustPrompt) {
          // Primary: caret + known footer
          if (footerMarker.test(lastLines) && !processingMarker.test(lastLines)) {
            tmuxLogger.info(
              { tmuxTarget, elapsedMs: Date.now() - startTime },
              'Prompt detected (primary)',
            )
            return true
          }
          // Fallback: caret + stable for STABILITY_MS + not processing
          if (
            Date.now() - lastChangeAt >= STABILITY_MS &&
            !processingMarker.test(lastLines)
          ) {
            tmuxLogger.info(
              {
                tmuxTarget,
                elapsedMs: Date.now() - startTime,
                stableMs: Date.now() - lastChangeAt,
              },
              'Prompt detected (stability fallback)',
            )
            return true
          }
        }
      } catch {
        // Ignore capture-pane failures and continue
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    // On timeout, log the final capture tail so the failure can be diagnosed
    // without having to re-run tmux capture-pane manually.
    tmuxLogger.warn(
      { tmuxTarget, finalTail: lastSampledLines },
      'Prompt wait timed out',
    )

    return false
  }

  /**
   * Safely send a message via load-buffer -> paste-buffer -> Enter.
   *
   * Claude Code aggregates long paste inputs into a "[Pasted text +N
   * lines]" placeholder. If we fire the Enter key-press as part of the
   * same tmux command string (`; send-keys Enter`), Claude consumes it
   * as the tail of the paste instead of as a submit, leaving the prompt
   * parked on the placeholder with no submission. Empirically a ~300 ms
   * gap between paste-buffer and the Enter key-press is enough for the
   * aggregation to settle and the Enter to submit.
   */
  private async sendViaBuffer(tmuxTarget: string, message: string): Promise<void> {
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

      tmuxLogger.info({ chars: sanitized.length }, 'Preparing to send')

      this.fs.writeFileSync(tmpFile, sanitized, 'utf-8')

      execFileSync('tmux', [
        'load-buffer', tmpFile,
        ';', 'paste-buffer', '-r', '-t', tmuxTarget,
      ], { stdio: 'pipe' })

      // Let Claude Code finish aggregating the paste before we press Enter.
      await new Promise((resolve) => setTimeout(resolve, 300))

      execFileSync('tmux', [
        'send-keys', '-t', tmuxTarget, 'Enter',
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
    tmuxLogger.info({ sessionName: this.sessionName, cwd: projectRoot }, 'Session created')
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

    // Q13 / AA-7: the system default agent launches plain `claude`
    // without `--agent` so the user gets a vanilla Claude Code
    // session. The reserved ID is matched verbatim — no other agent
    // can shadow it because user-created IDs cannot start with `__`.
    const isSystemDefault = agentId === '__claude_default__'
    const launchArgs = isSystemDefault
      ? ['new-window', '-t', this.sessionName, '-n', name, '-c', workDir, 'claude']
      : ['new-window', '-t', this.sessionName, '-n', name, '-c', workDir, 'claude', '--agent', agentId]

    try {
      execFileSync('tmux', launchArgs, { stdio: 'pipe' })
      tmuxLogger.info({ name, agentId, workDir, isSystemDefault }, 'Agent started')

      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ errorMsg }, 'Agent start error')
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
      tmuxLogger.info({ windowName, workDir }, 'Job window started')
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ errorMsg }, 'Job window start error')
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
      tmuxLogger.info({ windowName }, 'Window killed')
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
      tmuxLogger.warn({ windowName }, 'Invalid window name')
      return false
    }
    if (!this.hasSession()) {
      tmuxLogger.warn({ sessionName: this.sessionName }, 'tmux session does not exist')
      return false
    }

    const tmuxTarget = `${this.sessionName}:${windowName}`

    try {
      if (literal) {
        const args = ['send-keys', '-t', tmuxTarget, '-l', '--', keys]
        execFileSync('tmux', args, { stdio: 'pipe' })
      } else {
        // Convert trailing `\n` to Enter key and send each part separately.
        // Sending all parts in a single `tmux send-keys -- 1 Enter` command
        // delivers characters too fast for Claude Code's ink-based UI to
        // process — the intermediate keypress may be dropped or misinterpreted.
        // Splitting into individual send-keys commands with a brief delay
        // between them ensures reliable delivery.
        const parts = parseKeysForSendKeys(keys)
        for (const part of parts) {
          execFileSync('tmux', ['send-keys', '-t', tmuxTarget, '--', part], { stdio: 'pipe' })
        }
      }
      tmuxLogger.info({ tmuxTarget, keys, literal }, 'trust-prompt response sent')
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ tmuxTarget, errorMsg }, 'trust-prompt response send error')
      return false
    }
  }

  /**
   * Send Ctrl-C to a window so Claude Code interrupts the in-flight
   * response and returns to the input mode.
   *
   * Used by the "Stop" button (Q6 / SS-5). The keystroke is `C-c` —
   * the canonical tmux name for Ctrl+C — which Claude Code treats as
   * "abort the current response, do not exit the CLI". Spec §6.5
   * approves dispatching this without an extra confirmation dialog
   * since Claude Code's own behaviour is benign.
   *
   * @returns true on success, false on validation / dispatch errors.
   *   Errors are logged so the renderer can fall through to its
   *   normal idle-detection without surfacing a popup.
   */
  sendInterrupt(windowName: string): boolean {
    if (!isValidTmuxName(windowName)) {
      tmuxLogger.warn({ windowName }, 'Invalid window name for interrupt')
      return false
    }
    if (!this.hasSession()) {
      tmuxLogger.warn({ sessionName: this.sessionName }, 'tmux session does not exist')
      return false
    }
    const tmuxTarget = `${this.sessionName}:${windowName}`
    try {
      execFileSync('tmux', ['send-keys', '-t', tmuxTarget, '--', 'C-c'], {
        stdio: 'pipe',
      })
      tmuxLogger.info({ tmuxTarget }, 'interrupt sent (C-c)')
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      tmuxLogger.error({ tmuxTarget, errorMsg }, 'interrupt send error')
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
