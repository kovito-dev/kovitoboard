/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Trust Prompt Detection Loop
 *
 * Implementation conforming to spec `docs/specs/trust-prompt-relay.md` v1.1.
 *
 * Responsibilities:
 *   1. Execute `capture-pane` at regular intervals for each tmux window
 *   2. Detect known prompts via pattern matching (§4-1 / initial set §4-1-2)
 *   3. Even without pattern match, detect input-waiting state when
 *      "idle + trust footer match + no exclusion condition" holds
 *      → Route to fallback UX (§4-2)
 *   4. Receive `trust_prompt_respond` from UI and send response via `TmuxBridge.sendTrustPromptKeys`
 *
 * Design decisions (as of Phase 5b):
 *   - Initial patterns are externalized in `src/server/trust-patterns.json`. Loaded at
 *     server startup via `loadTrustPatterns(fs, path)` and injected into TrustPromptDetector
 *   - Each tmux window has its own `DetectorState` (`Map<windowName, DetectorState>`)
 *   - New window discovery rescans `listWindows()` at 1-second intervals
 *   - Detection polling interval is 200ms (spec §4-2-1)
 *   - Exclusion conditions and footer matching follow calibration results from verification notes §4
 */

import { chmodSync } from 'fs'
import type { TmuxBridge } from './tmux-bridge'
import type { FileAccessLayer } from './fs-layer'
import { getDebugTrustDir } from './paths'
import { trustLogger, lazyChildLogger } from './logger'

// Sub-component logger for trust-pattern config loader. Lazy-evaluated
// so unit tests that only import this module's pattern matcher do not
// trigger logger initialization at import time.
const trustPatternsLogger = lazyChildLogger('trust-patterns')
import type {
  ServerToClientEvent,
  TrustPromptChoice,
  TrustPromptKind,
  TrustPromptDetectedPayload,
  TrustPromptFallbackPayload,
} from '../shared/ws-events'

// =========================
// Configuration
// =========================

/**
 * Detection polling interval (ms). Spec §4-2-1.
 *
 * Production default is 200 ms. Under KB_E2E_MODE the loop is sped up
 * to 50 ms — this is the fix introduced as DEC-018 v1.1 P1-7. See
 * `docs/design/v0.1.0-test-quality-assurance-design.md` §3.7 for the
 * rationale: a faster tick lets `refreshWindows()` notice a recycled
 * tmux window and reseed its DetectorState entry well within the
 * waitForFullDispose settle margin, eliminating the residual
 * 30min-experience flake observed at 200 ms.
 *
 * The constant is evaluated once at module load (which happens at
 * webServer start), so KB_E2E_MODE only needs to be set when the
 * webServer is launched — not per request.
 */
export const POLL_INTERVAL_MS = process.env.KB_E2E_MODE === '1' ? 50 : 200

/** Window list rescan interval (ms) */
export const WINDOW_DISCOVERY_INTERVAL_MS = 1000

/** Consecutive match count required for idle detection (2 means 400ms+ of no change) */
export const IDLE_CONFIRMATIONS = 2

/** Number of lines to capture via `capture-pane -S -<lines>` (spec §4-1-3) */
export const CAPTURE_LINES = 200

/** Number of tail lines to include in rawBuffer for detected events */
const RAW_BUFFER_DETECTED_TAIL_LINES = 30

/** Number of tail lines to include in rawBuffer for fallback events */
const RAW_BUFFER_FALLBACK_TAIL_LINES = 50

// =========================
// Exclusion conditions & footer regex (state-based detection §4-2-1)
// =========================

/**
 * Exclusion conditions: if the **last 5 lines** of capture match any of these,
 * treat it as a normal state. Uses the 3 conditions from verification notes
 * §4-2 finding 3 / §4-3 exclusion conditions.
 *
 * Note: Only the tail lines are inspected, not the entire capture.
 * Even in captures showing a trust prompt, past lines like `Running…` may
 * remain in the scrollback above (e.g., sandbox-network-escape), so
 * full-capture inspection would cause false negatives (missing trust prompts).
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /\? for shortcuts/, // Normal input waiting
  /⎿\s+Running…/, // Processing
  /✢\s+\w+…\s+\(thinking\)/, // Thinking
]

/** Number of tail lines to check for exclusion conditions */
const EXCLUDE_CHECK_TAIL_LINES = 5

/**
 * Trust prompt footer patterns. If the last non-empty line matches any of these,
 * it is considered a "trust prompt state candidate".
 *
 * DEC-014 v1.3 Phase 1: Expanded variants to absorb minor UI changes.
 */
export const TRUST_FOOTER_PATTERNS: RegExp[] = [
  /Esc to cancel · Tab to amend/, // Write / Edit / Bash / Read
  /Enter to confirm · Esc to cancel/, // Folder Trust
  /ctrl\+e to explain/, // Bash-specific additional footer
  /tell Claude what to do differently/, // Sandbox Network Escape
  // Phase 1 additions: more permissive variants
  /Enter\s+to\s+confirm/,            // Variants of "Enter to confirm X"
  /Esc\s+to\s+cancel/,               // Variants of "Esc to cancel X"
  /Tab\s+to\s+\w+/,                  // Variants of "Tab to Y"
  /\d+\.\s+Yes.*\n\s*\d+\.\s+No/m,   // Numbered menu (1. Yes ... 2. No) — strong signal
]

// =========================
// Pattern definitions
// =========================

/**
 * A single trust prompt pattern definition.
 * Source is `src/server/trust-patterns.json`. The loader returns compiled
 * `TrustPattern` instances.
 */
export interface TrustPattern {
  id: string
  kind: TrustPromptKind
  priority: number
  /** Confirmed if any one matches */
  matchAny: RegExp[]
  /** Footer regexes for matching last non-empty line (pre-filter). Always an array. */
  footer: RegExp[]
  /** Additional info extraction via capture groups (ID is confirmed even if extraction fails) */
  extract: Record<string, RegExp>
  /** Additional indicator for degenerate display (if present, sends `degenerate: true` to UI) */
  degenerateForms?: RegExp[]
  /** Choices for UI display (with send keys) */
  choices: TrustPromptChoice[]
}

// =========================
// Pattern JSON loader
// =========================

/**
 * Root structure of `trust-patterns.json`.
 *
 * DEC-015: `primaryTestedVersion` / `primaryTestedChannel` / `bestEffortVersions`
 * were added for the Claude Code version support strategy.
 */
interface TrustPatternFile {
  version?: string
  primaryTestedVersion?: string
  primaryTestedChannel?: string
  bestEffortVersions?: string[]
  /** @deprecated Use bestEffortVersions. Kept for backward compatibility. */
  compatibleClaudeCodeVersions?: string[]
  /** @deprecated Use bestEffortVersions. Kept for backward compatibility. */
  _compatibleClaudeCodeVersions_DEPRECATED?: string[]
  patterns: RawTrustPattern[]
}

/**
 * A single pattern as stored in JSON. Regex fields are stored as strings.
 * The loader compiles them to `RegExp` with the multiline flag (`m`) always set.
 *
 * `footer` accepts either a single string or an array of strings
 * (R2-3: footer array support for multiple variants).
 */
interface RawTrustPattern {
  id: string
  kind: TrustPromptKind
  priority: number
  matchAny: string[]
  footer: string | string[]
  extract?: Record<string, string>
  degenerateForms?: string[]
  choices: TrustPromptChoice[]
}

/**
 * Parsed and compiled trust-patterns configuration.
 * Returned by `loadTrustPatterns()` — contains both metadata and compiled patterns.
 */
export interface TrustPatternsConfig {
  version: string
  primaryTestedVersion: string
  primaryTestedChannel: string
  bestEffortVersions: string[]
  patterns: TrustPattern[]
}

/**
 * Load `trust-patterns.json` and compile it into `TrustPatternsConfig`.
 *
 * Returns the full config including metadata (primaryTestedVersion, etc.)
 * and compiled patterns. Throws on failure to prevent the server from
 * starting with an empty detection loop.
 *
 * @param fs   FileAccessLayer (fs abstraction introduced in Phase 4)
 * @param path Absolute path to the JSON file
 */
export function loadTrustPatterns(fs: FileAccessLayer, path: string): TrustPatternsConfig {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(
      `Failed to read trust-patterns.json (${path}): ${(err as Error).message}`,
    )
  }

  let parsed: TrustPatternFile
  try {
    parsed = JSON.parse(text) as TrustPatternFile
  } catch (err) {
    throw new Error(
      `Failed to parse trust-patterns.json (${path}): ${(err as Error).message}`,
    )
  }

  if (!parsed || !Array.isArray(parsed.patterns)) {
    throw new Error(
      `trust-patterns.json has no patterns array (${path})`,
    )
  }
  if (parsed.patterns.length === 0) {
    throw new Error(
      `trust-patterns.json patterns array is empty (${path}). Rejected to prevent all prompts from falling through to fallback.`,
    )
  }

  // DEC-015: Read version metadata with backward-compatible fallbacks
  const primaryTestedVersion = typeof parsed.primaryTestedVersion === 'string'
    ? parsed.primaryTestedVersion
    : '0.0.0' // Old JSON without primary declaration → always triggers mismatch warning
  const primaryTestedChannel = typeof parsed.primaryTestedChannel === 'string'
    ? parsed.primaryTestedChannel
    : 'stable'
  const bestEffortVersions = Array.isArray(parsed.bestEffortVersions)
    ? parsed.bestEffortVersions
    : (Array.isArray(parsed.compatibleClaudeCodeVersions) ? parsed.compatibleClaudeCodeVersions : [])

  if (primaryTestedVersion === '0.0.0') {
    trustPatternsLogger.warn(
      { path },
      'primaryTestedVersion not declared. Version check will always produce a mismatch warning.',
    )
  }

  return {
    version: parsed.version ?? 'unknown',
    primaryTestedVersion,
    primaryTestedChannel,
    bestEffortVersions,
    patterns: parsed.patterns.map((raw) => compileTrustPattern(raw, path)),
  }
}

/**
 * Compile `RawTrustPattern` into `TrustPattern`.
 * RegExp is always constructed with the multiline (`m`) flag. Since fixture design
 * and implementation (§4-1-2) all assume multiline, there is no need to specify
 * flags individually in the JSON.
 */
function compileTrustPattern(raw: RawTrustPattern, path: string): TrustPattern {
  if (!raw || typeof raw.id !== 'string' || typeof raw.kind !== 'string' || typeof raw.priority !== 'number') {
    throw new Error(
      `trust-patterns.json pattern definition is incomplete (${path}): ${JSON.stringify(raw)}`,
    )
  }
  if (!Array.isArray(raw.matchAny) || raw.matchAny.length === 0) {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" has empty matchAny (${path})`,
    )
  }
  if (typeof raw.footer !== 'string' && !Array.isArray(raw.footer)) {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" footer must be string or string[] (${path})`,
    )
  }
  if (!Array.isArray(raw.choices)) {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" choices is not an array (${path})`,
    )
  }

  try {
    // R2-3: footer accepts string or string[]; normalize to RegExp[]
    const footerStrings = Array.isArray(raw.footer) ? raw.footer : [raw.footer]
    return {
      id: raw.id,
      kind: raw.kind,
      priority: raw.priority,
      matchAny: raw.matchAny.map((s) => new RegExp(s, 'm')),
      footer: footerStrings.map((s) => new RegExp(s, 'm')),
      extract: Object.fromEntries(
        Object.entries(raw.extract ?? {}).map(([k, s]) => [k, new RegExp(s, 'm')]),
      ),
      degenerateForms: raw.degenerateForms?.map((s) => new RegExp(s, 'm')),
      choices: raw.choices,
    }
  } catch (err) {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" RegExp compilation failed: ${(err as Error).message}`,
    )
  }
}

// =========================
// Pattern matching engine
// =========================

export interface MatchResult {
  pattern: TrustPattern
  extracted: Record<string, string | null>
  degenerate: boolean
}

/**
 * Attempt pattern matching against a capture string in priority order.
 * Uses the last non-empty line (`footer`) as a pre-filter to narrow down candidates.
 */
export class PatternMatcher {
  private patterns: TrustPattern[]

  constructor(patterns: TrustPattern[]) {
    // Sort by priority descending
    this.patterns = [...patterns].sort((a, b) => b.priority - a.priority)
  }

  match(capture: string): MatchResult | null {
    const footerLine = lastNonEmptyLine(capture)

    // Filter candidates by footer (optimization); any footer variant match suffices
    const candidates = this.patterns.filter((p) => p.footer.some((re) => re.test(footerLine)))
    if (candidates.length === 0) return null

    for (const pattern of candidates) {
      if (!pattern.matchAny.some((r) => r.test(capture))) continue

      const extracted: Record<string, string | null> = {}
      for (const [key, regex] of Object.entries(pattern.extract)) {
        const m = capture.match(regex)
        extracted[key] = m ? (m[1] ?? m[0]) : null
      }
      const degenerate = pattern.degenerateForms
        ? pattern.degenerateForms.some((r) => r.test(capture))
        : false
      return { pattern, extracted, degenerate }
    }
    return null
  }
}

// =========================
// Visible choice extractor (Claude Code 2.1.126 compatibility)
// =========================

/**
 * One row of the on-screen choice menu, e.g. `❯ 1. Yes`.
 */
export interface VisibleChoice {
  /** Number prefix shown in the menu, e.g. `1` for `1. Yes`. */
  num: number
  /** Trimmed label following the number prefix, e.g. `Yes`. */
  label: string
}

/**
 * Regex for parsing one numbered-menu row out of a tmux capture buffer.
 *
 * Matches forms like:
 *   ` ❯ 1. Yes, I trust this folder`
 *   `   2. No, exit`
 *   `❯ 1. Yes`
 *
 * The leading `❯` cursor marker is optional; `Claude Code` only attaches
 * it to the focused row so non-focused rows omit it. We intentionally
 * disallow inline trailing punctuation past the label (no `:` capture)
 * because Claude Code never decorates the row beyond the label text.
 */
const VISIBLE_CHOICE_LINE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/

/**
 * Extract every numbered-menu row visible in `capture`.
 *
 * The detector calls this on the same buffer used for pattern matching
 * so the resolved choices stay synchronized with the prompt that fired
 * the event. Order is preserved as it appeared on screen.
 *
 * Why this exists: prior to Claude Code 2.1.126, KB statically mapped
 * each pattern's choice to a key (`"2\n"` for `yes-session`, etc.).
 * 2.1.126 dropped the per-session row from `bash-command`, leaving only
 * `1. Yes` / `2. No`. The legacy mapping then sent `"2\n"` and selected
 * `No`, which Claude Code reported as `"User rejected tool use"`. By
 * resolving keys against the live menu we follow Anthropic's UI.
 *
 * Bottom-up scan. The capture is the last 200 lines of the tmux pane,
 * which routinely contains agent prose above the live menu — including
 * agents whose system prompt opens with a numbered selection list (e.g.
 * a concierge agent that suggests "1. Walk me through KB", "2. ...",
 * "3. ..." in its first reply). The menu Claude Code is actually
 * waiting on is always the *last* contiguous block of `N. label` rows
 * before the cursor, so we walk from the bottom up and lock onto that
 * block. A non-numbered, non-blank line above the block (e.g.
 * "Do you want to proceed?") closes the search. Footer lines below the
 * menu ("Esc to cancel · Tab to amend") are skipped during the idle
 * phase before we enter the block.
 */
export function extractVisibleChoices(capture: string): VisibleChoice[] {
  const lines = capture.split('\n')
  const collected: VisibleChoice[] = []
  const seen = new Set<number>()
  let inBlock = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const m = line.match(VISIBLE_CHOICE_LINE)
    if (m) {
      const num = Number.parseInt(m[1], 10)
      if (!Number.isFinite(num) || num < 1 || num > 99) continue
      // Same number twice in a single block is a stale-render glitch.
      // We are walking bottom-up so the row already collected is the
      // newer one — keep it and skip the duplicate above.
      if (seen.has(num)) continue
      seen.add(num)
      collected.push({ num, label: m[2].trim() })
      inBlock = true
      continue
    }
    if (inBlock) {
      // First non-numbered line above the block (typically
      // "Do you want to proceed?" or a blank separator) closes the
      // menu. Anything above it belongs to scrollback prose.
      break
    }
    // Idle phase: keep walking up past footers, blanks, and any other
    // post-menu lines until we find the first numbered row.
  }
  // Collected bottom-to-top; reverse so the result reads the same as
  // Claude Code rendered it.
  collected.reverse()
  return collected
}

/**
 * Resolve `pattern.choices` against the live tmux capture.
 *
 * For every choice with a `labelPattern`, this looks up the matching
 * `N. <label>` row in the capture and rewrites `choice.keys` to
 * `${N}\n`. Choices whose `labelPattern` does not match anything on
 * screen are dropped — they would never select what the UI advertises.
 *
 * Choices without a `labelPattern` (or patterns whose menu we cannot
 * parse) fall through unchanged so legacy fixtures keep working until
 * the JSON is migrated.
 *
 * Returns the resolved list. The caller decides whether to fall back to
 * the raw `pattern.choices` when the result is empty (e.g. when the
 * capture buffer is truncated and the menu rolled off-screen).
 */
export function resolveVisibleChoices(
  patternChoices: TrustPromptChoice[],
  capture: string,
): TrustPromptChoice[] {
  const visible = extractVisibleChoices(capture)
  if (visible.length === 0) return []

  const resolved: TrustPromptChoice[] = []
  for (const choice of patternChoices) {
    if (!choice.labelPattern) {
      // No labelPattern → preserve as-is (legacy behaviour, used by
      // patterns that have not been migrated yet).
      resolved.push(choice)
      continue
    }
    let re: RegExp
    try {
      re = new RegExp(choice.labelPattern, 'i')
    } catch {
      // Bad regex in the JSON — skip this choice rather than crashing
      // the detection loop. The pattern loader logs the parse error at
      // startup, so we silently drop here.
      continue
    }
    const match = visible.find((v) => re.test(v.label))
    if (!match) continue
    resolved.push({ ...choice, keys: `${match.num}\n` })
  }
  return resolved
}

/**
 * Maximum length for a choice button label. Anything longer is shortened
 * with an ellipsis and the original full text is retained as a tooltip.
 * Tracks spec v1.2 §4-1-4 ("50 characters → first 30 + …").
 */
const DYNAMIC_LABEL_MAX_LENGTH = 50
const DYNAMIC_LABEL_TRUNCATE_TO = 30

/**
 * Build `TrustPromptChoice[]` directly from the visible numbered menu
 * (TP-1, spec v1.2 §4-1-4 dynamic choice extraction).
 *
 * Unlike `resolveVisibleChoices`, this function does **not** require a
 * pre-existing static choice with a `labelPattern`. It treats every row
 * Claude Code rendered as an answerable option, which lets KB faithfully
 * reflect prompts whose option set varies between sessions (e.g. the
 * "Yes, and don't ask again for: <command>" row that bash-command emits
 * only when the binary has not been allow-listed yet).
 *
 * The detector calls this first; only when the on-screen menu cannot be
 * parsed (zero rows returned) does it fall back to the legacy
 * static-choice resolution path. This preserves backward compatibility
 * with truncated captures while removing the historical "Yes / No"
 * static template that masked Claude Code's full option set in the UI.
 *
 * Label handling: the full row text is preserved in `fullLabel`, and
 * `label` is trimmed to {@link DYNAMIC_LABEL_TRUNCATE_TO} characters with
 * an ellipsis when it would exceed {@link DYNAMIC_LABEL_MAX_LENGTH}. This
 * lets the modal show a compact button while still surfacing the full
 * text via tooltip.
 */
export function buildDynamicChoices(capture: string): TrustPromptChoice[] {
  const visible = extractVisibleChoices(capture)
  if (visible.length === 0) return []

  return visible.map((row) => {
    const fullLabel = row.label
    const needsTruncation = fullLabel.length > DYNAMIC_LABEL_MAX_LENGTH
    const label = needsTruncation
      ? `${fullLabel.slice(0, DYNAMIC_LABEL_TRUNCATE_TO)}…`
      : fullLabel
    const choice: TrustPromptChoice = {
      id: `dynamic-${row.num}`,
      label,
      keys: `${row.num}\n`,
    }
    if (needsTruncation) {
      choice.fullLabel = fullLabel
    }
    return choice
  })
}

/**
 * Three-tier choice resolution used by both the live detection loop
 * and the pending-prompt replay path. See spec v1.2 §4-1-4 (TP-1
 * dynamic extraction) for the policy:
 *
 *   1. Dynamic extraction wins when at least one numbered row was
 *      visible on screen — this faithfully mirrors what Claude Code
 *      currently shows, including option variants the static patterns
 *      were not authored against.
 *   2. labelPattern resolution is the legacy hook used when dynamic
 *      extraction returned nothing (e.g. capture buffer truncated past
 *      the menu). It still respects the JSON-defined labelPattern
 *      → on-screen row mapping introduced for Claude Code 2.1.126.
 *   3. The pattern's static `choices` array is the last-resort fallback
 *      for unit tests and offline fixtures that never had a numbered
 *      menu in the buffer.
 */
function resolveChoicesForUi(
  pattern: TrustPattern,
  capture: string,
): TrustPromptChoice[] {
  // Known-but-unsupported prompts must never expose operable choices
  // (trust-prompt-relay.md v1.8 §7.8.1 / §7.8.4 — `choices: []` is
  // mandatory). The tab-style multi-question form contains its own
  // numbered rows (e.g. a trailing "6. Chat about this"), which the
  // dynamic extractor below would otherwise surface as buttons that send
  // the wrong keys into a form KB cannot operate. Short-circuit to an
  // empty list so both the live broadcast and the reconnect replay carry
  // `choices: []`.
  if (pattern.kind === 'multi-question-unsupported') return []

  const dynamic = buildDynamicChoices(capture)
  if (dynamic.length > 0) return dynamic
  const resolved = resolveVisibleChoices(pattern.choices, capture)
  if (resolved.length > 0) return resolved
  return pattern.choices
}

// =========================
// Detection state
// =========================

interface DetectorState {
  /** Hash of the most recent capture (for idle detection) */
  lastCaptureHash: string
  /** Consecutive idle count */
  consecutiveIdleCount: number
  /** promptId of the last notified prompt (to suppress duplicate detection) */
  lastDetectedPromptId: string | null
  /** Choices from the last notification (used for choiceId → keys conversion) */
  lastChoices: TrustPromptChoice[]
  /**
   * Kind of the last pattern-matched prompt (BL-2026-263 Phase A,
   * trust-prompt-relay.md v1.8 §7.8.5 / §10.7.6).
   *
   * Held per window alongside `lastChoices` so the WS gate
   * (`handleTrustPromptRespond`) can look up the kind of the prompt being
   * responded to and enforce the `multi-question-unsupported` response
   * restriction (choice rejected, raw-keys limited to the canonical ESC).
   *
   * `null` whenever there is no pending pattern-matched prompt. This is a
   * separate concern from the (future, not yet implemented) deny-model
   * `lastDetectedKind: 'pattern' | 'fallback' | null` membership flag of
   * §10.6.2 — kind lookup (enum) and membership (boolean) are kept apart so
   * the future deny-model backfill does not collide with this field.
   */
  lastDetectedPromptKind: TrustPromptKind | null
}

// =========================
// Detection loop main
// =========================

export type BroadcastFn = (event: ServerToClientEvent) => void

export class TrustPromptDetector {
  private states = new Map<string, DetectorState>()
  private tickTimer: NodeJS.Timeout | null = null
  private windowDiscoveryTimer: NodeJS.Timeout | null = null
  private matcher: PatternMatcher
  private debug: boolean
  private debugDumpDir: string | null = null
  private debugDumpDirEnsured = false
  /**
   * Map of `windowName -> hash of the capture observed at resetState()`.
   * As long as a tick produces the same hash for that window, both
   * pattern matching and fallback footer matching are bypassed: the
   * leftover content is treated as "already seen, don't re-fire". The
   * suppression for a window is automatically released the moment the
   * capture changes, returning the detector to normal behaviour.
   *
   * This is the implementation form of `skipNextMatch` from the L1
   * isolation architecture fix routes C-1: the spec describes a single
   * "skip the next tick" guard but in practice that gives only one
   * 50 ms window of suppression — long enough for a genuine new prompt
   * to slip through if it lines up against the leaked content.
   * Anchoring the suppression to the *content* rather than to a *tick*
   * makes the behaviour match the stated intent ("until something
   * changes, fire nothing").
   */
  private suppressedHashes = new Map<string, string>()

  constructor(
    private tmux: TmuxBridge,
    patterns: TrustPattern[],
    private broadcast: BroadcastFn,
    private fs?: FileAccessLayer,
  ) {
    this.matcher = new PatternMatcher(patterns)
    this.debug = process.env.KOVITOBOARD_DEBUG_TRUST === '1'
    if (this.debug && this.fs) {
      this.debugDumpDir = getDebugTrustDir(this.fs)
    }
  }

  /** Start the detection loop (no-op if already running) */
  start(): void {
    if (this.tickTimer || this.windowDiscoveryTimer) return
    this.refreshWindows() // Immediate first refresh
    this.tickTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS)
    this.windowDiscoveryTimer = setInterval(
      () => this.refreshWindows(),
      WINDOW_DISCOVERY_INTERVAL_MS,
    )
    if (this.debug) {
      trustLogger.debug('Loop started')
    }
  }

  /**
   * Test-only state reset hook (DEC-018 §3.1.4 / P1-4).
   *
   * Clears every per-window `DetectorState` entry so the next
   * `refreshWindows()` tick can populate fresh entries for whatever
   * windows currently exist. Without this, when an L1 test recreates a
   * tmux window with the same name as the previous test (because KB's
   * tmux-bridge resolves windows by agentId), the old `lastCaptureHash`
   * would stay in the state map and the detector would consider an
   * identical capture to be "unchanged" — silently swallowing the new
   * trust-prompt event.
   *
   * The detection loop itself keeps running — only the in-memory state
   * is cleared. Callers must guard exposure of this hook with
   * `process.env.KB_E2E_MODE === '1'` so production paths cannot reach
   * it (see `src/server/index.ts`).
   *
   * Re-detection guard (`suppressedHashes`): even after the state map
   * is cleared, the next `refreshWindows()` tick re-seeds entries for
   * any tmux windows that are still alive (e.g. a previous test's
   * window that has not been killed yet, or an entirely independent
   * window the next test happens to launch with the same name).
   * Without this guard the very next `tick()` would capture whatever
   * content is on the pane — including a leftover `1. Yes / 2. No`
   * prompt — and re-fire `trust_prompt_detected`, defeating the
   * purpose of the reset.
   *
   * The guard records the current capture hash for every live window
   * at reset time. Subsequent ticks check the suppression map first:
   * matching the suppressed hash means the pane has not changed since
   * reset, so detection is skipped. The first time the capture
   * changes, the suppression for that window is dropped and detection
   * resumes — so any genuine new prompt is still picked up within
   * ~50 ms under KB_E2E_MODE while leaked content from a previous
   * test stays silent.
   *
   * `tmux.capturePane()` may be a relatively expensive shell-out, but
   * resetState fires only between L1 tests (≈50 invocations per run),
   * so the overhead is negligible.
   */
  resetState(): void {
    // Snapshot the current pane content for every live window before
    // clearing state. We deliberately use the same hashing function
    // (`normalizeForIdleHash` + `simpleHash`) the detection loop uses,
    // so the comparison in `detectForWindow` is bit-exact.
    if (this.tmux.hasSession()) {
      const windows = this.tmux.listWindows()
      for (const w of windows) {
        if (w.name === 'main') continue
        const cap = this.tmux.capturePane(w.name, CAPTURE_LINES)
        if (cap) {
          this.suppressedHashes.set(
            w.name,
            simpleHash(normalizeForIdleHash(cap)),
          )
        }
      }
    }
    this.states.clear()
  }

  /** Stop the detection loop (for testing and shutdown) */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.windowDiscoveryTimer) {
      clearInterval(this.windowDiscoveryTimer)
      this.windowDiscoveryTimer = null
    }
    this.states.clear()
    this.suppressedHashes.clear()
  }

  /**
   * Receive a choice-mode response from UI and send it to tmux.
   *
   * The UI sends only the `choiceId`; the actual key sequence is resolved
   * from `lastChoices` held at the time of the last notification.
   * This design prevents the UI from injecting arbitrary keys.
   *
   * @returns Whether the send succeeded (returns false for promptId mismatch or unknown choice)
   */
  respondChoice(windowName: string, promptId: string, choiceId: string): boolean {
    if (this.debug) {
      trustLogger.debug(
        { windowName, promptId, choiceId },
        'respondChoice called',
      )
    }
    const state = this.states.get(windowName)
    if (!state) {
      trustLogger.warn({ windowName }, 'unknown window')
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      trustLogger.warn(
        { expected: state.lastDetectedPromptId, got: promptId },
        'promptId mismatch (discarded)',
      )
      return false
    }
    const choice = state.lastChoices.find((c) => c.id === choiceId)
    if (!choice) {
      trustLogger.warn(
        { choiceId, available: state.lastChoices.map((c) => c.id) },
        'unknown choiceId',
      )
      return false
    }
    if (this.debug) {
      trustLogger.debug({ windowName, keys: choice.keys }, 'sending keys')
    }
    return this.tmux.sendTrustPromptKeys(windowName, choice.keys, false)
  }

  /**
   * Raw-keys response from fallback UX.
   *
   * Enforces a 1024 character length limit (spec §5-2-2)
   * and sends in literal mode.
   */
  respondRawKeys(windowName: string, promptId: string, rawKeys: string): boolean {
    const state = this.states.get(windowName)
    if (!state) {
      trustLogger.warn({ windowName }, 'unknown window')
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      trustLogger.warn(
        { expected: state.lastDetectedPromptId, got: promptId },
        'promptId mismatch (discarded)',
      )
      return false
    }
    if (rawKeys.length > 1024) {
      trustLogger.warn({ length: rawKeys.length }, 'raw-keys too long: discarded')
      return false
    }
    return this.tmux.sendTrustPromptKeys(windowName, rawKeys, true)
  }

  /**
   * Return the kind of the pending pattern-matched prompt for
   * `(windowName, promptId)`, or `null` if there is no such pending prompt.
   *
   * BL-2026-263 Phase A (trust-prompt-relay.md v1.8 §7.8.5 / §10.7.6, plan A).
   * The WS gate (`handleTrustPromptRespond`) uses this to enforce the
   * `multi-question-unsupported` response restriction before claiming a
   * dedup slot or dispatching to tmux. It is a pure read of per-window
   * state with no side effects.
   *
   * This is intentionally a separate predicate from the (future, not yet
   * implemented) deny-model membership API `hasPendingKnownPrompt`: kind
   * lookup (enum) and membership (boolean) are kept apart so the deny-model
   * backfill does not alter this contract (§10.6.2 / §10.7.6).
   */
  getPendingPromptKind(windowName: string, promptId: string): TrustPromptKind | null {
    const state = this.states.get(windowName)
    if (!state) return null
    if (state.lastDetectedPromptId !== promptId) return null
    return state.lastDetectedPromptKind
  }

  /**
   * Return pending (unresponded) trust prompt events for all windows.
   *
   * Called by the WebSocket connection handler to replay events to newly
   * connected clients. Without this, events broadcast before any client
   * connects are lost (the detector sets `lastDetectedPromptId` and
   * never re-broadcasts).
   */
  getPendingPrompts(): ServerToClientEvent[] {
    const events: ServerToClientEvent[] = []
    for (const [windowName, state] of this.states) {
      if (!state.lastDetectedPromptId) continue

      const capture = this.tmux.capturePane(windowName, CAPTURE_LINES)
      if (!capture) continue

      // Determine whether this was a pattern-match detection or a fallback
      // by re-running the matcher against the current capture.
      const matched = this.matcher.match(capture)
      if (matched) {
        // Replay must use the same on-screen-resolved choice list as
        // the original broadcast — otherwise reconnecting clients see
        // stale `keys` (see comment in `detectForWindow`).
        const choicesForUi = resolveChoicesForUi(matched.pattern, capture)
        // Keep the retained kind in sync with the current match so the WS
        // gate stays correct after a reconnect-driven re-resolution (§7.8.4).
        state.lastDetectedPromptKind = matched.pattern.kind
        const payload: TrustPromptDetectedPayload = {
          promptId: state.lastDetectedPromptId,
          windowName,
          kind: matched.pattern.kind,
          patternId: matched.pattern.id,
          detail: matched.extracted,
          degenerate: matched.degenerate,
          choices: choicesForUi,
          rawBuffer: tailLines(capture, RAW_BUFFER_DETECTED_TAIL_LINES),
        }
        events.push({ type: 'trust_prompt_detected', payload })
      } else {
        // Fallback — pattern no longer matches but the prompt is still pending
        const payload: TrustPromptFallbackPayload = {
          promptId: state.lastDetectedPromptId,
          windowName,
          rawBuffer: tailLines(capture, RAW_BUFFER_FALLBACK_TAIL_LINES),
        }
        events.push({ type: 'trust_prompt_fallback', payload })
      }
    }
    return events
  }

  // ===== Internal implementation =====

  /** Synchronize state with current tmux session windows */
  private refreshWindows(): void {
    if (!this.tmux.hasSession()) {
      if (this.states.size > 0) this.states.clear()
      if (this.suppressedHashes.size > 0) this.suppressedHashes.clear()
      return
    }

    const windows = this.tmux.listWindows()
    const liveNames = new Set(
      windows.map((w) => w.name).filter((n) => n !== 'main'),
    )

    // Remove disappeared windows
    for (const name of Array.from(this.states.keys())) {
      if (!liveNames.has(name)) {
        this.states.delete(name)
        if (this.debug) {
          trustLogger.debug({ windowName: name }, 'state removed')
        }
      }
    }
    // Drop suppression entries for windows that no longer exist —
    // a fresh window with the same name (next test's fake-claude)
    // should be evaluated against its own content, not against the
    // hash of a window that has since been killed.
    for (const name of Array.from(this.suppressedHashes.keys())) {
      if (!liveNames.has(name)) {
        this.suppressedHashes.delete(name)
      }
    }

    // Add new windows
    for (const name of liveNames) {
      if (!this.states.has(name)) {
        this.states.set(name, {
          lastCaptureHash: '',
          consecutiveIdleCount: 0,
          lastDetectedPromptId: null,
          lastChoices: [],
          lastDetectedPromptKind: null,
        })
        if (this.debug) {
          trustLogger.debug({ windowName: name }, 'state added')
        }
      }
    }
  }

  /** Execute one tick of detection across all windows */
  private tick(): void {
    for (const [windowName, state] of this.states) {
      try {
        this.detectForWindow(windowName, state)
      } catch (err) {
        trustLogger.error({ err, windowName }, 'detectForWindow error')
      }
    }
  }

  private detectForWindow(windowName: string, state: DetectorState): void {
    const capture = this.tmux.capturePane(windowName, CAPTURE_LINES)
    if (!capture) return

    // Normalize the bullet spinner before hashing so the idle counter
    // is not reset by decorative animation (see normalizeForIdleHash).
    // Pattern matching below still operates on the unmodified capture.
    const hash = simpleHash(normalizeForIdleHash(capture))

    // Post-reset re-detection guard (`suppressedHashes`).
    //
    // If `resetState()` recorded a hash for this window and the
    // current capture still matches, the leftover content from the
    // previous test has not yet changed — bypass detection so we do
    // not re-fire `trust_prompt_detected` on a stale "Yes/No" prompt.
    // We still update `lastCaptureHash` so the idle counter does not
    // race ahead while the pane is being torn down.
    //
    // The first capture that *differs* from the suppressed hash
    // releases the suppression for that window: we drop the entry and
    // fall through to the normal change-detected branch below, which
    // produces a `trust_prompt_resolved` if a stale prompt id was
    // pending. From the next tick onward, normal detection applies.
    const suppressed = this.suppressedHashes.get(windowName)
    if (suppressed !== undefined) {
      if (suppressed === hash) {
        state.lastCaptureHash = hash
        state.consecutiveIdleCount = 0
        return
      }
      // Pane mutated since reset → release the suppression and fall
      // through. The mutated capture itself is processed below as a
      // normal "changed" tick.
      this.suppressedHashes.delete(windowName)
    }

    const changed = hash !== state.lastCaptureHash

    if (changed) {
      state.lastCaptureHash = hash
      state.consecutiveIdleCount = 0

      // If capture changed, consider the previously notified prompt as "resolved"
      if (state.lastDetectedPromptId) {
        this.broadcast({
          type: 'trust_prompt_resolved',
          payload: { promptId: state.lastDetectedPromptId, windowName },
        })
        if (this.debug) {
          trustLogger.debug(
            { promptId: state.lastDetectedPromptId },
            'resolved (capture changed)',
          )
        }
        state.lastDetectedPromptId = null
        state.lastChoices = []
        state.lastDetectedPromptKind = null
      }
      return
    }

    // No capture change → increment idle count
    state.consecutiveIdleCount += 1

    // Do nothing if idle threshold not yet reached
    if (state.consecutiveIdleCount < IDLE_CONFIRMATIONS) return

    // Do nothing if already notified (waiting for response)
    if (state.lastDetectedPromptId) return

    // Exclusion: ignore normal input waiting, processing, and thinking states
    if (this.isExcluded(capture)) return

    // Pattern match (S-1)
    const matched = this.matcher.match(capture)
    if (matched) {
      const promptId = generatePromptId(windowName)
      state.lastDetectedPromptId = promptId

      // Resolve choices via the v1.2 three-tier strategy:
      //   1. Dynamic extraction (TP-1, spec §4-1-4) — every numbered row
      //      Claude Code printed becomes a button. This catches prompt
      //      variants the static patterns never knew about (e.g. the
      //      bash "don't ask again for: <cmd>" row).
      //   2. labelPattern resolution (legacy) — when dynamic extraction
      //      finds nothing on screen, attempt to map the static
      //      pattern's labelPattern entries to remaining visible rows.
      //   3. Static pattern choices — last-resort fallback for callers
      //      with truncated captures or offline fixtures.
      const choicesForUi = resolveChoicesForUi(matched.pattern, capture)
      if (
        choicesForUi === matched.pattern.choices &&
        matched.pattern.choices.some((c) => c.labelPattern)
      ) {
        trustLogger.warn(
          {
            patternId: matched.pattern.id,
            windowName,
            footer: lastNonEmptyLine(capture),
          },
          'visible-choices extraction failed; falling back to static keys',
        )
      }

      state.lastChoices = choicesForUi
      // Retain the matched kind per window so the WS gate can enforce the
      // multi-question-unsupported response restriction (§7.8.5 / §10.7.6).
      state.lastDetectedPromptKind = matched.pattern.kind
      const payload: TrustPromptDetectedPayload = {
        promptId,
        windowName,
        kind: matched.pattern.kind,
        patternId: matched.pattern.id,
        detail: matched.extracted,
        degenerate: matched.degenerate,
        choices: choicesForUi,
        rawBuffer: tailLines(capture, RAW_BUFFER_DETECTED_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_detected', payload })
      if (this.debug) {
        trustLogger.debug(
          { patternId: matched.pattern.id, windowName, degenerate: matched.degenerate },
          'matched',
        )
        this.writeDump(windowName, capture, {
          trigger: 'detected',
          patternId: matched.pattern.id,
          kind: matched.pattern.kind,
          extracted: matched.extracted,
          degenerate: matched.degenerate,
          footerLine: lastNonEmptyLine(capture),
        })
      }
      return
    }

    // No pattern match + footer match → route to fallback UX (S-2)
    if (this.hasTrustFooter(capture)) {
      const promptId = generatePromptId(windowName, 'fallback')
      state.lastDetectedPromptId = promptId
      state.lastChoices = [] // Only raw-keys responses accepted in fallback
      // Fallback is not a pattern match — no kind to retain (§7.8.5).
      state.lastDetectedPromptKind = null
      const payload: TrustPromptFallbackPayload = {
        promptId,
        windowName,
        rawBuffer: tailLines(capture, RAW_BUFFER_FALLBACK_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_fallback', payload })

      // R2-4: Always log raw pane content on fallback so that unregistered
      // patterns can be identified and added later (DEC-014 v1.3 Phase 1).
      const rawTail = capture.split('\n').slice(-RAW_BUFFER_FALLBACK_TAIL_LINES)
      trustLogger.info(
        { windowName, paneTail: rawTail },
        'Fallback fired (no known pattern matched)',
      )

      if (this.debug) {
        trustLogger.debug({ windowName }, 'fallback (unknown pattern)')
        this.writeDump(windowName, capture, {
          trigger: 'fallback',
          patternId: null,
          kind: null,
          extracted: null,
          degenerate: false,
          footerLine: lastNonEmptyLine(capture),
        })
      }
    }
  }

  private isExcluded(capture: string): boolean {
    const tail = tailLines(capture, EXCLUDE_CHECK_TAIL_LINES)
    return EXCLUDE_PATTERNS.some((r) => r.test(tail))
  }

  private hasTrustFooter(capture: string): boolean {
    const line = lastNonEmptyLine(capture)
    return TRUST_FOOTER_PATTERNS.some((r) => r.test(line))
  }

  // ===== Debug dump (Phase 5e) =====

  /**
   * Output a dump file when a detection event fires.
   * Only called when `KOVITOBOARD_DEBUG_TRUST=1` is enabled.
   *
   * Dump location: `.kovitoboard/debug/trust-prompt/{timestamp}-{windowName}.json`
   * Conforming to spec §7-1 / §8-3.
   */
  private writeDump(
    windowName: string,
    capture: string,
    result: {
      trigger: 'detected' | 'fallback'
      patternId: string | null
      kind: string | null
      extracted: Record<string, string | null> | null
      degenerate: boolean
      footerLine: string
    },
  ): void {
    if (!this.fs || !this.debugDumpDir) return

    try {
      // Ensure directory exists (first time only)
      if (!this.debugDumpDirEnsured) {
        this.fs.mkdirSync(this.debugDumpDir, { recursive: true })
        // Set directory permissions to 0700 (spec §8-3: sensitive data protection)
        // Using Node.js fs directly since fs-layer lacks chmod (best-effort for debug only)
        try {
          chmodSync(this.debugDumpDir, 0o700)
        } catch (err) {
          // Continue dumping even if permission change fails (e.g.
          // Windows-style filesystems where chmod is a no-op).
          trustLogger.info(
            { err, dir: this.debugDumpDir },
            'chmod skipped on debug dir (non-fatal)',
          )
        }
        // Drop a README that warns the user about the sensitivity of
        // the dumps in this directory. We write it once on first use
        // so it is co-located with the actual dumps and impossible to
        // miss for anyone exploring the directory.
        this.writeDebugReadmeOnce()
        this.debugDumpDirEnsured = true
      }

      const now = new Date()
      const ts = now.toISOString().replace(/[:.]/g, '-')
      // Sanitize windowName in case it contains invalid filename characters
      const safeName = windowName.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filename = `${ts}-${safeName}.json`
      const filepath = `${this.debugDumpDir}/${filename}`

      const dump = {
        timestamp: now.toISOString(),
        windowName,
        trigger: result.trigger,
        match: {
          patternId: result.patternId,
          kind: result.kind,
          extracted: result.extracted,
          degenerate: result.degenerate,
        },
        footerLine: result.footerLine,
        excludeMatched: EXCLUDE_PATTERNS.map((r) => ({
          pattern: r.source,
          matched: r.test(capture),
        })),
        footerPatterns: TRUST_FOOTER_PATTERNS.map((r) => ({
          pattern: r.source,
          matched: r.test(result.footerLine),
        })),
        captureBuffer: capture,
        _warning:
          'This file contains the raw tmux buffer. ' +
          'It may include sensitive information (passwords, tokens, etc.). ' +
          'Please review the contents before pasting into an issue.',
      }

      this.fs.writeFileSync(filepath, JSON.stringify(dump, null, 2), 'utf-8')
      trustLogger.debug({ filename }, 'dump written')
    } catch (err) {
      trustLogger.error({ err }, 'dump write failed')
    }
  }

  /**
   * Write a one-shot README.md alongside the debug dumps explaining
   * what is in the directory and how to handle the contents safely
   * (DEC-017 audit P7-A-3). The dumps include raw tmux buffer
   * captures which can contain pasted secrets — we want anyone
   * stumbling onto the directory to see the warning before they
   * forward a file to a public issue.
   *
   * Skips silently if the README already exists.
   */
  private writeDebugReadmeOnce(): void {
    if (!this.fs || !this.debugDumpDir) return
    const readmePath = `${this.debugDumpDir}/README.md`
    try {
      if (this.fs.existsSync(readmePath)) return
      const body =
        '# Trust-Prompt Debug Dumps\n\n' +
        '> **WARNING — Privacy-sensitive content**\n' +
        '\n' +
        'This directory contains raw tmux buffer captures from the\n' +
        'trust-prompt detector. Captures may include:\n' +
        '\n' +
        '- File paths (full home directory paths)\n' +
        '- Pasted content (passwords, tokens, API keys)\n' +
        '- Command output (process IDs, environment values)\n' +
        '\n' +
        '**Before sharing any file from this directory** (e.g. attaching\n' +
        'to a GitHub Issue), please **review the contents manually** and\n' +
        'redact any sensitive information.\n' +
        '\n' +
        'The home directory path is automatically masked to `~`, but\n' +
        'other sensitive content is your responsibility.\n' +
        '\n' +
        'To disable debug dumps, unset `KOVITOBOARD_DEBUG_TRUST` and\n' +
        'remove this directory.\n'
      this.fs.writeFileSync(readmePath, body, 'utf-8')
      trustLogger.debug({ readmePath }, 'debug-dump README created')
    } catch (err) {
      // Non-fatal: dumps still work without the README.
      trustLogger.warn({ err, readmePath }, 'Failed to write debug-dump README')
    }
  }
}

// =========================
// Utilities
// =========================

/** Return the last non-empty line from the end of capture */
export function lastNonEmptyLine(capture: string): string {
  const lines = capture.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i]
  }
  return ''
}

/** Join and return the last n lines of capture */
export function tailLines(capture: string, n: number): string {
  const lines = capture.split('\n')
  return lines.slice(-n).join('\n')
}

/** Lightweight string hash (for change detection only; collision resistance not required) */
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

/**
 * Normalize a capture before hashing for idle detection.
 *
 * Claude Code draws an activity bullet at the start of certain lines
 * (e.g. "● Reading 1 file…") and toggles it on and off roughly every
 * 600 ms as a visual spinner — even while the user is parked on a
 * trust prompt. Without normalization the raw hash flips on every
 * frame of the spinner, the idle counter never crosses its threshold
 * for long enough, and the fallback modal ends up flickering in and
 * out of view as the detector repeatedly fires `trust_prompt_fallback`
 * followed by `trust_prompt_resolved`.
 *
 * We only touch the hash input here; pattern matching and footer
 * detection still see the unmodified capture, so matchers that look
 * for `^● ...` lines keep working.
 */
export function normalizeForIdleHash(capture: string): string {
  // Claude Code toggles "● Reading 1 file…" and "  Reading 1 file…"
  // (leading bullet on / off) as a visual spinner. Replace the bullet
  // with a plain space so the ON frame hashes the same as the OFF
  // frame, which the terminal renders with two leading spaces.
  return capture.replace(/^(\s*)●(\s)/gm, '$1 $2')
}

function generatePromptId(windowName: string, prefix = 'prompt'): string {
  return `${prefix}:${windowName}:${Date.now().toString(36)}`
}
