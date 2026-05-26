/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Integration tests for the Content-Security-Policy directive
 * list added in v0.2.1.
 *
 * The CSP middleware in `index.ts` cannot be imported in
 * isolation (it lives inside the server bootstrap closure), so
 * the SUT here is the `security-headers` helper that owns the
 * directive list and the joined header value. The middleware
 * delegates to `buildCSPHeader()`, so locking in the helper's
 * shape locks in the middleware's emitted header.
 *
 * Coverage:
 *
 *   1. The 4 v0.2.1 directives are present:
 *      `base-uri 'self'`, `object-src 'none'`,
 *      `form-action 'self'`, `frame-ancestors 'none'`.
 *   2. The pre-existing directives stay intact (regression).
 *   3. `buildCSPHeader()` produces a well-formed
 *      `'; '`-separated header value.
 *   4. The directive list is read-only at the type level so a
 *      future caller cannot mutate the singleton.
 */
import { describe, it, expect } from 'vitest'
import {
  CSP_DIRECTIVES,
  buildCSPHeader,
} from '../../src/server/security-headers'

describe('CSP — v0.2.1 hardening directives present', () => {
  it("includes `base-uri 'self'`", () => {
    expect(CSP_DIRECTIVES).toContain("base-uri 'self'")
  })

  it("includes `object-src 'none'`", () => {
    expect(CSP_DIRECTIVES).toContain("object-src 'none'")
  })

  it("includes `form-action 'self'`", () => {
    expect(CSP_DIRECTIVES).toContain("form-action 'self'")
  })

  it("includes `frame-ancestors 'none'`", () => {
    expect(CSP_DIRECTIVES).toContain("frame-ancestors 'none'")
  })
})

describe('CSP — pre-existing directives preserved (regression)', () => {
  it("keeps `default-src 'self'`", () => {
    expect(CSP_DIRECTIVES).toContain("default-src 'self'")
  })

  it('keeps `connect-src` allowing same-origin and the local WebSocket forms', () => {
    expect(CSP_DIRECTIVES).toContain(
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
    )
  })

  it("keeps `script-src 'self'` (no inline / no eval)", () => {
    expect(CSP_DIRECTIVES).toContain("script-src 'self'")
  })

  it("keeps `style-src 'self' 'unsafe-inline'` for Tailwind", () => {
    expect(CSP_DIRECTIVES).toContain("style-src 'self' 'unsafe-inline'")
  })

  it("keeps `img-src 'self' data: blob:`", () => {
    expect(CSP_DIRECTIVES).toContain("img-src 'self' data: blob:")
  })
})

describe('CSP — header serialization', () => {
  it('joins all directives with `; ` exactly once between each pair', () => {
    const header = buildCSPHeader()
    // Sanity: the assembled header contains each directive in
    // order, separated by `; ` (no leading / trailing
    // whitespace).
    expect(header).toBe(CSP_DIRECTIVES.join('; '))
    expect(header.startsWith(';')).toBe(false)
    expect(header.endsWith(';')).toBe(false)
    expect(header).not.toContain(';;')
  })

  it('emits exactly 9 directives for v0.2.1 (5 pre-existing + 4 new)', () => {
    // Lock the directive count so a stealth removal of any
    // existing rule, or an accidental duplicate, is caught.
    expect(CSP_DIRECTIVES.length).toBe(9)
  })

  it('is frozen at runtime so a cast cannot mutate the directive list', () => {
    // The TypeScript `readonly` only protects type-checked call
    // sites — a `(CSP_DIRECTIVES as string[]).push(...)` cast
    // would slip through and silently weaken the CSP for every
    // subsequent response in this process. The SUT calls
    // `Object.freeze` so the cast throws in strict mode instead.
    expect(Object.isFrozen(CSP_DIRECTIVES)).toBe(true)

    expect(() => {
      ;(CSP_DIRECTIVES as string[]).push("script-src 'unsafe-eval'")
    }).toThrow(TypeError)
    expect(() => {
      ;(CSP_DIRECTIVES as string[]).splice(0, 1)
    }).toThrow(TypeError)
    expect(() => {
      ;(CSP_DIRECTIVES as { [i: number]: string })[0] = "script-src 'unsafe-eval'"
    }).toThrow(TypeError)
    // Sanity: the array still has the expected count after the
    // attempted mutations were all refused.
    expect(CSP_DIRECTIVES.length).toBe(9)
  })
})
