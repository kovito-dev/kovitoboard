/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Resolve which agent (= tmux window with `claude --agent <id>` running)
 * should host a recipe-apply or recipe-install prompt.
 *
 * Background:
 *   `/api/recipes/apply` and `/api/recipes/install` both translate a
 *   parsed recipe into a long natural-language prompt that gets routed
 *   to an interactive Claude session via `tmuxBridge.sendMessage()`.
 *   That requires a tmux window where `claude` is already running in
 *   interactive mode — the bare `main` shell tmux creates with the
 *   session does not count, and an agent window that has been killed
 *   does not either.
 *
 *   Until v0.1.0 the install endpoint silently warned and returned
 *   `success: true` when no agent window was running, leaving the
 *   manifest / own-data / history in a "claimed installed" state but
 *   with no actual files written under `app/`. The apply endpoint
 *   returned an opaque "Start an agent first." 400.
 *
 *   This resolver replaces both of those paths with a uniform
 *   "use a running window if any, otherwise auto-launch one and wait
 *   for the prompt" sequence so the user does not need to know that
 *   recipe application is implemented on top of tmux.
 *
 * Selection policy when launching:
 *   1. If the caller passed `preferredAgentId` and an agent definition
 *      with that id exists, launch that one.
 *   2. Otherwise prefer `kovito-concierge` (the default onboarding
 *      agent — recipes are conceptually the concierge's responsibility
 *      in the product narrative).
 *   3. Otherwise fall back to the first agent in `loadAgentDefinitions`
 *      order (file-system order is good enough; no canonical ranking
 *      exists in v0.1.0).
 *
 * Failure modes (returned, never thrown):
 *   - `no-agents`: there are zero agent definitions; the user must
 *     create an agent before any recipe can be applied.
 *   - `startup-failed`: tmux refused to spawn the new window (e.g.
 *     binary missing, claude not on PATH, tmux not installed).
 *   - `startup-timeout`: claude did spawn but the live input prompt
 *     never appeared within `startupTimeoutMs`. The most common cause
 *     is the initial folder-trust prompt blocking the session — that
 *     is a UI-side handshake, so the API surfaces the timeout and
 *     lets the renderer prompt the user to clear the modal and
 *     retry.
 */
import type { FileAccessLayer } from '../fs-layer'
import type { ViewerConfig } from '../types'
import type { TmuxBridge } from '../tmux-bridge'
import { loadAgentDefinitions } from '../agent-reader'

/**
 * Default time budget for `tmuxBridge.waitForAgentReady` after a fresh
 * `claude --agent` spawn. 30 seconds is comfortably above the
 * cold-start time observed locally (typically 5–12 s including npm
 * resolution) but tight enough that a stuck trust-prompt does not
 * hold the install request hostage indefinitely.
 */
export const DEFAULT_AGENT_STARTUP_TIMEOUT_MS = 30_000

/**
 * Agent id we prefer to host recipes when no preference is given by
 * the caller. The string is duplicated here (not imported from the
 * onboarding code) so the resolver does not transitively depend on
 * the renderer; if the agent does not exist this is treated as a
 * graceful "fall through to first agent" signal, not an error.
 */
const PREFERRED_RECIPE_AGENT_ID = 'kovito-concierge'

/** Outcome of `resolveAgentWindowForRecipe`. */
export type RecipeAgentResolution =
  | {
      kind: 'ready'
      /** tmux window name that is safe to send a prompt to. */
      windowName: string
      /** Agent id resolved (== windowName when started by us). */
      agentId: string
      /** True when this resolver started the window (vs reusing an existing one). */
      started: boolean
    }
  | { kind: 'no-agents' }
  | { kind: 'startup-failed'; agentId: string; error: string }
  | { kind: 'startup-timeout'; agentId: string }

export interface ResolveAgentWindowOptions {
  /**
   * The agent id the caller would like to use. When it matches an
   * already-running window we use it as-is; otherwise it is the first
   * candidate considered for an auto-launch. Pass `undefined` to let
   * the resolver pick.
   */
  preferredAgentId?: string
  /** Override `DEFAULT_AGENT_STARTUP_TIMEOUT_MS` for tests. */
  startupTimeoutMs?: number
}

/**
 * Public entry point. See module-level doc comment for semantics.
 */
export async function resolveAgentWindowForRecipe(
  fs: FileAccessLayer,
  config: ViewerConfig,
  tmuxBridge: TmuxBridge,
  options: ResolveAgentWindowOptions = {},
): Promise<RecipeAgentResolution> {
  const { preferredAgentId, startupTimeoutMs = DEFAULT_AGENT_STARTUP_TIMEOUT_MS } =
    options

  // 1. Reuse a running window when possible — cheap path, avoids the
  //    extra `claude` cold-start and any trust-prompt handshake.
  const runningMap = tmuxBridge.getAgentWindowMap()
  if (preferredAgentId && runningMap[preferredAgentId]) {
    return {
      kind: 'ready',
      windowName: runningMap[preferredAgentId],
      agentId: preferredAgentId,
      started: false,
    }
  }
  const firstRunningId = Object.keys(runningMap)[0]
  if (firstRunningId) {
    return {
      kind: 'ready',
      windowName: runningMap[firstRunningId],
      agentId: firstRunningId,
      started: false,
    }
  }

  // 2. No window is running — pick an agent definition to launch.
  const agents = loadAgentDefinitions(fs, config)
  if (agents.length === 0) {
    return { kind: 'no-agents' }
  }

  const targetAgentId = pickAgentForLaunch(agents, preferredAgentId)

  // 3. Spawn the window. `startAgent` itself returns a result, never
  //    throws — but we still wrap defensively so any unexpected error
  //    becomes a `startup-failed` outcome rather than a 500.
  let startResult: Awaited<ReturnType<TmuxBridge['startAgent']>>
  try {
    startResult = await tmuxBridge.startAgent(targetAgentId)
  } catch (err) {
    return {
      kind: 'startup-failed',
      agentId: targetAgentId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (!startResult.success) {
    return {
      kind: 'startup-failed',
      agentId: targetAgentId,
      error: startResult.error ?? 'unknown',
    }
  }

  // 4. Wait for the live input prompt. `waitForAgentReady` returns
  //    `false` (rather than throwing) on timeout, including the
  //    common "trust-prompt is blocking" case — that is the signal
  //    we surface to the caller.
  const ready = await tmuxBridge.waitForAgentReady(targetAgentId, startupTimeoutMs)
  if (!ready) {
    return { kind: 'startup-timeout', agentId: targetAgentId }
  }

  return {
    kind: 'ready',
    windowName: targetAgentId,
    agentId: targetAgentId,
    started: true,
  }
}

/**
 * Pick which agent id to spawn when nothing is running yet.
 *
 * Exported only for unit tests so the policy can be exercised without
 * standing up tmux. Production callers go through
 * `resolveAgentWindowForRecipe`.
 */
export function pickAgentForLaunch(
  agents: Array<{ id: string }>,
  preferredAgentId?: string,
): string {
  if (preferredAgentId && agents.some((a) => a.id === preferredAgentId)) {
    return preferredAgentId
  }
  if (agents.some((a) => a.id === PREFERRED_RECIPE_AGENT_ID)) {
    return PREFERRED_RECIPE_AGENT_ID
  }
  return agents[0].id
}

/**
 * Build the user-facing error payload for a non-ready resolution.
 * Centralized so `/api/recipes/apply` and `/api/recipes/install` keep
 * an identical wording surface (the renderer surfaces `error` verbatim
 * in a banner).
 *
 * The HTTP status hints follow REST conventions:
 *   - 409 Conflict for "preconditions not met on the user's side"
 *     (no agents) — recoverable by user action that the API cannot
 *     perform on their behalf.
 *   - 503 Service Unavailable for "the underlying service did not
 *     reach a ready state" (startup timeout) — recoverable by the
 *     user clearing a UI modal and retrying.
 *   - 500 Internal Server Error for "the underlying service refused
 *     to start" — typically an environment problem (tmux/claude
 *     missing).
 */
export function buildAgentResolutionError(
  resolution: Exclude<RecipeAgentResolution, { kind: 'ready' }>,
): { status: number; error: string } {
  switch (resolution.kind) {
    case 'no-agents':
      return {
        status: 409,
        error:
          'No agents are registered yet. Create an agent before installing or applying a recipe.',
      }
    case 'startup-failed':
      return {
        status: 500,
        error: `Failed to start an agent window for "${resolution.agentId}": ${resolution.error}`,
      }
    case 'startup-timeout':
      return {
        status: 503,
        error:
          'Claude Code did not finish starting in time. If a folder-trust prompt is showing, approve it and try again.',
      }
  }
}
