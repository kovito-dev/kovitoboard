/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Pairing store tests (external-client-api.md v1.0 §7.2 / §9.2 + v1.7
 * §7.2.4 / (c1) refresh secret).
 *
 * Pins: single-use codes, TTL expiry, mismatch handling, single-slot
 * overwrite, the unpaired default, and the per-pairing refresh secret
 * (mint on pairing, replace on re-pairing, drop on reset, two-factor
 * verify). The clock and the secret minter are injected so behaviour is
 * deterministic.
 */
import { describe, it, expect } from 'vitest'
import { PairingStore, PAIRING_CODE_TTL_MS } from '../../src/server/ext-client/pairing-store'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'

// A deterministic secret minter that yields a new value on each call so
// re-pairing tests can assert the slot was replaced.
function makeStore(startTime = 1_000_000) {
  let t = startTime
  let n = 0
  const store = new PairingStore({
    now: () => t,
    mintSecret: () => `secret-${++n}`.padEnd(32, '0'),
  })
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

  it('pairs on the correct code, confirms the id, and mints a refresh secret', () => {
    const { store } = makeStore()
    const code = store.issuePairingCode()
    const r = store.tryPair(code, EXT_ID)
    expect(r).toEqual({ ok: true, extensionId: EXT_ID, refreshSecret: 'secret-1'.padEnd(32, '0') })
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

  it('verifies the minted refresh secret (timing-safe second factor, §7.2.4)', () => {
    const { store } = makeStore()
    const r = store.tryPair(store.issuePairingCode(), EXT_ID)
    expect(r.ok).toBe(true)
    const secret = (r as { ok: true; refreshSecret: string }).refreshSecret
    expect(store.verifyRefreshSecret(secret)).toBe(true)
    expect(store.verifyRefreshSecret('wrong'.padEnd(32, '0'))).toBe(false)
    // Non-string / missing presented values are refused, not thrown.
    expect(store.verifyRefreshSecret(undefined)).toBe(false)
    expect(store.verifyRefreshSecret(123)).toBe(false)
  })

  it('verifyRefreshSecret is false while unpaired (no secret minted yet)', () => {
    const { store } = makeStore()
    expect(store.verifyRefreshSecret('anything'.padEnd(32, '0'))).toBe(false)
  })

  it('re-pairing replaces the refresh secret and invalidates the old one (§7.2.1)', () => {
    const { store } = makeStore()
    const r1 = store.tryPair(store.issuePairingCode(), EXT_ID)
    const oldSecret = (r1 as { ok: true; refreshSecret: string }).refreshSecret
    const r2 = store.tryPair(store.issuePairingCode(), OTHER_EXT_ID)
    const newSecret = (r2 as { ok: true; refreshSecret: string }).refreshSecret
    expect(newSecret).not.toBe(oldSecret)
    // The old secret must no longer verify; only the new one does.
    expect(store.verifyRefreshSecret(oldSecret)).toBe(false)
    expect(store.verifyRefreshSecret(newSecret)).toBe(true)
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

  it('reset drops the paired id, the refresh secret, and any pending code', () => {
    const { store } = makeStore()
    const c = store.issuePairingCode()
    const r = store.tryPair(c, EXT_ID)
    const secret = (r as { ok: true; refreshSecret: string }).refreshSecret
    store.issuePairingCode()
    store.reset()
    expect(store.getAllowedExtensionId()).toBeNull()
    expect(store.verifyRefreshSecret(secret)).toBe(false)
    expect(store.tryPair(store.issuePairingCode(), EXT_ID).ok).toBe(true)
  })
})
