/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Factory for the `startUpgradeSession` closure injected into the
 * version router (see `routes/version-routes.ts`).
 *
 * The upgrade flow (`POST /api/version/start-upgrade`) launches an
 * agent-bound Claude Code session that carries the version-upgrade
 * request. Like the other agent-bound HTTP paths (`/api/sessions/new`,
 * `/api/tmux/clear-and-send`, `/api/apps/:appId/request-removal`), it
 * MUST park an origin reservation right before `ensureTmuxAgent` so the
 * watcher can claim the agent binding once the new session id is
 * resolved. Without that reservation the `/clear`-spawned session has no
 * `agent-setting` marker and nothing to claim, so the UI falls back to
 * the "Default" agent label (spec session-management.md v1.9 §7.4.1).
 *
 * The closure is extracted into this factory (rather than inlined in
 * index.ts) so its reservation + branch behavior can be unit-tested with
 * the bridges mocked, without bootstrapping the whole server.
 */
import type { SessionManager } from './session-manager'
import type { UpgradeSessionStartResult } from './routes/version-routes'

/** Subset of `TmuxBridge` the upgrade flow touches. */
interface UpgradeTmuxBridge {
  waitForAgentReady(windowName: string, timeoutMs: number): Promise<boolean>
  sendMessage(windowName: string, message: string): Promise<{ success: boolean; error?: string }>
  clearAndSendMessage(
    windowName: string,
    message: string,
  ): Promise<{ success: boolean; error?: string }>
}

/** Subset of `ClaudeBridge` the upgrade flow touches. */
interface UpgradeClaudeBridge {
  startNewSession(message: string, agentId?: string, cwd?: string): string
}

/** Minimal logger shape (pino child) the upgrade flow uses. */
interface UpgradeLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface StartUpgradeSessionDeps {
  sessionManager: Pick<SessionManager, 'reserveOrigin'>
  ensureTmuxAgent: (agentId: string) => Promise<{ windowName: string; justStarted: boolean } | null>
  tmuxBridge: UpgradeTmuxBridge
  claudeBridge: UpgradeClaudeBridge
  logger: UpgradeLogger
}

/** How long to wait for a freshly started agent prompt before sending. */
const UPGRADE_PROMPT_WAIT_MS = 45000

export function createStartUpgradeSession(
  deps: StartUpgradeSessionDeps,
): (args: { agentId: string; message: string }) => Promise<UpgradeSessionStartResult> {
  const { sessionManager, ensureTmuxAgent, tmuxBridge, claudeBridge, logger } = deps

  return async ({ agentId, message }) => {
    // Park an origin reservation so the upgrade session inherits the
    // agent binding once the watcher resolves the new session id
    // (mirrors the /api/sessions/new and /api/tmux/clear-and-send
    // paths; spec session-management.md v1.9 §7.4.1). The agentId claim
    // is the load-bearing part; the 'sessions' origin keeps the session
    // in the standard Sessions surface (no sidebar badge), matching the
    // TTL-expiry default and the status-popup launch point.
    sessionManager.reserveOrigin(agentId, 'sessions')

    const tmuxAgent = await ensureTmuxAgent(agentId)
    if (tmuxAgent) {
      let result: { success: boolean; error?: string }
      if (tmuxAgent.justStarted) {
        const ready = await tmuxBridge.waitForAgentReady(tmuxAgent.windowName, UPGRADE_PROMPT_WAIT_MS)
        if (!ready) {
          logger.warn(
            { agentId, timeoutMs: UPGRADE_PROMPT_WAIT_MS, endpoint: '/api/version/start-upgrade' },
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
      logger.warn(
        { error: result.error },
        'Upgrade tmux send failed, falling back to ClaudeBridge',
      )
    }
    const processId = claudeBridge.startNewSession(message.trim(), agentId)
    return { via: 'claude-bridge', processId }
  }
}
