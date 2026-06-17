/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * BL-2026-269: the upgrade session-start flow
 * (`POST /api/version/start-upgrade` → `startUpgradeSession`) must park
 * an origin reservation right before `ensureTmuxAgent`, exactly like the
 * other agent-bound HTTP paths. Without it the `/clear`-spawned session
 * has no `agent-setting` marker and nothing to claim, so the UI falls
 * back to the "Default" agent label (spec session-management.md v1.9
 * §7.4.1).
 *
 * These tests pin the reservation call + both `justStarted` branches so
 * a future refactor cannot regress the binding. Following the BL-256
 * lesson, `reserveOrigin` is spied on a real-enough stub (not swallowed
 * by an empty SessionManager stub) so the call is actually asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStartUpgradeSession } from '../../src/server/upgrade-session'

const AGENT_ID = 'kovito-concierge'
// Deliberately distinct from AGENT_ID so the assertions prove production
// forwards `tmuxAgent.windowName` (not `agentId`) to the tmux methods.
const WINDOW_NAME = 'kovito-concierge-window-7'
const MESSAGE = '  please upgrade  '

function makeDeps() {
  const reserveOrigin = vi.fn()
  const ensureTmuxAgent = vi.fn()
  const waitForAgentReady = vi.fn().mockResolvedValue(true)
  const sendMessage = vi.fn().mockResolvedValue({ success: true })
  const clearAndSendMessage = vi.fn().mockResolvedValue({ success: true })
  const startNewSession = vi.fn().mockReturnValue('proc-1')
  const warn = vi.fn()

  const start = createStartUpgradeSession({
    sessionManager: { reserveOrigin },
    ensureTmuxAgent,
    tmuxBridge: { waitForAgentReady, sendMessage, clearAndSendMessage },
    claudeBridge: { startNewSession },
    logger: { warn },
  })

  return {
    start,
    reserveOrigin,
    ensureTmuxAgent,
    waitForAgentReady,
    sendMessage,
    clearAndSendMessage,
    startNewSession,
    warn,
  }
}

describe('createStartUpgradeSession (BL-2026-269)', () => {
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    deps = makeDeps()
  })

  it('reserves origin "sessions" exactly once before ensureTmuxAgent (justStarted=false)', async () => {
    // Existing window path (the BL scenario): clear-and-send reuses a
    // running agent window, so the new /clear session must be claimed
    // via the parked reservation.
    deps.ensureTmuxAgent.mockResolvedValue({ windowName: WINDOW_NAME, justStarted: false })

    const result = await deps.start({ agentId: AGENT_ID, message: MESSAGE })

    expect(deps.reserveOrigin).toHaveBeenCalledTimes(1)
    expect(deps.reserveOrigin).toHaveBeenCalledWith(AGENT_ID, 'sessions')
    // Reservation is parked BEFORE the agent is ensured.
    expect(deps.reserveOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      deps.ensureTmuxAgent.mock.invocationCallOrder[0],
    )
    // Existing-window branch trims the message, targets the resolved
    // window name (not the agentId), and uses clear-and-send.
    expect(deps.clearAndSendMessage).toHaveBeenCalledWith(WINDOW_NAME, 'please upgrade')
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(result).toEqual({ via: 'tmux', windowName: WINDOW_NAME })
  })

  it('reserves origin "sessions" before ensureTmuxAgent (justStarted=true)', async () => {
    // Freshly started window: wait for the prompt, then send (no /clear).
    deps.ensureTmuxAgent.mockResolvedValue({ windowName: WINDOW_NAME, justStarted: true })

    const result = await deps.start({ agentId: AGENT_ID, message: MESSAGE })

    expect(deps.reserveOrigin).toHaveBeenCalledTimes(1)
    expect(deps.reserveOrigin).toHaveBeenCalledWith(AGENT_ID, 'sessions')
    expect(deps.reserveOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      deps.ensureTmuxAgent.mock.invocationCallOrder[0],
    )
    // Both the readiness wait and the send target the resolved window
    // name (not the agentId).
    expect(deps.waitForAgentReady).toHaveBeenCalledWith(WINDOW_NAME, 45000)
    expect(deps.sendMessage).toHaveBeenCalledWith(WINDOW_NAME, 'please upgrade')
    expect(deps.clearAndSendMessage).not.toHaveBeenCalled()
    expect(result).toEqual({ via: 'tmux', windowName: WINDOW_NAME })
  })

  it('still reserves origin when tmux is unavailable and falls back to ClaudeBridge', async () => {
    // The reservation must be parked regardless of which launch path
    // ultimately resolves the session.
    deps.ensureTmuxAgent.mockResolvedValue(null)

    const result = await deps.start({ agentId: AGENT_ID, message: MESSAGE })

    expect(deps.reserveOrigin).toHaveBeenCalledTimes(1)
    expect(deps.reserveOrigin).toHaveBeenCalledWith(AGENT_ID, 'sessions')
    expect(deps.startNewSession).toHaveBeenCalledWith('please upgrade', AGENT_ID)
    expect(result).toEqual({ via: 'claude-bridge', processId: 'proc-1' })
  })

  it('falls back to ClaudeBridge when the tmux send fails', async () => {
    deps.ensureTmuxAgent.mockResolvedValue({ windowName: WINDOW_NAME, justStarted: false })
    deps.clearAndSendMessage.mockResolvedValue({ success: false, error: 'send boom' })

    const result = await deps.start({ agentId: AGENT_ID, message: MESSAGE })

    expect(deps.reserveOrigin).toHaveBeenCalledWith(AGENT_ID, 'sessions')
    expect(deps.clearAndSendMessage).toHaveBeenCalledWith(WINDOW_NAME, 'please upgrade')
    // The ClaudeBridge fallback is keyed by agentId, not the window name.
    expect(deps.startNewSession).toHaveBeenCalledWith('please upgrade', AGENT_ID)
    expect(result).toEqual({ via: 'claude-bridge', processId: 'proc-1' })
  })
})
