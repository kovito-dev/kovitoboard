/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Logic coverage for the ChatTimeline typing-indicator condition
 * (onboarding-scenarios.md §5.3.3 / BL-2026-294). The OR with
 * `awaitingFirstResponse` lights the indicator during the onboarding
 * first-session window where the watcher restores the new JSONL as
 * historical, leaving `status='idle'` until Kobi's first reply.
 */
import { describe, it, expect } from 'vitest'
import { shouldShowTypingIndicator } from '../../src/renderer/components/ChatTimeline'

describe('shouldShowTypingIndicator', () => {
  it('shows when sending', () => {
    expect(
      shouldShowTypingIndicator({ isSending: true, status: 'idle' }),
    ).toBe(true)
  })

  it('shows when status is thinking', () => {
    expect(
      shouldShowTypingIndicator({ isSending: false, status: 'thinking' }),
    ).toBe(true)
  })

  it('shows when status is waiting', () => {
    expect(
      shouldShowTypingIndicator({ isSending: false, status: 'waiting' }),
    ).toBe(true)
  })

  it('shows when awaitingFirstResponse even though status is idle and not sending', () => {
    // This is the BL-2026-294 case: the new onboarding session sits at
    // `idle` while the agent prepares its first reply.
    expect(
      shouldShowTypingIndicator({
        isSending: false,
        status: 'idle',
        awaitingFirstResponse: true,
      }),
    ).toBe(true)
  })

  it('hides when idle, not sending, and not awaiting (default)', () => {
    expect(
      shouldShowTypingIndicator({ isSending: false, status: 'idle' }),
    ).toBe(false)
    expect(
      shouldShowTypingIndicator({
        isSending: false,
        status: 'idle',
        awaitingFirstResponse: false,
      }),
    ).toBe(false)
  })

  it('hides when ready and not awaiting', () => {
    expect(
      shouldShowTypingIndicator({ isSending: false, status: 'ready' }),
    ).toBe(false)
  })
})
