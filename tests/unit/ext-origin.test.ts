/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Exact `chrome-extension://` origin parsing tests
 * (external-client-api.md v1.0 §7.1.1 / §9.6.1).
 *
 * Pins the evasion-resistant parse so a future refactor cannot relax
 * the extension-origin boundary. The id is a 32-char `[a-p]` value; a
 * valid id is reused across the cases below.
 */
import { describe, it, expect } from 'vitest'
import {
  parseExtensionOrigin,
  originMatchesAllowedExtension,
} from '../../src/server/middleware/ext-origin'

// 32 chars, all in the a–p range (canonical Chrome extension-id shape).
const VALID_ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'

describe('parseExtensionOrigin — accepts', () => {
  it('a bare chrome-extension://<id> origin', () => {
    expect(parseExtensionOrigin(`chrome-extension://${VALID_ID}`)).toBe(VALID_ID)
  })

  it('a chrome-extension://<id>/ origin (trailing slash is the empty path)', () => {
    expect(parseExtensionOrigin(`chrome-extension://${VALID_ID}/`)).toBe(VALID_ID)
  })

  it('an uppercase scheme (WHATWG canonicalises CHROME-EXTENSION: → chrome-extension:)', () => {
    expect(parseExtensionOrigin(`CHROME-EXTENSION://${VALID_ID}`)).toBe(VALID_ID)
  })
})

describe('parseExtensionOrigin — rejects (evasion vectors §9.6.1)', () => {
  const cases: Array<[string, string]> = [
    ['empty string', ''],
    ['undefined-like missing origin', undefined as unknown as string],
    ['a normal https web origin', 'https://evil.example'],
    ['http loopback origin', 'http://127.0.0.1:5173'],
    ['subdomain smuggling', `chrome-extension://${VALID_ID}.evil.example`],
    ['path smuggling', `chrome-extension://${VALID_ID}/path`],
    ['query smuggling', `chrome-extension://${VALID_ID}?x=1`],
    ['hash smuggling', `chrome-extension://${VALID_ID}#frag`],
    ['userinfo smuggling', `chrome-extension://user:pass@${VALID_ID}`],
    ['id too short', `chrome-extension://${VALID_ID.slice(0, 31)}`],
    ['id too long', `chrome-extension://${VALID_ID}q`],
    ['id with out-of-range char (q)', `chrome-extension://${VALID_ID.slice(0, 31)}q`],
    ['uppercase host (canonical hosts are lower-case)', `chrome-extension://${VALID_ID.toUpperCase()}`],
    ['trailing-dot host', `chrome-extension://${VALID_ID}.`],
    ['malformed url', 'chrome-extension://'],
    ['wrong scheme moz-extension', `moz-extension://${VALID_ID}`],
  ]

  for (const [name, origin] of cases) {
    it(`rejects ${name}`, () => {
      expect(parseExtensionOrigin(origin)).toBeNull()
    })
  }
})

describe('originMatchesAllowedExtension', () => {
  it('matches when id equals allowedExtensionId', () => {
    expect(originMatchesAllowedExtension(`chrome-extension://${VALID_ID}`, VALID_ID)).toBe(true)
  })

  it('does not match a different paired id', () => {
    expect(originMatchesAllowedExtension(`chrome-extension://${VALID_ID}`, OTHER_ID)).toBe(false)
  })

  it('never matches when unpaired (allowedExtensionId = null)', () => {
    expect(originMatchesAllowedExtension(`chrome-extension://${VALID_ID}`, null)).toBe(false)
  })

  it('does not match a smuggled subdomain even when the prefix id is paired', () => {
    expect(
      originMatchesAllowedExtension(`chrome-extension://${VALID_ID}.evil.example`, VALID_ID),
    ).toBe(false)
  })
})
