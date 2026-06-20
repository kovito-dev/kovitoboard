/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { WebSocket } from 'ws'
import type { ParsedEvent } from '../types'

/**
 * Catch-up replay for a freshly auto-subscribed extension socket
 * (external-client-api.md §7.5).
 *
 * A single `addEvents` batch emits all `new_event`s BEFORE the terminal
 * `new_session`, but an extension only auto-subscribes during
 * `new_session` correlation — AFTER those `new_event`s have already been
 * broadcast. The session's opening line(s) are therefore emitted while
 * the connection is not yet subscribed, so the broadcast filter drops
 * them, and Phase 0 (no transcript fetch) cannot recover them.
 *
 * This replays the already-recorded events of the owned session to the
 * freshly subscribed socket only, using the SAME `new_event` wire shape
 * as the broadcast path. The caller is responsible for the ownership
 * boundary (owned-confirmed session, this origin connection only;
 * INV-ORIGIN-1) — this function performs no filtering of its own and
 * never touches the renderer fan-out.
 *
 * No-op when the socket is not OPEN or there are no recorded events.
 */
export function replayCatchUpEvents(
  ws: WebSocket,
  sessionId: string,
  events: readonly ParsedEvent[],
): void {
  if (ws.readyState !== ws.OPEN) return
  for (const event of events) {
    ws.send(JSON.stringify({ type: 'new_event', payload: { sessionId, event } }))
  }
}
