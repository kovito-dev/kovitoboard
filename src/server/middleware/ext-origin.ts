/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Exact `chrome-extension://` Origin parsing for the external-client API
 * (external-client-api.md v1.0 §7.1.1).
 *
 * The naive "starts with `chrome-extension://`" check is not enough: a
 * value like `chrome-extension://<id>.evil.example/path` would slip
 * past a prefix match. Every entry point that has to validate an
 * extension origin — the HTTP guard, the `/pair` handler, the `/token`
 * handler, the WS `verifyClient`, and the `connection` re-evaluation —
 * must run this single canonical algorithm so they cannot drift apart.
 *
 * The algorithm (normative §7.1.1):
 *
 *   1. Parse the Origin with `new URL(...)`; a throw (malformed URL)
 *      means no match.
 *   2. `protocol` must be exactly `chrome-extension:`.
 *   3. `username` / `password` empty, `pathname` empty or `/`,
 *      `search` / `hash` empty — reject path / query / auth smuggling.
 *   4. `hostname` (the extension id) must match `^[a-p]{32}$`, the
 *      Chrome extension-id shape.
 *
 * The extracted id is a PUBLIC value (it appears in the store URL), so
 * exact-match comparison against `allowedExtensionId` is a plain string
 * `===`; no constant-time compare is needed (unlike the launch token).
 *
 * This module intentionally does NOT import or touch `auth.ts`'s
 * `originAllowed()` / `buildAllowedOriginSet()`: the existing
 * loopback-only boundary for `/api/*` must stay byte-for-byte unchanged
 * (INV-ORIGIN-1).
 */

/** Chrome extension-id shape: 32 chars in the range a–p. */
const EXTENSION_ID_RE = /^[a-p]{32}$/

/**
 * Parse an `Origin` header value and, if it is a well-formed
 * `chrome-extension://<id>` origin with no path / query / hash / auth,
 * return the extension id. Returns `null` for anything else.
 *
 * Note on case: the WHATWG URL parser lower-cases the scheme, so an
 * `CHROME-EXTENSION://` input canonicalises to `chrome-extension:` and
 * is accepted at step 2. The hostname is likewise canonicalised; an
 * uppercase or trailing-dot host therefore fails the `[a-p]{32}` test
 * (canonical hosts are lower-case and have no trailing dot), which is
 * the conservative outcome we want.
 */
export function parseExtensionOrigin(origin: string | undefined | null): string | null {
  if (typeof origin !== 'string' || origin.length === 0) return null

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }

  if (url.protocol !== 'chrome-extension:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  if (url.search !== '' || url.hash !== '') return null

  const id = url.hostname
  if (!EXTENSION_ID_RE.test(id)) return null
  return id
}

/**
 * Two-step origin check (§7.1 step 2): the origin must be a valid
 * `chrome-extension://` origin (step 2a) AND its id must equal the
 * paired `allowedExtensionId` (step 2b). `allowedExtensionId` of `null`
 * (unpaired) always fails — callers that need the §7.1 step 1 "not
 * paired" distinction should check `allowedExtensionId === null`
 * separately for the dedicated 403 message.
 */
export function originMatchesAllowedExtension(
  origin: string | undefined | null,
  allowedExtensionId: string | null,
): boolean {
  if (allowedExtensionId === null) return false
  const id = parseExtensionOrigin(origin)
  return id !== null && id === allowedExtensionId
}

/** Test seam: expose the id regex for unit tests. */
export const __testing = {
  EXTENSION_ID_RE,
}
