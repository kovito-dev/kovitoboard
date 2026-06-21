/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Pairing store tests (external-client-api.md v1.0 §7.2 / §9.2).
 *
 * Pins: single-use codes, TTL expiry, mismatch handling, single-slot
 * overwrite, and the unpaired default. The clock is injected so TTL
 * behaviour is deterministic.
 */
import { describe, it, expect } from 'vitest'
import { PairingStore, PAIRING_CODE_TTL_MS } from '../../src/server/ext-client/pairing-store'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function makeStore(startTime = 1_000_000) {
  let t = startTime
  const store = new PairingStore({ now: () => t })
  return { store, advance: (ms: number) => (t += ms) }
}

describe('PairingStore', () => {
  it('starts unpaired', () => {
    const { store } = makeStore()
    expect(store.getAllowedExtensionId()).toBeNull()
  })

  it('rejects /pair when no code has been issued', () => {
    const { store } = makeStore()
    const r = store.tryPair('whatever', EXT_ID)
    expect(r).toEqual({ ok: false, reason: 'no-active-pairing' })
    expect(store.getAllowedExtensionId()).toBeNull()
  })

  it('pairs on the correct code and confirms the extension id', () => {
    const { store } = makeStore()
    const code = store.issuePairingCode()
    const r = store.tryPair(code, EXT_ID)
    expect(r).toEqual({ ok: true, extensionId: EXT_ID })
    expect(store.getAllowedExtensionId()).toBe(EXT_ID)
  })

  it('rejects a wrong code without pairing', () => {
    const { store } = makeStore()
    store.issuePairingCode()
    const r = store.tryPair('00000000000000000000000000000000', EXT_ID)
    expect(r).toEqual({ ok: false, reason: 'mismatch' })
    expect(store.getAllowedExtensionId()).toBeNull()
  })

  it('is single-use: a consumed code cannot be reused', () => {
    const { store } = makeStore()
    const code = store.issuePairingCode()
    expect(store.tryPair(code, EXT_ID).ok).toBe(true)
    const second = store.tryPair(code, EXT_ID)
    expect(second).toEqual({ ok: false, reason: 'no-active-pairing' })
  })

  it('expires a code after the TTL', () => {
    const { store, advance } = makeStore()
    const code = store.issuePairingCode()
    advance(PAIRING_CODE_TTL_MS + 1)
    const r = store.tryPair(code, EXT_ID)
    expect(r).toEqual({ ok: false, reason: 'expired' })
    expect(store.getAllowedExtensionId()).toBeNull()
  })

  it('accepts a code at the very edge before the TTL', () => {
    const { store, advance } = makeStore()
    const code = store.issuePairingCode()
    advance(PAIRING_CODE_TTL_MS - 1)
    expect(store.tryPair(code, EXT_ID).ok).toBe(true)
  })

  it('issuing a new code overwrites the previous pending code', () => {
    const { store } = makeStore()
    const first = store.issuePairingCode()
    store.issuePairingCode()
    expect(store.tryPair(first, EXT_ID)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('re-pairing overwrites the single allowedExtensionId slot', () => {
    const { store } = makeStore()
    const c1 = store.issuePairingCode()
    store.tryPair(c1, EXT_ID)
    const c2 = store.issuePairingCode()
    store.tryPair(c2, OTHER_EXT_ID)
    expect(store.getAllowedExtensionId()).toBe(OTHER_EXT_ID)
  })

  it('reset drops both the paired id and any pending code', () => {
    const { store } = makeStore()
    const c = store.issuePairingCode()
    store.tryPair(c, EXT_ID)
    store.issuePairingCode()
    store.reset()
    expect(store.getAllowedExtensionId()).toBeNull()
    expect(store.tryPair(store.issuePairingCode(), EXT_ID).ok).toBe(true)
  })
})
