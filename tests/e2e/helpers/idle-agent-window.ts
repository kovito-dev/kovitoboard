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
export function startIdleAgentWindow(
  sessionName: string,
  agentId: string,
): IdleAgentWindow {
  assertTmuxName('sessionName', sessionName)
  assertTmuxName('agentId', agentId)

  const target = `${sessionName}:${agentId}`

  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
  })
  if (hasSession.status !== 0) {
    spawnSync(
      'tmux',
      ['new-session', '-d', '-s', sessionName, '-n', 'main', '-x', '200', '-y', '50'],
      { stdio: 'pipe' },
    )
  }

  // Idempotency: drop any stale window with the same name first.
  spawnSync('tmux', ['kill-window', '-t', target], { stdio: 'pipe' })

  // `cat` blocks on stdin and prints nothing → quiet, long-lived pane.
  spawnSync('tmux', ['new-window', '-t', sessionName, '-n', agentId, 'cat'], {
    stdio: 'pipe',
  })

  return {
    sessionName,
    windowName: agentId,
    dispose() {
      spawnSync('tmux', ['kill-window', '-t', target], { stdio: 'pipe' })
    },
  }
}
