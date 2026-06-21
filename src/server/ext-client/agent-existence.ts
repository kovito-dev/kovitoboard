/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Agent-existence resolution for external-client launches
 * (external-client-api.md v1.2 §10.4 R-7).
 *
 * Why this exists
 * ---------------
 * A paired extension may send an arbitrary `agentId` to the HTTP
 * `POST /api/ext/_client/v1/sessions/new` or WS `ext_session_new` path.
 * Phase 0 originally validated only "non-empty bounded string", so a
 * garbage agentId would still reach `ensureTmuxAgent` →
 * `tmuxBridge.startAgent` and spawn an undefined-agent tmux window +
 * claude process (resource-exhaustion DoS surface + a 202-then-broken
 * correctness gap). R-7 closes this with a cheap must-fix: the agentId
 * must name a real agent definition BEFORE any launch side effect.
 *
 * Three-value contract
 * --------------------
 *   - `'exists'`     — agentId is in the live definition set → proceed.
 *   - `'unknown'`    — well-formed but not a real agent → HTTP 400
 *                      `Unknown agentId` / WS ignore + warn.
 *   - `'load-failed'`— the definition set could not be built (the loader
 *                      threw) → fail-closed: HTTP 500 / WS no-launch. We
 *                      deliberately do NOT fall back to bounded-string
 *                      acceptance — an existence set we cannot build must
 *                      not authorise a spawn.
 *
 * This module is loader-agnostic (the caller injects a thunk returning
 * the agent list) so it stays a pure, directly-unit-testable function
 * shared verbatim by the HTTP and WS launch paths.
 */

export type ExtAgentExistence = 'exists' | 'unknown' | 'load-failed'

/** Minimal shape this check needs from an agent definition. */
interface AgentLike {
  id: string
}

/**
 * Resolve whether `agentId` names a real agent. `loadDefs` is a thunk
 * that returns the current agent list; if it throws, the result is
 * `'load-failed'` (fail-closed) and `onLoadError` (if provided) is
 * invoked for operator logging.
 */
export function resolveAgentExistence(
  agentId: string,
  loadDefs: () => AgentLike[],
  onLoadError?: (err: unknown) => void,
): ExtAgentExistence {
  let defs: AgentLike[]
  try {
    defs = loadDefs()
  } catch (err) {
    if (onLoadError) onLoadError(err)
    return 'load-failed'
  }
  return defs.some((a) => a.id === agentId) ? 'exists' : 'unknown'
}
