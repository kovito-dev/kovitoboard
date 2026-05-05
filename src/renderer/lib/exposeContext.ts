/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * exposeContext — store + reader for the β-method screen-context API
 * (DEC-020 / EU8 Phase 5).
 *
 * Apps and recipes call `window.kb.exposeContext({ ...state })` from a
 * useEffect to publish their internal state. The ambient sidebar reads
 * the latest payload at send-time and embeds it as an
 * `[ExposedContext]` section so the agent can reason about app state
 * the DOM does not surface (e.g. selected report id, current filter).
 *
 * Spec contract (§2.4):
 *   - Each call replaces the previous payload (no merge), keeping the
 *     surface trivial for app authors.
 *   - Payload size cap = 100 KB. Larger payloads are truncated and a
 *     console warning is emitted; the previous payload is preserved.
 *   - Payload must be a plain JSON-serializable object.
 *   - Reading the latest payload is synchronous and side-effect free.
 *
 * Lifecycle note (Phase 5 vs window.kb):
 *   The existing `window.kb` channel (`call`, `log`) is injected only
 *   while a recipe page is mounted (see app-host/injectKb.ts). The
 *   spec §2.4 mandates `window.kb.exposeContext`, so we keep the
 *   field on `window.kb` and bootstrap it once at app start. The
 *   recipe-page injectKb merges call/log on top of the bootstrap so
 *   the field stays available across recipe lifecycle. Architect
 *   review of this lifecycle decision is captured under Q6 (DEC-006
 *   extension) for Phase 5 closure.
 */

import { createLogger } from './logger'

const log = createLogger('exposeContext')

export type ExposeContextPayload = Record<string, unknown>

/** Spec §2.4 — 100 KB serialized cap. */
export const MAX_PAYLOAD_BYTES = 100_000

interface ExposedContextEntry {
  payload: ExposeContextPayload
  serialized: string
  /** Wall-clock ms (Date.now). Used by readers for diagnostics only. */
  receivedAt: number
}

let current: ExposedContextEntry | null = null

/**
 * Replace the current exposed-context payload. Call from app-side
 * `window.kb.exposeContext`. Returns true on success, false when the
 * payload was rejected (oversize / non-serializable); the previous
 * payload is left untouched on rejection.
 */
export function setExposedContext(payload: ExposeContextPayload): boolean {
  // Defensive: reject obvious non-objects up front so app authors get
  // a clear error rather than a silent serialize.
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    log.warn(
      { type: typeof payload, isArray: Array.isArray(payload) },
      'exposeContext rejected: payload must be a plain object',
    )
    return false
  }

  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch (err) {
    log.warn({ err }, 'exposeContext rejected: payload is not JSON-serializable')
    return false
  }

  if (serialized.length > MAX_PAYLOAD_BYTES) {
    log.warn(
      { size: serialized.length, cap: MAX_PAYLOAD_BYTES },
      'exposeContext rejected: payload exceeds 100 KB cap',
    )
    return false
  }

  current = { payload, serialized, receivedAt: Date.now() }
  return true
}

/**
 * Read the latest exposed-context payload. Returns null when nothing
 * has been published yet. Synchronous and side-effect free; safe to
 * call from React render or send-time composition.
 */
export function getExposedContext(): ExposedContextEntry | null {
  return current
}

/**
 * Clear any stored payload. Mainly for tests; production code should
 * not need this since each setExposedContext replaces the previous
 * value.
 */
export function clearExposedContext(): void {
  current = null
}
