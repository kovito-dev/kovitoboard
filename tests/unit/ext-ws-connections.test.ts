/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * ExtWsConnections tests (external-client-api.md v1.0 §7.5 / §7.3.1).
 *
 * Pins the per-connection subscription tracking + classification used
 * by the broadcast filter: extension connections deliver only to their
 * subscription set, renderer connections are never filtered, and
 * subscription state is torn down on unregister.
 *
 * `WebSocket` is faked with a minimal stub — the registry only uses it
 * as a map key + (in `index.ts`) for `send`/`readyState`, neither of
 * which this class touches.
 */
import { describe, it, expect } from 'vitest'
import type { WebSocket } from 'ws'
import { ExtWsConnections } from '../../src/server/ext-client/ws-ext'

function fakeWs(): WebSocket {
  return {} as unknown as WebSocket
}

describe('ExtWsConnections', () => {
  it('classifies and reports extension vs renderer connections', () => {
    const conns = new ExtWsConnections()
    const ext = fakeWs()
    const ren = fakeWs()
    conns.register(ext, 'extension')
    conns.register(ren, 'renderer')
    expect(conns.isExtension(ext)).toBe(true)
    expect(conns.isExtension(ren)).toBe(false)
  })

  it('assigns distinct connection ids', () => {
    const conns = new ExtWsConnections()
    const a = conns.register(fakeWs(), 'extension')
    const b = conns.register(fakeWs(), 'extension')
    expect(a).not.toBe(b)
  })

  it('tracks per-connection subscriptions independently', () => {
    const conns = new ExtWsConnections()
    const e1 = fakeWs()
    const e2 = fakeWs()
    conns.register(e1, 'extension')
    conns.register(e2, 'extension')
    conns.subscribe(e1, 'sess-1')
    expect(conns.isSubscribed(e1, 'sess-1')).toBe(true)
    expect(conns.isSubscribed(e2, 'sess-1')).toBe(false)
  })

  it('subscribe is idempotent', () => {
    const conns = new ExtWsConnections()
    const e = fakeWs()
    conns.register(e, 'extension')
    conns.subscribe(e, 'sess-1')
    conns.subscribe(e, 'sess-1')
    expect(conns.isSubscribed(e, 'sess-1')).toBe(true)
  })

  it('auto-subscribes by connId (used by new_session correlation)', () => {
    const conns = new ExtWsConnections()
    const e = fakeWs()
    const connId = conns.register(e, 'extension')
    conns.subscribeByConnId(connId, 'sess-9')
    expect(conns.isSubscribed(e, 'sess-9')).toBe(true)
    expect(conns.socketByConnId(connId)).toBe(e)
  })

  it('lists all live extension sockets (for HTTP-new echo)', () => {
    const conns = new ExtWsConnections()
    const e1 = fakeWs()
    const e2 = fakeWs()
    conns.register(e1, 'extension')
    conns.register(e2, 'extension')
    conns.register(fakeWs(), 'renderer')
    expect(conns.extensionSockets()).toHaveLength(2)
  })

  it('tears down subscription + index state on unregister', () => {
    const conns = new ExtWsConnections()
    const e = fakeWs()
    const connId = conns.register(e, 'extension')
    conns.subscribe(e, 'sess-1')
    conns.unregister(e)
    expect(conns.isExtension(e)).toBe(false)
    expect(conns.isSubscribed(e, 'sess-1')).toBe(false)
    expect(conns.socketByConnId(connId)).toBeUndefined()
    expect(conns.extensionSockets()).toHaveLength(0)
  })
})
