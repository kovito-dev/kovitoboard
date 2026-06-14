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
import { validateCwd } from './cwdValidator'
import { ensureWorkRootMetadata } from './cwd-precheck'

/**
 * Run the cwd allow-list gate for a `cwd` argument passed to one of
 * the tmux-bridge entrypoints (consumer #4 / #5 in spec
 * `cwd-allowlist.md` v1.0 §5.2). Spec §7.1 prescribes a throw — the
 * boundary-external helper contract (`app-directory-extension.md`
 * v1.4.5 §5.0) hands enforcement back to the embedded-app caller,
 * which is expected to catch and surface the error itself.
 *
 * Returns the canonical `resolvedCwd` so callers can satisfy the
 * §8.3 TOCTOU defence by passing it (rather than the raw input) to
 * `tmux -c …`.
 */
function gateCwd(fs: FileAccessLayer, cwd: string): string {
  const projectRoot = resolveProjectRoot(fs)
  const snapshot = ensureWorkRootMetadata(fs, projectRoot)
  const result = validateCwd(
    cwd,
    projectRoot,
    snapshot.additionalWorkRoots,
    snapshot.workRootsMetadata,
    fs,
  )
  if (!result.ok) {
    throw new Error(
      `cwd not in allowed work roots (reason=${result.reason})`,
    )
  }
  return result.resolvedCwd
}

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

// =========================
// Input-prompt readiness detection (waitForPrompt)
// =========================

/**
 * Number of trailing non-empty lines sampled from `capture-pane` for
 * prompt-readiness detection.
 *
 * Claude Code >= 2.1.x renders extra chrome below the input box (an
 * agent status line `🤖 … | ⏱ … | …` plus a multi-agent footer
 * `⏵⏵ … · ← for agents`). The legacy 3-line window pushed the `❯`
 * caret line out of view, so detection always timed out. An 8-line
 * window absorbs that chrome height and keeps the caret in view.
 *
 * Spec SSOT: session-management.md v1.5 §7.2.1.
 */
export const PROMPT_SAMPLE_LINES = 8

/** Capture range (`capture-pane -S`) wide enough to fill the 8-line window. */
export const PROMPT_CAPTURE_START = -8

/**
 * Box-drawing characters that make up the input-box borders. A line
 * composed solely of these (plus whitespace) is treated as a border.
 */
const BOX_CHARS = '│╭╮╯╰─━┃┌┐└┘├┤┬┴┼'

/**
 * Footer wording shown beneath a live (ready) input prompt. Kept
 * permissive to absorb minor UI wording changes across Claude Code
 * releases. `⏵` covers the 2.1.x multi-agent permission footer
 * (`⏵⏵ bypass permissions on … · ← for agents`).
 *
 * Spec SSOT: session-management.md v1.5 §7.2.3.
 */
export const PROMPT_FOOTER_MARKER =
  /( for shortcuts|⏵|Ctrl[+-]C|Enter to|Tab to|Esc to)/

/**
 * Markers that mean the pane is busy generating a response — when any
 * is present the prompt is NOT ready.
 *
 * Claude Code >= 2.1.x uses a randomized-gerund spinner anchored by the
 * `✻` / `✢` glyph (`✻ Hyperspacing… (1m 26s)`, `✻ Sautéed for 9s`,
 * `✢ Transfiguring… (thinking)`), usually paired with an
 * `esc to interrupt` hint. The spinner glyph is the unambiguous anchor:
 * we deliberately do NOT key on a bare `esc to interrupt`, because the
 * ready-state footer can also surface `Esc to interrupt`, which would
 * make readiness impossible to declare.
 *
 * Spec SSOT: session-management.md v1.5 §7.2.3.
 */
export const PROMPT_PROCESSING_MARKER =
  /[✻✢]|Running…|thinking\)|\(streaming/

/**
 * The Claude Code agent status line, whose live token/elapsed-time
 * fields (`🤖 … | ⏱ 6m26s | …`) change every frame. Used ONLY to strip
 * the volatile line before the stability comparison — never for caret /
 * footer / processing / trust matching.
 *
 * Spec SSOT: session-management.md v1.5 §7.2.2.
 */
const VOLATILE_STATUS_LINE = /🤖.*⏱/

/**
 * Reduce a `capture-pane` output to the trailing non-empty sample
 * window (empty lines removed, last `PROMPT_SAMPLE_LINES` kept).
 */
export function sampleWindow(capture: string): string[] {
  const lines = capture.split('\n').filter((l) => l.trim())
  return lines.slice(-PROMPT_SAMPLE_LINES)
}

/** A line made up of box-drawing characters / whitespace only. */
function isBorderLine(line: string): boolean {
  const stripped = line.trim()
  if (stripped.length === 0) return false
  for (const ch of stripped) {
    if (ch === ' ') continue
    if (!BOX_CHARS.includes(ch)) return false
  }
  return true
}

/**
 * A line that delimits the top of the input box. This is either a pure
 * border line OR a labelled border such as `──────── chief ──`, where
 * the centre carries the agent name. We accept the labelled form by
 * requiring the line to (a) contain a box-drawing run and (b) consist
 * only of box chars, whitespace, and word characters (the label) — so a
 * caret/menu/activity line never qualifies.
 */
function isInputBoxBoundaryLine(line: string): boolean {
  const stripped = line.trim()
  if (stripped.length === 0) return false
  if (isBorderLine(line)) return true
  let hasBox = false
  for (const ch of stripped) {
    if (BOX_CHARS.includes(ch)) {
      hasBox = true
      continue
    }
    // Allow the label run: spaces and word characters only.
    if (ch === ' ' || /[\w]/.test(ch)) continue
    return false
  }
  return hasBox
}

/**
 * A live input-box caret line: a lone `❯` accompanied only by
 * whitespace or box characters (e.g. `❯` or `│ ❯ │`). Excludes menu
 * cursors / activity lines that merely contain `❯` amid other text.
 */
function isCaretLine(line: string): boolean {
  if (!line.includes('❯')) return false
  const stripped = line.trim()
  for (const ch of stripped) {
    if (ch === '❯' || ch === ' ' || BOX_CHARS.includes(ch)) continue
    return false
  }
  return true
}

/**
 * True when the sample window contains an input-box caret line — a lone
 * `❯` line bounded by an input-box boundary line (a border, or a
 * labelled border such as `── chief ──`) on at least one adjacent side.
 *
 * This per-line check replaces the legacy `joinedTail.includes('❯')`
 * substring test, which false-matched trust-prompt menu cursors and
 * activity lines.
 *
 * Spec SSOT: session-management.md v1.5 §7.2.1.
 */
export function hasInputBoxCaret(window: string[]): boolean {
  for (let i = 0; i < window.length; i++) {
    if (!isCaretLine(window[i])) continue
    const above = i > 0 ? isInputBoxBoundaryLine(window[i - 1]) : false
    const below =
      i < window.length - 1 ? isInputBoxBoundaryLine(window[i + 1]) : false
    if (above || below) return true
  }
  return false
}

/**
 * Build the stability-comparison string: the sample window with the
 * volatile status line (`🤖 … ⏱ …`) removed, so the per-second elapsed
 * timer does not prevent the "no change for STABILITY_MS" condition
 * from ever holding.
 *
 * IMPORTANT: this normalization is for the stability comparison ONLY.
 * Caret / footer / processing / trust matching all run against the raw
 * capture window (volatile line included).
 *
 * Spec SSOT: session-management.md v1.5 §7.2.2.
 */
export function stabilityString(window: string[]): string {
  return window.filter((l) => !VOLATILE_STATUS_LINE.test(l)).join('\n')
}

export type PromptDecision =
  | { ready: true; via: 'primary' | 'stability' }
  | { ready: false; reason: 'no-caret' | 'trust' | 'processing' | 'unstable' }

/**
 * Decide whether a single captured frame represents a ready input
 * prompt. Pure — given the raw capture window and whether the
 * volatile-stripped stability string has held still long enough, it
 * returns the readiness verdict and the reason/path.
 *
 * Matching surfaces (per spec §7.2.1/§7.2.2 design separation):
 *   - caret / footer / processing / trust → raw window (volatile-included)
 *   - stability                            → caller passes `stableHeld`,
 *     computed from `stabilityString` (volatile-stripped)
 *
 * Spec SSOT: session-management.md v1.5 §7.2.1–§7.2.3.
 */
export function evaluatePromptFrame(
  window: string[],
  stableHeld: boolean,
): PromptDecision {
  const joined = window.join('\n')

  if (!hasInputBoxCaret(window)) {
    return { ready: false, reason: 'no-caret' }
  }
  // Trust-prompt dialogs (folder-trust, auto-mode, edit/write/bash/read,
  // sandbox-network, etc.) share enough surface markers with the live
  // input prompt that the loose footer marker would false-positive on
  // them. If we mistook one for a ready prompt, the caller would send
  // the initial message straight into the dialog, which silently
  // consumes the keystrokes and fires Enter to accept the default
  // option (e.g. "Yes, I trust this folder"), losing the message and
  // skipping the trust-prompt modal handshake. Treat any trust-prompt
  // footer as "not ready" so we keep waiting until the modal relay
  // clears the dialog and the live prompt actually appears.
  if (TRUST_FOOTER_PATTERNS.some((re) => re.test(joined))) {
    return { ready: false, reason: 'trust' }
  }
  if (PROMPT_PROCESSING_MARKER.test(joined)) {
    return { ready: false, reason: 'processing' }
  }
  // Primary: caret + known footer.
  if (PROMPT_FOOTER_MARKER.test(joined)) {
    return { ready: true, via: 'primary' }
  }
  // Stability fallback: caret + volatile-stripped window unchanged for
  // STABILITY_MS (footer wording shifted but the prompt has settled).
  if (stableHeld) {
    return { ready: true, via: 'stability' }
  }
  return { ready: false, reason: 'unstable' }
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
   * session name. The double-gate is a **misconfiguration guard**,
   * not a complete hostile-environment mitigation: an attacker who
   * already controls the launcher's full env block can set both
   * variables together and reach the override anyway. What this gate
   * *does* close is the narrower scenario where a single stray
   * `KOVITOBOARD_E2E_TMUX_SESSION` entry — left behind by a shared
   * dotfile, a wrapper script that preserves environment across
   * profiles, or a copy-pasted launcher — silently redirects a
   * production KovitoBoard onto a different operator's tmux session.
   * `KB_E2E_MODE` is the canonical "this is a test harness" flag
   * (already used by `/api/admin/test-reset-state` and the
   * trust-prompt-detector poll interval), so requiring it here keeps
   * the test surfaces consistent and turns "I forgot to unset the
   * env var" into a loud warn log instead of a silent attach.
   *
   * When `KOVITOBOARD_E2E_TMUX_SESSION` is set without `KB_E2E_MODE`,
   * the env var is ignored and a warn-level log entry is emitted so
   * the misconfiguration surfaces rather than silently falling back
   * to the production session name.
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
        // misconfiguration that, in the supplementary review §S6
        // scenario, could redirect KovitoBoard onto another
        // operator's tmux session.
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
   *   Primary  : input-box caret line + known footer marker.
   *   Fallback : input-box caret line + volatile-stripped window stable
   *              (no change) for STABILITY_MS.
   *
   * The fallback path absorbs Claude Code UI chrome changes where the
   * footer wording has shifted but the caret and stability properties
   * still hold. The frame verdict is delegated to the pure
   * `evaluatePromptFrame`; this method only owns the poll loop and
   * stability timer.
   *
   * Spec SSOT: session-management.md v1.5 §7.2.
   */
  private async waitForPrompt(tmuxTarget: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 500
    const STABILITY_MS = 1500 // caret visible + no change for 1.5s

    // Stability is tracked against the volatile-stripped window only
    // (see `stabilityString`); the per-second status timer must not
    // reset it. Caret / footer / processing / trust matching all run
    // against the raw window inside `evaluatePromptFrame`.
    let lastStabilityString = ''
    let lastChangeAt = Date.now()
    let lastSampledLines: string[] = []

    while (Date.now() - startTime < timeoutMs) {
      try {
        const output = execFileSync('tmux', [
          'capture-pane', '-t', tmuxTarget, '-p', '-S', String(PROMPT_CAPTURE_START),
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        const window = sampleWindow(output)
        lastSampledLines = window

        // Track stability on the volatile-stripped string.
        const stability = stabilityString(window)
        if (stability !== lastStabilityString) {
          lastStabilityString = stability
          lastChangeAt = Date.now()
        }
        const stableHeld = Date.now() - lastChangeAt >= STABILITY_MS

        const decision = evaluatePromptFrame(window, stableHeld)
        if (decision.ready) {
          tmuxLogger.info(
            {
              tmuxTarget,
              elapsedMs: Date.now() - startTime,
              via: decision.via,
              ...(decision.via === 'stability'
                ? { stableMs: Date.now() - lastChangeAt }
                : {}),
            },
            `Prompt detected (${decision.via})`,
          )
          return true
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

      // Spool the paste body to a same-UID-only tmpfile.
      //
      // `writePrivateExclusiveFileSync` bakes in three properties
      // we need from the tmpfile, all enforced inside the fs-layer
      // (`session-management.md` §7.1 normative, Codex Review §15):
      //
      // - Mode `0o600`: only the KB process owner can read the
      //   spool body. `/tmp` is world-readable with the sticky
      //   bit, so the Node default (`0o666 & ~umask`) would
      //   otherwise leave the paste exposed to other local UIDs
      //   for the few milliseconds between the write and the
      //   `unlinkSync` in `finally`.
      // - `O_CREAT | O_EXCL` (`'wx'` flag): an attacker who
      //   pre-created the predicted path (despite `randomUUID()`)
      //   gets EEXIST instead of having us truncate their file or
      //   write into a planted symlink target.
      // - `fchmod(0o600)` on the fresh descriptor: a hardened
      //   operator shell with e.g. `umask 0o477` would otherwise
      //   strip owner-read from the file and turn the very
      //   `tmux load-buffer` call below into EACCES — an
      //   availability regression on top of the security fix.
      //
      // The narrow shape of that helper (no parameters for mode /
      // flag) keeps this umask-bypass capability confined to the
      // call sites the spec lists, instead of being exposed as a
      // generic option on `writeFileSync`.
      this.fs.writePrivateExclusiveFileSync(tmpFile, sanitized)

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
    // cwd allow-list gate — consumer #4 in spec `cwd-allowlist.md`
    // v1.0 §5.2 (embedded-app entrypoint, boundary-external).
    //
    // The condition uses `cwd !== undefined` rather than the truthy
    // `if (cwd)` form: an empty string `""` is a *supplied* value and
    // must be validated (and rejected as `not_absolute`) instead of
    // silently falling back to `projectRoot`. The HTTP entry points
    // already reject `""` at the boundary; this guard matches that
    // contract for the boundary-external entrypoint (CodeX PR #38
    // Attempt 14 MED 2).
    let workDir: string
    if (cwd !== undefined) {
      try {
        workDir = gateCwd(this.fs, cwd)
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    } else {
      workDir = resolveProjectRoot(this.fs)
    }

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
    // cwd allow-list gate — consumer #5 in spec `cwd-allowlist.md`
    // v1.0 §5.2 (job-window entrypoint, boundary-external).
    //
    // Same `cwd !== undefined` guard as `startAgent` above — empty
    // strings are validated and rejected, not silently widened into
    // the project root (CodeX PR #38 Attempt 14 MED 2).
    let workDir: string
    if (cwd !== undefined) {
      try {
        workDir = gateCwd(this.fs, cwd)
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    } else {
      workDir = resolveProjectRoot(this.fs)
    }

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
