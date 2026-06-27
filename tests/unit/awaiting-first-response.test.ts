/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Logic coverage for the onboarding S2 `awaitingFirstResponse` clear
 * predicate (onboarding-scenarios.md §5.3.3 / BL-2026-294).
 *
 * The state has three clear conditions: (i) an assistant/tool_use event
 * appears, (ii) status moves to thinking/ready, (iii) the T2 safety
 * timeout. The pure predicate covers (i) and (ii); (iii) is time-based
 * and lives in the component effect, asserted here only as a constant.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldClearAwaitingFirstResponse,
  AWAITING_FIRST_RESPONSE_TIMEOUT_MS,
} from '../../src/renderer/pages/SessionDetailPage'

describe('shouldClearAwaitingFirstResponse', () => {
  it('does not clear while only a user event exists at idle (S2 holds)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'user' }],
        status: 'idle',
      }),
    ).toBe(false)
  })

  it('clears when an assistant event has appeared (condition i)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'user' }, { type: 'assistant' }],
        status: 'idle',
      }),
    ).toBe(true)
  })

  it('clears when a tool_use event has appeared (condition i)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'user' }, { type: 'tool_use' }],
        status: 'idle',
      }),
    ).toBe(true)
  })

  it('clears when status is thinking (condition ii)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'user' }],
        status: 'thinking',
      }),
    ).toBe(true)
  })

  it('clears when status is ready (condition ii)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'user' }],
        status: 'ready',
      }),
    ).toBe(true)
  })

  it('does not clear for non-response events (system / progress / tool_result)', () => {
    expect(
      shouldClearAwaitingFirstResponse({
        events: [{ type: 'system' }, { type: 'progress' }, { type: 'tool_result' }],
        status: 'idle',
      }),
    ).toBe(false)
  })

  it('exposes a positive T2 safety timeout (condition iii)', () => {
    expect(AWAITING_FIRST_RESPONSE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
