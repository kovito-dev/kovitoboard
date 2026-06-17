/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Idle Agent Window — a benign tmux window for "agent has a live window"
 * tests, WITHOUT triggering a trust prompt.
 *
 * Why not the Fake Claude harness?
 * --------------------------------
 * Every Fake Claude scenario paints a trust-prompt fixture into its pane,
 * which the trust-prompt-detector picks up and surfaces as a
 * `<TrustPromptModal>` overlay. That overlay intercepts pointer events and
 * blocks the MessageInput send button — irrelevant to (and disruptive for)
 * the idle-send regression, which only needs the WINDOW to exist so the
 * agent appears in `getAgentWindowMap` (`isSessionSendable` Condition 1:
 * "the agent has a tmux window"). tmux-bridge maps window name → agent id
 * (window name IS the agent id), so all this helper needs is a quiet,
 * long-lived window named after the agent.
 *
 * The window runs `cat` (blocks on stdin, paints nothing), so the pane
 * stays blank and matches no trust pattern.
 */
import { spawnSync } from 'node:child_process'

export interface IdleAgentWindow {
  sessionName: string
  windowName: string
  dispose(): void
}

/**
 * Conservative whitelist for tmux session / window names. tmux disallows
 * `:` and `.` in names anyway (they are target separators), and restricting
 * to this set means no value can carry shell metacharacters even if a
 * future change reintroduces a shell. Defence in depth: the calls below use
 * `spawnSync` argument arrays (no shell), so interpolation injection is not
 * possible regardless — but a hostile name would still let a caller target
 * a different tmux entity, so we reject it up front.
 */
const TMUX_NAME_RE = /^[A-Za-z0-9_-]+$/

function assertTmuxName(label: string, value: string): void {
  if (!TMUX_NAME_RE.test(value)) {
    throw new Error(
      `[idle-agent-window] ${label} must match ${TMUX_NAME_RE} ` +
        `(got: ${JSON.stringify(value)})`,
    )
  }
}

/**
 * Create a quiet tmux window named `agentId` inside `sessionName`. The
 * session is created if it does not exist (matching the Fake Claude
 * harness dimensions). The pane runs `cat`, so it stays alive and blank.
 *
 * All tmux invocations use `spawnSync` with an argument array (no shell),
 * so `sessionName` / `agentId` cannot inject shell commands; they are also
 * validated against `TMUX_NAME_RE` as defence in depth.
 */
/** Bound each tmux call so a wedged invocation cannot stall the worker. */
const TMUX_CALL_TIMEOUT_MS = 5_000

/**
 * Run a tmux subcommand with a bounded timeout. When `mustSucceed` is set, a
 * non-zero exit / spawn error / timeout throws with the captured stderr so a
 * missing tmux, an unhealthy server, or a rejected target surfaces here at
 * setup time instead of as an opaque spec timeout later.
 */
function tmux(args: string[], mustSucceed: boolean): void {
  const r = spawnSync('tmux', args, {
    stdio: 'pipe',
    timeout: TMUX_CALL_TIMEOUT_MS,
  })
  if (!mustSucceed) return
  if (r.error || r.status !== 0) {
    const stderr = (r.stderr?.toString() ?? '').trim()
    const reason = r.error
      ? r.error.message
      : `exit ${r.status}${stderr ? `: ${stderr}` : ''}`
    throw new Error(`[idle-agent-window] tmux ${args.join(' ')} failed (${reason})`)
  }
}

export function startIdleAgentWindow(
  sessionName: string,
  agentId: string,
): IdleAgentWindow {
  assertTmuxName('sessionName', sessionName)
  assertTmuxName('agentId', agentId)

  const target = `${sessionName}:${agentId}`

  // `has-session` legitimately returns non-zero when the session is absent,
  // so this probe is best-effort (not mustSucceed).
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
    timeout: TMUX_CALL_TIMEOUT_MS,
  })
  // Remember whether WE created the session so `dispose()` can tear it down
  // (a session the per-test fixture or another helper owns must be left
  // alone). When we created it, leaving it running would leak the session
  // and its `cat` pane across repeated local / CI runs.
  const createdSession = hasSession.status !== 0
  if (createdSession) {
    tmux(
      ['new-session', '-d', '-s', sessionName, '-n', 'main', '-x', '200', '-y', '50'],
      true,
    )
  }

  // Idempotency: drop any stale window with the same name first. This fails
  // when no such window exists, which is expected — best-effort.
  tmux(['kill-window', '-t', target], false)

  // `cat` blocks on stdin and prints nothing → quiet, long-lived pane. This
  // is the load-bearing step; surface its failure loudly.
  tmux(['new-window', '-t', sessionName, '-n', agentId, 'cat'], true)

  return {
    sessionName,
    windowName: agentId,
    dispose() {
      tmux(['kill-window', '-t', target], false)
      if (!createdSession) return
      // We created the session: tear it down once only its bookkeeping
      // `main` window remains (mirrors fake-claude-harness dispose). If the
      // per-test fixture or another helper added windows in the meantime,
      // leave the session for them and only drop our own window above.
      const list = spawnSync(
        'tmux',
        ['list-windows', '-t', sessionName, '-F', '#{window_name}'],
        { stdio: 'pipe', timeout: TMUX_CALL_TIMEOUT_MS },
      )
      if (list.status !== 0) return // session already gone
      const names = (list.stdout?.toString() ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (names.length <= 1) {
        tmux(['kill-session', '-t', sessionName], false)
      }
    },
  }
}
