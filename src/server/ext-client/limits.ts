/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Shared validation limits for the external-client API
 * (external-client-api.md §8.4 hardening).
 *
 * This is the single source of truth for the external-client id-field
 * cap so the HTTP path (`ext-router.ts`) and the WS path (`index.ts`)
 * cannot drift: the spec requires HTTP/WS validation parity, and two
 * independent `256` literals could silently diverge.
 */

/**
 * Upper bound on the correlation / id fields a paired extension may send
 * (agentId / clientRequestId / sessionId). Generous for real ids
 * (128-bit hex = 32 chars, agent ids are short) while refusing unbounded
 * strings that would otherwise sail past the per-message gate and sit in
 * registry maps until TTL. Applied identically on the HTTP and WS paths.
 */
export const MAX_EXT_ID_LEN = 256

/**
 * Body-size cap for tokenless / pre-auth body-parsing endpoints in the
 * external-client namespace (external-client-api.md §7.2.2 / §10.4 R-10).
 *
 * `/pair` parses its body AFTER only the origin gate (`pairOriginGate`),
 * which runs BEFORE pairing-code authentication. Any store-distributed
 * extension presenting a valid `chrome-extension://<id>` origin can reach
 * `/pair` without knowing a pairing code, so without a cap it could make
 * the server parse bodies up to Express' default 100KB limit — a
 * pre-auth body-parsing DoS surface. A legitimate pairing body carries
 * only `pairingCode` (32-hex) + `extensionId` (≤ 32 chars), so `1kb` is
 * generous for valid requests while closing the DoS surface.
 *
 * Kept here, alongside `MAX_EXT_ID_LEN`, as the single source of truth so
 * the cap cannot silently drift from the HTTP path that consumes it.
 */
export const MAX_PRE_AUTH_BODY_SIZE = '1kb'
