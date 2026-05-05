/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent Activity Monitor
 *
 * Periodically samples the latest meaningful line from each tmux window's
 * pane and broadcasts changes to the renderer as `agent_activity` events.
 *
 * Purpose
 * -------
 * While an agent is "thinking" / "waiting", the chat timeline only shows
 * a 3-dot pulse. Users have no insight into what the agent is actually
 * doing (which file is being read, which command is running, whether
 * generation is stalled). Mirroring the most recent activity line that
 * the Claude Code TUI is rendering gives that signal back without
 * requiring any structured event from Claude itself.
 *
 * Design
 * ------
 *   - Runs on a 1-second tick. Lower than the trust-prompt detector
 *     (200 ms) because this is purely informational and we want to keep
 *     `tmux capture-pane` overhead minimal.
 *   - Only emits when the extracted line actually changes vs the last
 *     reported one for that window. No diffing on the renderer.
 *   - Skips windows that cannot be mapped to a live session.
 *   - Detector and Monitor coexist on the same tmux capture infrastructure
 *     but stay decoupled — different cadences, different responsibilities.
 *
 * Activity-line extraction
 * ------------------------
 * The tmux pane is a mix of (a) the input prompt box, (b) status footers
 * such as "? for shortcuts" / "Esc to cancel", and (c) the actual
 * activity stream Claude writes line-by-line (`● Bash(...)`, `● Read(...)`,
 * `✻ Synthesizing... (Xs)`, etc.). We walk from the bottom up and pick
 * the first line that is *not* one of the chrome elements. That heuristic
 * matches both ongoing tool use and the spinner line during generation.
 *
 * The extracted line is trimmed to 80 chars to keep the WS payload small
 * and prevent the inline display in the chat from blowing out the
 * typing-indicator pill.
 */

import type { TmuxBridge } from './tmux-bridge'
import type { ServerToClientEvent } from '../shared/ws-events'
import { lazyChildLogger } from './logger'

// Lazy so this module can be imported before `initLogger()` runs
// (e.g. by `extractActivityLine` unit tests). Mirrors the pattern used
// by `trust-prompt-detector.ts` for `trust-patterns` logging.
const log = lazyChildLogger('agent-activity')

/** Polling interval (ms). Once per second is plenty for a UI status hint. */
export const POLL_INTERVAL_MS = 1000

/** How many tail lines to look at when picking the activity line. */
const CAPTURE_LINES = 50

/**
 * Truncate the activity line to this many characters before broadcasting.
 *
 * Bumped from 80 → 120 chars on 2026-05-03 because the typing-indicator
 * pill in the chat timeline often saw lines like `● Read(/long/path/...)`
 * cut down to a useless prefix. The pill wraps once on narrow viewports
 * and that is acceptable — losing the actual filename is not.
 */
const MAX_LINE_LENGTH = 120

/**
 * Lines we never want to surface as "the agent is doing this".
 * Each regex is tested against the *plain* line (after ANSI stripping
 * and trimming) — no anchors needed unless we want to be strict.
 */
const CHROME_PATTERNS: RegExp[] = [
  /\? for shortcuts/i,
  /Esc to (cancel|interrupt|exit)/i,
  /Tab to (amend|cycle|complete)/i,
  /ctrl\+\w/i,
  /Enter to confirm/i,
  // Empty input-prompt arrow. `>` is the historical form, `❯` (U+276F)
  // is the current Claude Code 2.1.x form. Without the U+276F branch
  // the heuristic happily picks the empty arrow as "the agent's
  // activity" and the typing-indicator pill shows just `❯`.
  /^[>❯]\s*$/,
  /^Tip:/i,
  /^※\s*Tip:/i,
  /tell Claude what to do differently/i,
  // Permission-mode indicator banner that sits below the input box,
  // e.g. `⏵⏵ accept edits on (shift+tab to cycle)` /
  // `⏸ plan mode on (shift+tab to cycle)`. These lines describe the
  // *user's* current toggle state, not the agent's activity.
  /^[⏵⏸▶▷]+\s/u,
  /\(shift\+tab to cycle\)/i,
  /^auto[- ]?accept edits/i,
  /^accept edits on/i,
  /^plan mode on/i,
  /^bypass permissions/i,
]

/**
 * Box-drawing characters that delimit Claude Code's input prompt. Any
 * line consisting mostly of these (with the input box's interior text
 * being whitespace-only) is treated as chrome. `❯` is included because
 * Claude Code 2.1.x renders the empty input prompt as a bare `❯` (no
 * surrounding box characters) when the input is focused.
 */
const BOX_CHARS_RE = /^[\s│╭╮╯╰─━┃┌┐└┘├┤┬┴┼>❯·]+$/u

/**
 * Agent-name marker line that delimits the upper edge of Claude Code's
 * input area, e.g. `──────────────────────── kovito-concierge ──`. When
 * this line is present in the capture, every line *below* it belongs to
 * the input box / mode indicator / footer and must not be surfaced as
 * agent activity. The activity stream proper sits above it.
 *
 * The right-side label is the agent ID (alphanumeric + `_-`); we leave
 * a generous trailing-dash run (`──+`) so future Claude Code releases
 * that pad the marker with extra dashes still match.
 */
const AGENT_NAME_MARKER_RE = /^─{3,}\s*[A-Za-z0-9_-]+\s*──+$/

/** ANSI / OSC escape sequence stripper. */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Pick the most recent meaningful activity line from a capture buffer.
 *
 * Returns null when nothing suitable was found (empty pane, only chrome
 * lines visible, etc.) — callers should treat that as "no update" rather
 * than "agent is idle".
 *
 * Exported so the extraction logic can be unit-tested independently of
 * tmux execution.
 */
export function extractActivityLine(capture: string): string | null {
  if (!capture) return null

  // Strip ANSI escapes so the heuristics operate on plain text. Most
  // captures from `tmux capture-pane -p` are already plain, but newer
  // Claude Code releases occasionally embed OSC hyperlinks.
  const plain = capture.replace(ANSI_RE, '')
  const lines = plain.split('\n')

  // Locate the upper edge of the input box (the
  // `──...── <agent-name> ──` marker). Everything below this index is
  // input + mode indicator + footer; the activity stream lives above
  // it. Walking from the bottom up means we always find the *most
  // recent* marker when a session has scrolled past several inputs.
  let searchEnd = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (AGENT_NAME_MARKER_RE.test(lines[i].trim())) {
      searchEnd = i
      break
    }
  }

  for (let i = searchEnd - 1; i >= 0; i--) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (BOX_CHARS_RE.test(trimmed)) continue
    if (CHROME_PATTERNS.some((re) => re.test(trimmed))) continue

    // Lines that begin with "│" are inside the input box — even when
    // they contain text it is the user's draft, not agent activity.
    // Defensive: should already be filtered by the marker-based slice
    // above, but a malformed pane (no marker found) can still reach
    // here so we keep the guard.
    if (trimmed.startsWith('│')) continue

    // Limit length and we are done.
    return trimmed.length > MAX_LINE_LENGTH
      ? trimmed.slice(0, MAX_LINE_LENGTH - 1) + '…'
      : trimmed
  }

  return null
}

/**
 * Resolve a tmux window name (= agent id) to the most recent session id
 * tied to that agent, or null when no session is associated yet.
 */
export type WindowToSessionResolver = (windowName: string) => string | null

export type BroadcastFn = (event: ServerToClientEvent) => void

export class AgentActivityMonitor {
  private timer: NodeJS.Timeout | null = null
  /** Last reported line per window — used to suppress no-op broadcasts. */
  private lastByWindow = new Map<string, string>()

  constructor(
    private tmux: TmuxBridge,
    private broadcast: BroadcastFn,
    private resolveSessionId: WindowToSessionResolver,
  ) {}

  /** Start the polling loop. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS)
    log.debug({ intervalMs: POLL_INTERVAL_MS }, 'started')
  }

  /** Stop the polling loop and forget cached state. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lastByWindow.clear()
  }

  private tick(): void {
    if (!this.tmux.hasSession()) {
      // tmux session not running — drop cached state so we re-emit when
      // it comes back instead of silently suppressing the first line.
      if (this.lastByWindow.size > 0) this.lastByWindow.clear()
      return
    }

    let windows: ReturnType<TmuxBridge['listWindows']>
    try {
      windows = this.tmux.listWindows()
    } catch (err) {
      log.warn({ err }, 'listWindows failed; skipping tick')
      return
    }

    // GC: drop cached entries for windows that disappeared.
    const liveNames = new Set(windows.map((w) => w.name))
    for (const name of Array.from(this.lastByWindow.keys())) {
      if (!liveNames.has(name)) this.lastByWindow.delete(name)
    }

    for (const w of windows) {
      if (w.name === 'main') continue

      let capture: string | null = null
      try {
        capture = this.tmux.capturePane(w.name, CAPTURE_LINES)
      } catch (err) {
        log.warn({ err, windowName: w.name }, 'capturePane failed')
        continue
      }
      if (!capture) continue

      const line = extractActivityLine(capture)
      if (line === null) continue

      const previous = this.lastByWindow.get(w.name)
      if (previous === line) continue
      this.lastByWindow.set(w.name, line)

      const sessionId = this.resolveSessionId(w.name)
      if (!sessionId) continue

      this.broadcast({
        type: 'agent_activity',
        payload: {
          sessionId,
          windowName: w.name,
          line,
          ts: Date.now(),
        },
      })
    }
  }
}
