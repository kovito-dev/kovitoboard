/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * kb-authored-message — detect the KovitoBoard-authored portions of a
 * user message so the chat surfaces can render them as collapsible
 * summary chips instead of dumping their raw text. Output:
 *
 *   { sections: KbSection[]; userInput: string }
 *
 * `sections` is empty when the message contains no rule-line sentinel
 * blocks — callers fall back to plain text rendering in that case.
 *
 * Detection is sentinel-only as of v0.2.0 (spec
 * `kb-authored-sentinel.md` v1.3 §11.3, K-15 cutover). The previous
 * `parseLegacyAnchors` ladder (whole-message anchors / fenced
 * `kbcontext` / `a11y` / `Selected` / `ExposedContext` blocks) and the
 * v1.0 HTML-comment sentinel fallback have both been removed; v0.1.x
 * JSONL written without the rule-line sentinel renders as raw user
 * input (an accepted degrade — v0.1.x had no long-term users, see spec
 * §11.3).
 */
import type { KbAuthoredType } from '../../shared/kb-authored-sentinel'

/**
 * Restore escaped `\n` / `\t` literals (2-char sequences) back to real
 * newlines and tabs. Server-side `tmux-bridge.sendViaBuffer` rewrites
 * outgoing real newlines into literal `\n` to keep tmux paste happy
 * (so multi-line input never gets aggregated into a stray "[Pasted
 * text]" placeholder), and that sanitized form is what ends up stored
 * in Claude's session JSONL — and therefore in `event.content.text`
 * the renderer reads back. The display layer (UserMessageText) does
 * the same restoration before showing the text; we mirror it here so
 * the parser sees the original line structure that the rule-line
 * sentinel regex expects.
 */
function restoreEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

/**
 * Renderer-facing kind union. Mirrors `KbAuthoredType` in
 * `shared/kb-authored-sentinel.ts` and is used by the chip renderer
 * to look up icons / i18n labels. Kept as a separate alias so an
 * unknown sentinel type (Claude Code or a future KB version emitting
 * an unrecognized kind) does not crash the parser — `parseSentinelBlocks`
 * coerces unknown kinds to `'other'` so the chip still appears, just
 * with the generic icon.
 */
export type KbSectionKind = KbAuthoredType

export interface KbSection {
  kind: KbSectionKind
  /** The original text of this section (used when expanded). */
  content: string
  /** Optional label parsed from the sentinel header, e.g. the recipe
   *  name for `recipe-install` or the short session id for
   *  `continue-session`. */
  label?: string
}

export interface ParsedKbMessage {
  sections: KbSection[]
  /** The leftover text after KB-authored sections are removed.
   *  Empty for whole-message types (recipe-install / app-create). */
  userInput: string
}

/**
 * Known KbSectionKind values (subset of `KbAuthoredType` we treat as
 * structurally typed by the renderer). Anything outside this set
 * coming over the wire (e.g. a future KB version emitting a new
 * type the current renderer does not yet know about) is downgraded
 * to `'other'` so the chip still renders without crashing.
 */
const KNOWN_KINDS = new Set<KbSectionKind>([
  'preamble',
  'kbcontext',
  'a11y',
  'exposed-context',
  'selected',
  'recipe-install',
  'app-create',
  'continue-session',
  'skill-base-dir',
  'other',
])

/**
 * Rule-line sentinel block extractor (spec §6.1).
 *
 * Block format:
 *   `━━━━━ KovitoBoard:<kind>[:<label>] ━━━━━\n<content>\n━━━━━ KovitoBoard:end ━━━━━`
 *
 * The header captures `kind` (group 1) and an optional label
 * (group 2). The label is everything between the first `:` after
 * the kind and the trailing rule, exclusive of the surrounding
 * spaces. The body capture `[\s\S]*?` is non-greedy so consecutive
 * blocks match independently; `(?:.|\s)` is avoided because it
 * regresses to catastrophic backtracking on long inputs in some
 * engines.
 */
const SENTINEL_BLOCK =
  /━━━━━ KovitoBoard:([\w-]+)(?::([^\n]*?))? ━━━━━\n?([\s\S]*?)\n?━━━━━ KovitoBoard:end ━━━━━/g

interface SentinelHit {
  start: number
  end: number
  section: KbSection
}

/**
 * Coerce a raw kind token coming off the wire into a known
 * `KbSectionKind`, falling through to `'other'` so unknown future
 * types still surface as a chip (with the generic icon) instead of
 * throwing on icon lookup. The wire-level identifier is preserved
 * in the section's `content` for inspection in the expanded view.
 */
function coerceKind(rawKind: string): KbSectionKind {
  return KNOWN_KINDS.has(rawKind as KbSectionKind)
    ? (rawKind as KbSectionKind)
    : 'other'
}

/**
 * Detect KB-authored sentinel blocks and slice them out of the
 * message. Returns `null` when no sentinel block is present so the
 * caller can render the original text verbatim (the fallback to a
 * legacy-anchor ladder was removed in v0.2.0 — spec §11.3).
 */
function parseSentinelBlocks(text: string): ParsedKbMessage | null {
  const hits: SentinelHit[] = []
  for (const m of text.matchAll(SENTINEL_BLOCK)) {
    if (m.index === undefined) continue
    const kind = coerceKind(m[1])
    const label = m[2] !== undefined && m[2].length > 0 ? m[2] : undefined
    const content = m[3] ?? ''
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind, content, label },
    })
  }
  if (hits.length === 0) return null

  hits.sort((a, b) => a.start - b.start)
  const sections: KbSection[] = []
  const remainder: string[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) remainder.push(text.slice(cursor, hit.start))
    sections.push(hit.section)
    cursor = hit.end
  }
  if (cursor < text.length) remainder.push(text.slice(cursor))

  const userInput = remainder.join('').replace(/\n{3,}/g, '\n\n').trim()
  return { sections, userInput }
}

/**
 * Parse a user message and pull out KovitoBoard-authored sections.
 * Returns the per-section breakdown plus whatever user-typed text
 * remains.
 *
 * Detection (spec §7.3 v0.2.0):
 *   - Rule-line sentinel blocks are extracted.
 *   - Anything outside a sentinel becomes `userInput`.
 *
 * v0.1.x JSONL written without rule-line sentinels (only legacy
 * fenced / anchor patterns) renders as `userInput` — the accepted
 * degrade documented in spec §11.3.
 */
export function parseKbAuthoredSections(rawText: string): ParsedKbMessage {
  // Undo the tmux-bridge sanitization (real newlines → `\n` literals)
  // before pattern matching. Idempotent: real newlines pass through
  // unchanged because there is no `\n` 2-char sequence to replace.
  const text = restoreEscapedNewlines(rawText)

  const sentinelResult = parseSentinelBlocks(text)
  if (sentinelResult) return sentinelResult

  // No sentinel blocks present → render the text verbatim.
  return { sections: [], userInput: text }
}
