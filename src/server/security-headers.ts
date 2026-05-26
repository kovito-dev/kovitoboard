/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Security headers — single source of truth for the
 * Content-Security-Policy directive list and the joined header
 * value that the response middleware in `index.ts` emits.
 *
 * The list lives in its own module so the directives can be
 * exercised directly in unit tests without booting the HTTP
 * server, and so future header additions surface as a focused
 * diff against this file rather than a sprawling middleware
 * change.
 *
 * Threat model behind each directive:
 *
 *   - `default-src 'self'`        — every resource type that the
 *                                   more specific directives do
 *                                   not name falls back to same-
 *                                   origin only.
 *   - `connect-src 'self' ws://localhost:* ws://127.0.0.1:*`
 *                                  — XHR / fetch / WebSocket. The
 *                                   WS allow-list covers the
 *                                   per-launch supervisor URL
 *                                   shapes; tightened further at
 *                                   the WS layer by the launch-
 *                                   token + Origin guard.
 *   - `script-src 'self'`         — JS is loaded from the same
 *                                   origin only; no inline, no
 *                                   eval.
 *   - `style-src 'self' 'unsafe-inline'`
 *                                  — Tailwind injects inline
 *                                   styles at runtime; `'unsafe-
 *                                   inline'` is the documented
 *                                   minimum.
 *   - `img-src 'self' data: blob:` — same-origin images plus the
 *                                   `data:` and `blob:` URLs the
 *                                   renderer creates locally for
 *                                   uploaded artifacts.
 *   - `base-uri 'self'`            — v0.2.1. Refuses
 *                                   `<base href="https://attacker/">`
 *                                   hijack — the renderer never
 *                                   sets a custom base URL.
 *   - `object-src 'none'`          — v0.2.1. Blocks `<object>` /
 *                                   `<embed>` / `<applet>` legacy
 *                                   plugin surface (no first-
 *                                   party use; bypasses script-
 *                                   src otherwise).
 *   - `form-action 'self'`         — v0.2.1. Limits form
 *                                   submissions to the same
 *                                   origin. The renderer never
 *                                   POSTs cross-origin; defends
 *                                   against an injected `<form
 *                                   action="https://attacker/">`.
 *   - `frame-ancestors 'none'`     — v0.2.1. Denies embedding via
 *                                   any framing element.
 *                                   Equivalent to the existing
 *                                   `X-Frame-Options: DENY`
 *                                   header but preferred by
 *                                   modern browsers.
 *
 * @see docs/specs/http-api-contract.md (CSP clause, v0.2.1
 *      minor revision tracks the 4 added directives)
 */

/**
 * Ordered list of Content-Security-Policy directives. Order is
 * not semantically significant for browsers, but kept stable so
 * a future diff against this list reads cleanly.
 *
 * The array is `Object.freeze`-d so a runtime mutation attempt
 * (`(CSP_DIRECTIVES as string[]).push(...)`, accidental
 * `splice`, etc.) throws in strict mode rather than silently
 * weakening the policy for every subsequent response. The
 * `readonly` type annotation already catches the TypeScript
 * call sites; the freeze catches code paths that bypass the
 * type system (compiled JS, casts, dynamic imports).
 */
export const CSP_DIRECTIVES: readonly string[] = Object.freeze([
  "default-src 'self'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "script-src 'self'",
  // Tailwind injects inline styles at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
])

/**
 * Build the Content-Security-Policy header value as a single
 * `'; '`-joined string. Matches the shape browsers expect from
 * `Content-Security-Policy: <directive>; <directive>; ...`.
 */
export function buildCSPHeader(): string {
  return CSP_DIRECTIVES.join('; ')
}
