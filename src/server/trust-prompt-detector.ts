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

/** Detection polling interval (ms). Spec §4-2-1 */
export const POLL_INTERVAL_MS = 200

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
 */
const TRUST_FOOTER_PATTERNS: RegExp[] = [
  /Esc to cancel · Tab to amend/, // Write / Edit / Bash
  /Enter to confirm · Esc to cancel/, // Folder Trust
  /ctrl\+e to explain/, // Bash-specific additional footer
  /tell Claude what to do differently/, // Sandbox Network Escape
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
  /** Footer regex for matching last non-empty line (pre-filter) */
  footer: RegExp
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
 * Only `patterns` is required. `version` / `compatibleClaudeCodeVersions`
 * are for informational display in v0.1.0 with no runtime validation
 * (to be added in v0.2.0+).
 */
interface TrustPatternFile {
  version?: string
  compatibleClaudeCodeVersions?: string[]
  patterns: RawTrustPattern[]
}

/**
 * A single pattern as stored in JSON. Regex fields are stored as strings.
 * The loader compiles them to `RegExp` with the multiline flag (`m`) always set.
 */
interface RawTrustPattern {
  id: string
  kind: TrustPromptKind
  priority: number
  matchAny: string[]
  footer: string
  extract?: Record<string, string>
  degenerateForms?: string[]
  choices: TrustPromptChoice[]
}

/**
 * Load `trust-patterns.json` and compile it into `TrustPattern[]`.
 *
 * Throws on failure to prevent the server from starting with an empty detection loop
 * (where all prompts would fall through to fallback with 0 patterns).
 *
 * @param fs   FileAccessLayer (fs abstraction introduced in Phase 4)
 * @param path Absolute path to the JSON file
 */
export function loadTrustPatterns(fs: FileAccessLayer, path: string): TrustPattern[] {
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

  return parsed.patterns.map((raw) => compileTrustPattern(raw, path))
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
  if (typeof raw.footer !== 'string') {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" is missing footer (${path})`,
    )
  }
  if (!Array.isArray(raw.choices)) {
    throw new Error(
      `trust-patterns.json pattern "${raw.id}" choices is not an array (${path})`,
    )
  }

  try {
    return {
      id: raw.id,
      kind: raw.kind,
      priority: raw.priority,
      matchAny: raw.matchAny.map((s) => new RegExp(s, 'm')),
      footer: new RegExp(raw.footer, 'm'),
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

    // Filter candidates by footer (optimization)
    const candidates = this.patterns.filter((p) => p.footer.test(footerLine))
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
      console.error('[trust-detector] loop started')
    }
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
    const state = this.states.get(windowName)
    if (!state) {
      console.warn(`[trust-detector] unknown window: ${windowName}`)
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      console.warn(
        `[trust-detector] promptId mismatch (discarded): expected=${state.lastDetectedPromptId} got=${promptId}`,
      )
      return false
    }
    const choice = state.lastChoices.find((c) => c.id === choiceId)
    if (!choice) {
      console.warn(
        `[trust-detector] unknown choiceId: ${choiceId} (available: ${state.lastChoices.map((c) => c.id).join(', ')})`,
      )
      return false
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
      console.warn(`[trust-detector] unknown window: ${windowName}`)
      return false
    }
    if (state.lastDetectedPromptId !== promptId) {
      console.warn(
        `[trust-detector] promptId mismatch (discarded): expected=${state.lastDetectedPromptId} got=${promptId}`,
      )
      return false
    }
    if (rawKeys.length > 1024) {
      console.warn(`[trust-detector] raw-keys too long (${rawKeys.length}): discarded`)
      return false
    }
    return this.tmux.sendTrustPromptKeys(windowName, rawKeys, true)
  }

  // ===== Internal implementation =====

  /** Synchronize state with current tmux session windows */
  private refreshWindows(): void {
    if (!this.tmux.hasSession()) {
      if (this.states.size > 0) this.states.clear()
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
          console.error(`[trust-detector] state removed: ${name}`)
        }
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
        })
        if (this.debug) {
          console.error(`[trust-detector] state added: ${name}`)
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
        console.error(`[trust-detector] detectForWindow error (${windowName}):`, err)
      }
    }
  }

  private detectForWindow(windowName: string, state: DetectorState): void {
    const capture = this.tmux.capturePane(windowName, CAPTURE_LINES)
    if (!capture) return

    const hash = simpleHash(capture)
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
          console.error(
            `[trust-detector] resolved (capture changed): ${state.lastDetectedPromptId}`,
          )
        }
        state.lastDetectedPromptId = null
        state.lastChoices = []
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
      state.lastChoices = matched.pattern.choices
      const payload: TrustPromptDetectedPayload = {
        promptId,
        windowName,
        kind: matched.pattern.kind,
        patternId: matched.pattern.id,
        detail: matched.extracted,
        degenerate: matched.degenerate,
        choices: matched.pattern.choices,
        rawBuffer: tailLines(capture, RAW_BUFFER_DETECTED_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_detected', payload })
      if (this.debug) {
        console.error(
          `[trust-detector] matched: ${matched.pattern.id} on ${windowName} (degenerate=${matched.degenerate})`,
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
      const payload: TrustPromptFallbackPayload = {
        promptId,
        windowName,
        rawBuffer: tailLines(capture, RAW_BUFFER_FALLBACK_TAIL_LINES),
      }
      this.broadcast({ type: 'trust_prompt_fallback', payload })
      if (this.debug) {
        console.error(`[trust-detector] fallback (unknown pattern) on ${windowName}`)
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
        } catch {
          // Continue dumping even if permission change fails
        }
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
      console.error(`[trust-detector] dump written: ${filename}`)
    } catch (err) {
      console.error('[trust-detector] dump write failed:', err)
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

function generatePromptId(windowName: string, prefix = 'prompt'): string {
  return `${prefix}:${windowName}:${Date.now().toString(36)}`
}
