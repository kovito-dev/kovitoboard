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
   * Key sequence passed to tmux send-keys.
   * - If the sequence ends with `\n`, the `\n` is converted to an `Enter` key press
   * - Example: `"1\n"` → `tmux send-keys -- 1 Enter`
   * - Example: `"Enter"` → `tmux send-keys -- Enter`
   */
  keys: string
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

export type ServerToClientEvent =
  | { type: 'new_event'; payload: { sessionId: string; event: unknown } }
  | { type: 'status_change'; payload: { sessionId: string; status: string } }
  | { type: 'new_session'; payload: { summary: unknown } }
  | { type: 'process_end'; payload: { processId: string; status: string; exitCode: number } }
  | { type: 'trust_prompt_detected'; payload: TrustPromptDetectedPayload }
  | { type: 'trust_prompt_fallback'; payload: TrustPromptFallbackPayload }
  | { type: 'trust_prompt_resolved'; payload: TrustPromptResolvedPayload }

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

export type ClientToServerEvent =
  | { type: 'trust_prompt_respond'; payload: TrustPromptRespondPayload }

// =========================
// Event type utilities
// =========================

/** Utility type to extract a server event by its specific type */
export type ServerEventOf<T extends ServerToClientEvent['type']> = Extract<
  ServerToClientEvent,
  { type: T }
>
