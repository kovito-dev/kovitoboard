/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { TmuxSendResult } from './tmux-bridge'

/**
 * Minimal tmux surface the background launch-and-send routine needs.
 * Declared structurally (rather than depending on the concrete
 * `TmuxBridge`) so unit tests can inject a fake bridge without
 * constructing a real one.
 */
export interface LaunchSendBridge {
  waitForAgentReady(windowName: string, timeoutMs: number): Promise<boolean>
  sendMessage(windowName: string, message: string): Promise<TmuxSendResult>
}

/**
 * Minimal logger surface (matches pino's `warn` / `error` signatures
 * for object-first structured logging).
 */
export interface LaunchSendLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface LaunchAndSendOptions {
  agentId?: string
  endpoint?: string
  timeoutMs?: number
}

/**
 * Default prompt-wait budget. Claude Code fetches org / credential info
 * on first launch, so the live prompt can take 15+ s to appear.
 */
export const DEFAULT_AGENT_READY_TIMEOUT_MS = 45000

/**
 * Wait for a just-started agent's prompt to become ready, then send the
 * first message.
 *
 * Ordering (wait → send) is preserved. A prompt-wait timeout is logged
 * but does NOT skip the send — Claude Code may still accept input once
 * the welcome screen clears. Any failure is logged and swallowed so the
 * caller can run this fire-and-forget via `void` without risking an
 * unhandled promise rejection.
 *
 * Extracted from `handleNewSession`'s `justStarted` branch so the
 * accept-semantics async path (session-management.md §7.1.5,
 * BL-2026-293) can be unit-tested without booting the server. The HTTP
 * handler responds immediately and dispatches this routine in the
 * background; see `onboarding-scenarios.md` §5.3.2.
 */
export async function launchAndSendFirstMessage(
  bridge: LaunchSendBridge,
  windowName: string,
  message: string,
  logger: LaunchSendLogger,
  options: LaunchAndSendOptions = {},
): Promise<void> {
  const { agentId, endpoint, timeoutMs = DEFAULT_AGENT_READY_TIMEOUT_MS } = options
  try {
    const ready = await bridge.waitForAgentReady(windowName, timeoutMs)
    if (!ready) {
      logger.warn(
        { agentId, timeoutMs, endpoint },
        'Prompt wait timeout for agent (background send continues)',
      )
    }
    const result = await bridge.sendMessage(windowName, message)
    if (!result.success) {
      logger.error(
        { agentId, windowName, error: result.error },
        'Background first-message send failed for just-started agent',
      )
    }
  } catch (err) {
    logger.error(
      { err, agentId, windowName },
      'Background first-message send threw for just-started agent',
    )
  }
}
