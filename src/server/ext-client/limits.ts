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
