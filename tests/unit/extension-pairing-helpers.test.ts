/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the "Connect a Chrome extension" pairing UI helpers
 * (spec `chrome-extension-pairing-ui.md` v1.0 §9.1 / §9.3).
 *
 * Covers the defensive 200-response validation (§6.1) — non-32-hex code,
 * non-finite / non-positive ttlMs (NaN / Infinity), malformed body — and the
 * ttlMs-driven countdown formatting including the sub-second boundary.
 */
import { describe, expect, it } from 'vitest'
import { formatRemaining, parseIssueResponse } from '../../src/renderer/components/extensionPairingHelpers'

const VALID_CODE = '0123456789abcdef0123456789abcdef'

describe('parseIssueResponse (§6.1 defensive validation)', () => {
  it('accepts a valid body and anchors expiresAt to now + ttlMs', () => {
    const result = parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: 300_000 }, 1_000)
    expect(result).toEqual({ pairingCode: VALID_CODE, expiresAt: 301_000 })
  })

  it('rejects a non-32-hex pairingCode', () => {
    expect(parseIssueResponse({ pairingCode: 'abc', ttlMs: 300_000 })).toBeNull()
    expect(parseIssueResponse({ pairingCode: VALID_CODE.toUpperCase(), ttlMs: 300_000 })).toBeNull()
    expect(parseIssueResponse({ pairingCode: VALID_CODE + 'x', ttlMs: 300_000 })).toBeNull()
  })

  it('rejects a missing pairingCode', () => {
    expect(parseIssueResponse({ ttlMs: 300_000 })).toBeNull()
  })

  it('rejects NaN / Infinity ttlMs (must not pass typeof number)', () => {
    expect(parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: Number.NaN })).toBeNull()
    expect(parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('rejects non-positive or non-number ttlMs', () => {
    expect(parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: 0 })).toBeNull()
    expect(parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: -1 })).toBeNull()
    expect(parseIssueResponse({ pairingCode: VALID_CODE, ttlMs: '300000' })).toBeNull()
  })

  it('rejects a malformed (non-object) body', () => {
    expect(parseIssueResponse(null)).toBeNull()
    expect(parseIssueResponse('not json')).toBeNull()
    expect(parseIssueResponse(42)).toBeNull()
  })
})

describe('formatRemaining (§7.3 countdown, ceil so 00:01 shows)', () => {
  it('formats minutes:seconds with ceil', () => {
    expect(formatRemaining(300_000)).toBe('05:00')
    expect(formatRemaining(299_001)).toBe('05:00') // ceil keeps 05:00 just after issue
    expect(formatRemaining(59_000)).toBe('00:59')
  })

  it('keeps 00:01 for the final sub-second window', () => {
    expect(formatRemaining(1)).toBe('00:01')
    expect(formatRemaining(999)).toBe('00:01')
  })

  it('shows 00:00 at / past expiry and never goes negative', () => {
    expect(formatRemaining(0)).toBe('00:00')
    expect(formatRemaining(-5_000)).toBe('00:00')
  })
})
