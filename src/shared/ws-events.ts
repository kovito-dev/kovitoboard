/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Stable API: WebSocket event type definitions.
 *
 * Defines the server ⇔ client event contract.
 * Both server and renderer import this file — do NOT depend on
 * Node.js or DOM-specific types. Use type-only imports.
 *
 * Stability classification:
 *   @stable  — ServerToClientEvent, ClientToServerEvent (union shapes)
 *   @stable  — TrustPromptDetectedPayload, TrustPromptRespondPayload
 *   @stable  — TrustPromptKind, TrustPromptChoice
 *   @internal — Individual event payload fields may be extended
 *               (new optional fields are non-breaking)
 *
 * @stable v0.1.0
 * @see DEC-005 (Specification-Driven Architecture)
 */

// =========================
// Common meta types
// =========================

/** Prompt kind (used for UI display classification). Synced with `kind` in the pattern definition file. */
export type TrustPromptKind =
  | 'folder-trust'
  | 'write'
  | 'edit'
  | 'read'
  | 'bash'
  | 'sandbox-network'
  | 'other'

/** A single choice displayed in the UI */
export interface TrustPromptChoice {
  /** Choice ID (synced with the pattern definition) */
  id: string
  /** Display label for the UI */
  label: string
  /**
   * Full label without truncation. Used as the tooltip when `label` was
   * shortened (e.g. for very long dynamic options that are clipped to
   * fit a button). Optional — if absent, the UI shows `label` itself as
   * the tooltip. Set by the dynamic choice extractor (TP-1, v1.2 spec
   * §4-1-4) when an on-screen option text exceeds the display budget.
   */
  fullLabel?: string
  /**
   * Key sequence passed to tmux send-keys.
   * - If the sequence ends with `\n`, the `\n` is converted to an `Enter` key press
   * - Example: `"1\n"` → `tmux send-keys -- 1 Enter`
   * - Example: `"Enter"` → `tmux send-keys -- Enter`
   *
   * For numbered-menu prompts (the common case where Claude Code shows
   * `1. Yes` / `2. No` / etc.), this field carries a *fallback* value.
   * The detector resolves the actual key sequence at detection time by
   * matching `labelPattern` against the on-screen menu and prefixing the
   * row number with `\n`. This protects KB against Claude Code releases
   * that reorder or remove menu options (e.g. 2.1.126 dropped the
   * "Yes, allow this session" row from `bash-command`, which previously
   * caused `"2\n"` to be interpreted as "No"). The fallback `keys` is
   * only used when the on-screen menu cannot be parsed.
   */
  keys: string
  /**
   * Regex (as a string, compiled with the `i` flag) that matches the
   * label of this choice on the actual prompt screen. When set, the
   * detector pairs this choice with the matching `N. <label>` row found
   * in the tmux capture and computes `keys` dynamically as `${N}\n`.
   *
   * Optional for backward compatibility — choices without `labelPattern`
   * fall back to the static `keys` field.
   */
  labelPattern?: string
}

// =========================
// Server → Client
// =========================

/** A trust prompt was detected via successful pattern matching */
export interface TrustPromptDetectedPayload {
  /** Unique prompt ID assigned by the server (used for response correlation) */
  promptId: string
  /** Target tmux window name (= agent ID) */
  windowName: string
  /** Prompt kind */
  kind: TrustPromptKind
  /** ID of the matched pattern definition */
  patternId: string
  /** Additional info extracted by the pattern definition's extract rules (keys are pattern-specific) */
  detail: Record<string, string | null>
  /** Warning flag indicating degenerate display (e.g., unexpected number of choices) */
  degenerate: boolean
  /** Choices to display in the UI */
  choices: TrustPromptChoice[]
  /** Trailing portion of tmux capture (approximately 30 lines) */
  rawBuffer: string
}

/** Pattern did not match, but state-based detection determined input is being awaited (unknown prompt) */
export interface TrustPromptFallbackPayload {
  promptId: string
  windowName: string
  /** Trailing portion of tmux capture (approximately 50 lines) */
  rawBuffer: string
}

/** Notifies the UI that the response has been sent and the prompt has been dismissed */
export interface TrustPromptResolvedPayload {
  promptId: string
  windowName: string
}

/**
 * Latest activity line picked from the agent's tmux pane.
 *
 * Sent at most once per second per window, only when the line actually
 * changes vs the previous broadcast. The renderer displays it next to
 * the typing indicator while the session is `thinking` / `waiting` so
 * the user can see "what is the agent doing right now" instead of just
 * a pulse animation.
 *
 * The `line` is already trimmed and length-capped on the server side
 * (see `agent-activity-monitor.ts`); the renderer should render it as-is.
 */
export interface AgentActivityPayload {
  sessionId: string
  windowName: string
  /** Trimmed, length-capped activity line. May still contain bullet glyphs (●✱✢⎿). */
  line: string
  ts: number
}

/**
 * `app/menu.ts` was created, modified, or removed on disk, or one of
 * the v0.2.1 menu metadata routes (`PUT /api/apps/menu-order` /
 * `PATCH /api/apps/:appId/menu-label`) committed a change.
 *
 * The renderer should re-fetch `GET /api/app/menu-entries` so newly
 * installed recipes (which write `app/menu.ts` via the agent) appear
 * in the navigation, and re-fetch the affected `AppManifest`(s) when
 * the event carries a `menu-order-update` / `menu-label-update`
 * trigger.
 *
 * For `event: 'menu-label-update'` the `appId` field is set so a
 * narrow refetch is possible; for `event: 'menu-order-update'` the
 * `appId` is omitted because the closed-world batch update affects
 * every eligible app at once.
 *
 * @see docs/specs/ws-event-contract.md v1.4 §6.1 / §7.6.2
 */
export interface AppMenuChangedPayload {
  /**
   * Either a chokidar watcher event (`'add' | 'change' | 'unlink'`,
   * `appId` omitted) or a v0.2.1 menu-metadata HTTP route emission
   * (`'menu-order-update' | 'menu-label-update'`, see comment above).
   */
  event:
    | 'add'
    | 'change'
    | 'unlink'
    | 'menu-order-update'
    | 'menu-label-update'
  /**
   * Optional KB-local app identifier. Set when `event` is
   * `'menu-label-update'`; omitted for the closed-world
   * `'menu-order-update'` and the three chokidar watcher events.
   */
  appId?: string
  /** Server-side timestamp the change was observed. */
  ts: number
}

export type ServerToClientEvent =
  | { type: 'new_event'; payload: { sessionId: string; event: unknown } }
  | { type: 'status_change'; payload: { sessionId: string; status: string } }
  | { type: 'new_session'; payload: { summary: unknown } }
  | { type: 'process_end'; payload: { processId: string; status: string; exitCode: number } }
  | { type: 'trust_prompt_detected'; payload: TrustPromptDetectedPayload }
  | { type: 'trust_prompt_fallback'; payload: TrustPromptFallbackPayload }
  | { type: 'trust_prompt_resolved'; payload: TrustPromptResolvedPayload }
  | { type: 'agent_restarted'; payload: { agentId: string } }
  | { type: 'app_menu_changed'; payload: AppMenuChangedPayload }
  | { type: 'agent_activity'; payload: AgentActivityPayload }
  | { type: 'agents_changed'; payload: AgentsChangedPayload }
  | { type: 'recipe_apps_changed'; payload: RecipeAppsChangedPayload }

/**
 * Fired when a bundled sample recipe is enabled or disabled (v0.2.1).
 *
 * Carries the trigger action, the affected `appId`, and the persisted
 * manifest `source` (so consumers can distinguish a fresh bundled
 * enable from a grandfather-sample disable without re-querying the
 * manifest store).
 *
 * The `source` field uses the persisted four-value enum (`'bundled' |
 * 'sample'` for the bundled-installer paths covered by this event;
 * the UI alias `'sample (grandfather)'` is derivation-only and not
 * carried on the wire).
 *
 * @see docs/specs/ws-event-contract.md v1.4 §6.1 / §7.6.3
 * @see docs/specs/http-api-contract.md v1.7.1 §6.3.8.B
 * @stable v0.2.1
 */
export interface RecipeAppsChangedPayload {
  trigger: 'enable' | 'disable'
  appId: string
  source: 'bundled' | 'sample'
  ts: number
}

/**
 * Fired when the on-disk agent set changes (create / update / delete
 * via the write API). Consumers refetch `/api/agents` to refresh
 * lists and detail views without a full reload.
 *
 * `reason` lets a consumer scope its reaction — e.g. an "edit" page
 * does not need to reset its form on `'created'` events for an
 * unrelated agent.
 */
export interface AgentsChangedPayload {
  reason: 'created' | 'updated'
  agentId: string
}

// =========================
// Client → Server
// =========================

export type TrustPromptResponseMode = 'choice' | 'raw-keys'

export interface TrustPromptRespondPayload {
  promptId: string
  windowName: string
  response:
    | { mode: 'choice'; choiceId: string }
    | { mode: 'raw-keys'; rawKeys: string }
}

/**
 * Renderer -> server log forwarding (DEC-017 v1.2 §10, design §13.3).
 *
 * Renderer-side modules emit logs via `createLogger(component)` which
 * sends them over the WebSocket. The server merges them into the same
 * pino multistream as native server-side logs, tagged with
 * `client.<component>` so a single read of `.kovitoboard/logs/server.*.log`
 * shows both server and client activity in chronological order.
 *
 * `ts` is intentionally not on the wire — the server stamps the
 * timestamp on receipt so all log records share a single, trusted clock.
 */
export interface ClientLogPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  /** Logical component name. Server tags it as `client.<component>`. */
  component: string
  /** Human-readable message (English per DEC-012). */
  msg: string
  /** Optional structured fields. JSON-serializable; capped at 4KB at the server. */
  data?: Record<string, unknown>
}

export type ClientToServerEvent =
  | { type: 'trust_prompt_respond'; payload: TrustPromptRespondPayload }
  | { type: 'client_log'; payload: ClientLogPayload }

// =========================
// Event type utilities
// =========================

/** Utility type to extract a server event by its specific type */
export type ServerEventOf<T extends ServerToClientEvent['type']> = Extract<
  ServerToClientEvent,
  { type: T }
>
