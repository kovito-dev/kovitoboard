/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the capture-mount store (v0.2.0 / spec v1.7 §6.10.6.3).
 * Covers openMount, closeMount, getMount lazy cleanup, sweepExpired,
 * per-app + global quotas, and the lifecycle invariants used by the
 * route layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openMount,
  closeMount,
  getMount,
  sweepExpiredMounts,
  countMountsForApp,
  MAX_ACTIVE_MOUNTS_PER_APP,
  MAX_ACTIVE_MOUNTS_GLOBAL,
  MOUNT_TTL_MS,
  __resetForTests,
  __sizeForTests,
} from '../../src/server/recipe-capture-mount-sessions'

describe('recipe-capture-mount-sessions', () => {
  afterEach(() => {
    __resetForTests()
    vi.useRealTimers()
  })

  it('issues a 32-char lowercase-hex mountId bound to the appId', () => {
    const result = openMount('app-a')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mountId).toMatch(/^[0-9a-f]{32}$/)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
    expect(__sizeForTests()).toBe(1)
  })

  it('getMount returns the bound appId on a live hit', () => {
    const opened = openMount('app-a')
    if (!opened.ok) throw new Error('openMount failed')
    const result = getMount(opened.mountId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.appId).toBe('app-a')
    }
  })

  it('getMount returns reason=invalid for malformed mountId', () => {
    expect(getMount(undefined)).toEqual({ ok: false, reason: 'invalid' })
    expect(getMount('')).toEqual({ ok: false, reason: 'invalid' })
    expect(getMount('not-hex')).toEqual({ ok: false, reason: 'invalid' })
    expect(getMount('A'.repeat(32))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('getMount returns reason=invalid for unknown mountId', () => {
    expect(getMount('a'.repeat(32))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('getMount returns reason=expired past TTL and drops the entry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const opened = openMount('app-a')
    if (!opened.ok) throw new Error('openMount failed')
    vi.setSystemTime(new Date(Date.now() + MOUNT_TTL_MS + 1000))
    const result = getMount(opened.mountId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('expired')
    }
    expect(__sizeForTests()).toBe(0)
  })

  it('closeMount returns true on the first call, false on a double-close', () => {
    const opened = openMount('app-a')
    if (!opened.ok) throw new Error('openMount failed')
    expect(closeMount(opened.mountId)).toBe(true)
    expect(closeMount(opened.mountId)).toBe(false)
    expect(__sizeForTests()).toBe(0)
  })

  it('rejects malformed mountId on closeMount (returns false)', () => {
    expect(closeMount(undefined)).toBe(false)
    expect(closeMount('not-hex')).toBe(false)
  })

  it('per-app quota: refuses the 9th open for the same appId with PerAppQuotaExceeded', () => {
    for (let i = 0; i < MAX_ACTIVE_MOUNTS_PER_APP; i++) {
      expect(openMount('app-a').ok).toBe(true)
    }
    expect(countMountsForApp('app-a')).toBe(MAX_ACTIVE_MOUNTS_PER_APP)
    const overflow = openMount('app-a')
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) {
      expect(overflow.reason).toBe('PerAppQuotaExceeded')
    }
  })

  it('per-app quota does not block other apps', () => {
    for (let i = 0; i < MAX_ACTIVE_MOUNTS_PER_APP; i++) {
      expect(openMount('app-a').ok).toBe(true)
    }
    const otherApp = openMount('app-b')
    expect(otherApp.ok).toBe(true)
  })

  it('global cap: refuses with StoreFull at MAX_ACTIVE_MOUNTS_GLOBAL', () => {
    // Spread mounts across enough apps to stay under the per-app
    // cap while filling the global cap.
    const APPS_NEEDED = Math.ceil(MAX_ACTIVE_MOUNTS_GLOBAL / MAX_ACTIVE_MOUNTS_PER_APP)
    let opened = 0
    for (let a = 0; a < APPS_NEEDED && opened < MAX_ACTIVE_MOUNTS_GLOBAL; a++) {
      for (let i = 0; i < MAX_ACTIVE_MOUNTS_PER_APP && opened < MAX_ACTIVE_MOUNTS_GLOBAL; i++) {
        const r = openMount(`app-${a}`)
        expect(r.ok).toBe(true)
        opened += 1
      }
    }
    expect(__sizeForTests()).toBe(MAX_ACTIVE_MOUNTS_GLOBAL)
    // Use a fresh appId so we cannot trip the per-app cap first.
    const overflow = openMount('app-overflow')
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) {
      expect(overflow.reason).toBe('StoreFull')
    }
  })

  it('sweepExpiredMounts returns the count and drops the entries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    openMount('app-a')
    openMount('app-b')
    vi.setSystemTime(new Date(Date.now() + MOUNT_TTL_MS + 1000))
    expect(sweepExpiredMounts()).toBe(2)
    expect(__sizeForTests()).toBe(0)
  })

  it('countMountsForApp ignores other appIds', () => {
    openMount('app-a')
    openMount('app-a')
    openMount('app-b')
    expect(countMountsForApp('app-a')).toBe(2)
    expect(countMountsForApp('app-b')).toBe(1)
    expect(countMountsForApp('app-c')).toBe(0)
  })
})
