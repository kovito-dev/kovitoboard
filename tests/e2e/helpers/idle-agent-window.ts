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
import { execSync, spawnSync } from 'node:child_process'

export interface IdleAgentWindow {
  sessionName: string
  windowName: string
  dispose(): void
}

/**
 * Create a quiet tmux window named `agentId` inside `sessionName`. The
 * session is created if it does not exist (matching the Fake Claude
 * harness dimensions). The pane runs `cat`, so it stays alive and blank.
 */
export function startIdleAgentWindow(
  sessionName: string,
  agentId: string,
): IdleAgentWindow {
  const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: 'pipe',
  })
  if (hasSession.status !== 0) {
    execSync(`tmux new-session -d -s "${sessionName}" -n main -x 200 -y 50`, {
      stdio: 'pipe',
    })
  }

  // Idempotency: drop any stale window with the same name first.
  spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${agentId}`], {
    stdio: 'pipe',
  })

  // `cat` blocks on stdin and prints nothing → quiet, long-lived pane.
  execSync(`tmux new-window -t "${sessionName}" -n "${agentId}" "cat"`, {
    stdio: 'pipe',
  })

  return {
    sessionName,
    windowName: agentId,
    dispose() {
      spawnSync('tmux', ['kill-window', '-t', `${sessionName}:${agentId}`], {
        stdio: 'pipe',
      })
    },
  }
}
