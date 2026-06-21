/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Catch-up replay tests (external-client-api.md §7.5).
 *
 * Pins the fix for the subscribe-after-new_session ordering gap: a
 * single `addEvents` batch broadcasts every `new_event` BEFORE the
 * terminal `new_session`, but an extension only auto-subscribes during
 * `new_session` correlation. The opening line(s) of the session are
 * therefore broadcast while the connection is not yet subscribed and the
 * broadcast filter drops them. `replayCatchUpEvents` re-delivers those
 * already-recorded events to the freshly subscribed socket, using the
 * same `new_event` wire shape as the broadcast path.
 */
import { describe, it, expect } from 'vitest'
import { WebSocket } from 'ws'
import type { ParsedEvent } from '../../src/server/types'
import { replayCatchUpEvents } from '../../src/server/ext-client/catch-up-replay'

function evt(type: ParsedEvent['type'], content: string): ParsedEvent {
  return { type, content, timestamp: '2026-06-20T00:00:00.000Z' } as ParsedEvent
}

interface RecordingWs {
  readyState: number
  readonly OPEN: number
  sent: string[]
  send(msg: string): void
}

function recordingWs(readyState: number = WebSocket.OPEN): RecordingWs {
  return {
    readyState,
    OPEN: WebSocket.OPEN,
    sent: [],
    send(msg: string) {
      this.sent.push(msg)
    },
  }
}

describe('replayCatchUpEvents (§7.5 catch-up)', () => {
  it('replays recorded events to the freshly subscribed socket in order, same new_event wire shape', () => {
    const ws = recordingWs()
    const events = [evt('user', 'opening line 1'), evt('assistant', 'reply 1')]

    replayCatchUpEvents(ws as unknown as WebSocket, 'sess-1', events)

    expect(ws.sent).toHaveLength(2)
    const frames = ws.sent.map((m) => JSON.parse(m))
    // Same wire shape as the broadcast path: { type: 'new_event',
    // payload: { sessionId, event } }, and ORDER is preserved so the
    // ext client reconstructs the transcript opening correctly.
    expect(frames[0]).toEqual({
      type: 'new_event',
      payload: { sessionId: 'sess-1', event: events[0] },
    })
    expect(frames[1]).toEqual({
      type: 'new_event',
      payload: { sessionId: 'sess-1', event: events[1] },
    })
  })

  it('delivers the very first opening event that the broadcast filter would have dropped pre-subscribe', () => {
    // This is the core regression: without catch-up the subscriber would
    // never see the session's first line because it was broadcast before
    // the subscription existed. Replay must include index 0.
    const ws = recordingWs()
    const opening = evt('user', 'the first line of the session')

    replayCatchUpEvents(ws as unknown as WebSocket, 'sess-2', [opening])

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: 'new_event',
      payload: { sessionId: 'sess-2', event: opening },
    })
  })

  it('is a no-op for an empty event list', () => {
    const ws = recordingWs()
    replayCatchUpEvents(ws as unknown as WebSocket, 'sess-3', [])
    expect(ws.sent).toHaveLength(0)
  })

  it('does not send when the socket is not OPEN (renderer fan-out / dead socket untouched)', () => {
    const ws = recordingWs(WebSocket.CLOSING)
    replayCatchUpEvents(ws as unknown as WebSocket, 'sess-4', [evt('user', 'x')])
    expect(ws.sent).toHaveLength(0)
  })
})
