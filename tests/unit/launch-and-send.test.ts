/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit coverage for the background launch-and-send routine extracted
 * from `handleNewSession`'s justStarted branch (session-management.md
 * §7.1.5 / onboarding-scenarios.md §5.3.2 / BL-2026-293).
 *
 * The HTTP handler dispatches this fire-and-forget (`void ...`) and
 * responds immediately (accept semantics). These tests pin the
 * invariants that make that safe:
 *   - wait → send ordering is preserved
 *   - send is dispatched asynchronously (not before the wait resolves),
 *     so the caller can respond before the work completes
 *   - a prompt-wait timeout still sends, with a warn
 *   - a send failure / thrown error is logged and swallowed (no
 *     unhandled rejection)
 */
import { describe, it, expect, vi } from 'vitest'
import {
  launchAndSendFirstMessage,
  type LaunchSendBridge,
  type LaunchSendLogger,
} from '../../src/server/launch-and-send'

function makeLogger(): LaunchSendLogger & {
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  return { warn: vi.fn(), error: vi.fn() }
}

describe('launchAndSendFirstMessage', () => {
  it('waits for the prompt before sending (ordering preserved)', async () => {
    const calls: string[] = []
    const bridge: LaunchSendBridge = {
      waitForAgentReady: async () => {
        calls.push('wait')
        return true
      },
      sendMessage: async () => {
        calls.push('send')
        return { success: true }
      },
    }
    await launchAndSendFirstMessage(bridge, 'win', 'hi', makeLogger())
    expect(calls).toEqual(['wait', 'send'])
  })

  it('does not send before the prompt wait resolves (fire-and-forget safe)', async () => {
    let resolveWait: (ready: boolean) => void = () => {}
    const sendMessage = vi.fn(async () => ({ success: true }))
    const bridge: LaunchSendBridge = {
      waitForAgentReady: () =>
        new Promise<boolean>((resolve) => {
          resolveWait = resolve
        }),
      sendMessage,
    }

    const pending = launchAndSendFirstMessage(bridge, 'win', 'hi', makeLogger())
    // Caller can return here while the routine is still pending.
    await Promise.resolve()
    expect(sendMessage).not.toHaveBeenCalled()

    resolveWait(true)
    await pending
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('still sends after a prompt-wait timeout, and warns', async () => {
    const sendMessage = vi.fn(async () => ({ success: true }))
    const logger = makeLogger()
    const bridge: LaunchSendBridge = {
      waitForAgentReady: async () => false,
      sendMessage,
    }
    await launchAndSendFirstMessage(bridge, 'win', 'hi', logger, {
      agentId: 'kovito-concierge',
    })
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs (and swallows) a send failure without throwing', async () => {
    const logger = makeLogger()
    const bridge: LaunchSendBridge = {
      waitForAgentReady: async () => true,
      sendMessage: async () => ({ success: false, error: 'no window' }),
    }
    await expect(
      launchAndSendFirstMessage(bridge, 'win', 'hi', logger),
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('logs (and swallows) a thrown error without rejecting', async () => {
    const logger = makeLogger()
    const bridge: LaunchSendBridge = {
      waitForAgentReady: async () => {
        throw new Error('tmux gone')
      },
      sendMessage: async () => ({ success: true }),
    }
    await expect(
      launchAndSendFirstMessage(bridge, 'win', 'hi', logger),
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledOnce()
  })
})
