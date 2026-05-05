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
 * `sections` is empty when none of the known patterns match — callers
 * fall back to plain text rendering in that case.
 *
 * The patterns mirror the *outgoing* construction sites:
 *
 *   - sidebar (`useSidebarContext.ts` / `AmbientSidebar.composePayload`):
 *     SYSTEM_PROMPT_PREAMBLE → ` ```kbcontext ` → ` ```a11y ` →
 *     `[Selected] ...` → ` ```ExposedContext ` → user text
 *   - recipe-install (`recipe-applicator.buildRecipePrompt`):
 *     `KovitoBoard Recipe Application: "<name>" v<version>` ...
 *     (whole message is KB-authored, no user text)
 *   - app-create (`shared/app-creation-prompt.buildAppCreationPrompt`):
 *     `KovitoBoard App Creation Request` ...
 *     (whole message is KB-authored, no user text)
 */
import { SYSTEM_PROMPT_PREAMBLE } from '../hooks/useSidebarContext'
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
 * the parser sees the original line structure and SYSTEM_PROMPT_PREAMBLE
 * / fenced-block patterns line up.
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
  /** For recipe-install: the recipe name extracted from the header. */
  label?: string
}

export interface ParsedKbMessage {
  sections: KbSection[]
  /** The leftover text after KB-authored sections are removed.
   *  Empty for whole-message types (recipe-install / app-create). */
  userInput: string
}

const APP_CREATE_ANCHOR = 'KovitoBoard App Creation Request'

/**
 * Anchor for the "continue from previous session" handover message
 * (built by `format.ts:buildContinueSessionMessage`). The message is a
 * fixed English template — `Please continue working from the previous
 * session (xxxxxxxx).` followed by a `<previous-session>` block — so
 * we match the opening sentence to identify it and capture the short
 * session ID for the chip label.
 */
const CONTINUE_SESSION_ANCHOR =
  /^Please continue working from the previous session \(([^)]+)\)\./
/**
 * v2.0 anchor for the recipe install handover prompt
 * (recipe-applicator.RECIPE_INSTALL_HEADER). The prompt no longer
 * embeds the recipe name in the header line — it lives under
 * `### name` in the body — so we extract the label via a separate
 * regex on the parsed text.
 *
 * Legacy v1.x prompts began with `KovitoBoard Recipe Application: "<name>" v<version>`;
 * we keep matching that form so historical messages in old sessions
 * still render as collapsible chips after the upgrade.
 */
const RECIPE_INSTALL_ANCHOR_V2 = /^KovitoBoard Recipe Installation Request/
const RECIPE_INSTALL_ANCHOR_V1 = /^KovitoBoard Recipe Application: "([^"]+)" v[^\s]+/
const RECIPE_INSTALL_NAME_BLOCK = /^### name\s*$\n+([^\n]+)/m

/** Match a fenced block by its info string (`kbcontext`, `a11y`,
 *  `ExposedContext`). The body is captured but not used here — the
 *  full fence (including the surrounding ``` lines) is preserved as
 *  the section's `content` so the expanded view shows the original. */
function fencedBlockRegex(info: string): RegExp {
  // Non-greedy so multiple fenced blocks in the same message are
  // matched separately; anchored to a fence-only line on both sides.
  const escaped = info.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp('```' + escaped + '\\n[\\s\\S]*?\\n```', 'g')
}

const FENCE_KBCONTEXT = fencedBlockRegex('kbcontext')
const FENCE_A11Y = fencedBlockRegex('a11y')
const FENCE_EXPOSED = fencedBlockRegex('ExposedContext')
// `Selected` is also emitted as a fenced block by `describePickedElement`
// (`['```Selected', ...lines, '```'].join('\n')`). Earlier drafts of the
// spec described it as a `[Selected]`-prefixed paragraph; the runtime
// code is the source of truth.
const FENCE_SELECTED = fencedBlockRegex('Selected')

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
 * Rule-line sentinel block extractor (spec v2.0).
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
 *
 * Spec §3.2 — kept stable so parser fixtures cross-reference both
 * sides of the wire.
 */
const SENTINEL_BLOCK =
  /━━━━━ KovitoBoard:([\w-]+)(?::([^\n]*?))? ━━━━━\n?([\s\S]*?)\n?━━━━━ KovitoBoard:end ━━━━━/g

/**
 * Transitional fallback: the v1.0 HTML-comment sentinel form. Kept
 * as a secondary detector so any JSONL written between `ca7d225`
 * (v1.0 dual-write rollout) and the v2.0 rule-line cutover still
 * chip-collapses correctly. New construction sites must emit the
 * rule-line form; this regex is read-only. The legacy form used
 * the `label="…"` attribute syntax, so the matcher returns the
 * raw attr string in group 2 for downstream extraction by
 * `LEGACY_HTML_ATTR`.
 */
const SENTINEL_BLOCK_HTML_LEGACY =
  /<!-- KB:auto-msg type=([\w-]+)((?:\s+[^>]*?)?) -->\n?([\s\S]*?)\n?<!-- KB:auto-msg-end -->/g

const LEGACY_HTML_ATTR = /(\w+)="((?:[^"\\]|\\.)*)"/g

/** Reverse the `\\"` / `\\\\` escapes the v1.0 legacy form used. */
function unescapeLegacyHtmlAttrValue(raw: string): string {
  // `\\"` → `"` first to handle `\\\\"` correctly, then `\\\\` → `\\`.
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

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
 * Collect sentinel hits using the v2.0 rule-line regex. The label
 * comes from regex group 2 (the optional `:<label>` segment) and
 * needs no further parsing.
 */
function collectRuleLineHits(text: string): SentinelHit[] {
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
  return hits
}

/**
 * Collect sentinel hits using the v1.0 HTML-comment regex. The
 * legacy form keeps `label` inside a `key="value"` block, so we
 * walk the attr regex to extract it and unescape afterwards.
 */
function collectLegacyHtmlHits(text: string): SentinelHit[] {
  const hits: SentinelHit[] = []
  for (const m of text.matchAll(SENTINEL_BLOCK_HTML_LEGACY)) {
    if (m.index === undefined) continue
    const kind = coerceKind(m[1])
    const attrText = m[2] ?? ''
    const content = m[3] ?? ''
    const attrs: Record<string, string> = {}
    for (const am of attrText.matchAll(LEGACY_HTML_ATTR)) {
      attrs[am[1]] = unescapeLegacyHtmlAttrValue(am[2])
    }
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind, content, label: attrs.label },
    })
  }
  return hits
}

/**
 * Detect KB-authored sentinel blocks and slice them out of the
 * message. Returns null when no sentinel is present so the caller
 * can fall through to the legacy anchor detector. Returning a
 * `ParsedKbMessage` with an empty `sections` array would otherwise
 * suppress the legacy detector entirely.
 *
 * v2.0 rule-line sentinels are tried first; if none match we try the
 * v1.0 HTML-comment form so JSONL written between `ca7d225` and the
 * v2.0 cutover still chip-collapses correctly.
 */
function parseSentinelBlocks(text: string): ParsedKbMessage | null {
  let hits = collectRuleLineHits(text)
  if (hits.length === 0) {
    hits = collectLegacyHtmlHits(text)
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
 * Detection priority (spec §3.1):
 *   1. KB-authored sentinel blocks (v1.0+, dual-write era).
 *   2. Legacy anchor heuristics (v0.0.x output, older JSONL).
 *
 * Detection is best-effort: a message that doesn't match any known
 * pattern returns `{ sections: [], userInput: text }`, which callers
 * treat as "render normally".
 */
export function parseKbAuthoredSections(rawText: string): ParsedKbMessage {
  // Undo the tmux-bridge sanitization (real newlines → `\n` literals)
  // before pattern matching. Idempotent: real newlines pass through
  // unchanged because there is no `\n` 2-char sequence to replace.
  const text = restoreEscapedNewlines(rawText)

  // Sentinel detector — short-circuits when at least one block is
  // present. Falling back below preserves chip rendering for
  // pre-sentinel messages stored in older JSONLs.
  const sentinelResult = parseSentinelBlocks(text)
  if (sentinelResult) return sentinelResult

  return parseLegacyAnchors(text)
}

/**
 * Pre-sentinel detection path. Kept as a named function so the
 * sentinel-aware entry point can fall through to it cleanly and so
 * the legacy logic can be exercised in isolation by unit tests.
 *
 * Refactor note: the body of `parseLegacyAnchors` is the unchanged
 * v1.x detection ladder (whole-message anchors → composite peel).
 * No behavioral changes beyond the sentinel short-circuit above.
 */
function parseLegacyAnchors(text: string): ParsedKbMessage {
  // -----------------------------------------------------------------
  // 1) Whole-message types (no user-typed text mixed in)
  // -----------------------------------------------------------------
  if (text.startsWith(APP_CREATE_ANCHOR)) {
    return {
      sections: [{ kind: 'app-create', content: text }],
      userInput: '',
    }
  }
  const continueMatch = text.match(CONTINUE_SESSION_ANCHOR)
  if (continueMatch) {
    return {
      sections: [
        {
          kind: 'continue-session',
          content: text,
          // Short session ID (8 chars) Captured by the regex; the
          // chip uses it to label the collapsed view, e.g. "Continued
          // from session 988e0a43".
          label: continueMatch[1],
        },
      ],
      userInput: '',
    }
  }
  if (RECIPE_INSTALL_ANCHOR_V2.test(text)) {
    const nameMatch = text.match(RECIPE_INSTALL_NAME_BLOCK)
    return {
      sections: [{ kind: 'recipe-install', content: text, label: nameMatch?.[1]?.trim() }],
      userInput: '',
    }
  }
  const legacyRecipeMatch = text.match(RECIPE_INSTALL_ANCHOR_V1)
  if (legacyRecipeMatch) {
    return {
      sections: [{ kind: 'recipe-install', content: text, label: legacyRecipeMatch[1] }],
      userInput: '',
    }
  }

  // -----------------------------------------------------------------
  // 2) Composite messages (sidebar-origin payloads)
  //
  // Strategy: peel known sections off `working`, in the order
  // `composePayload` puts them in. Each peel deletes the matched
  // span so we can return `working` (trimmed) as `userInput`. The
  // resulting `sections` keeps the appearance order so the UI stays
  // visually consistent across messages.
  // -----------------------------------------------------------------
  const sections: KbSection[] = []
  let working = text

  // 2a) SYSTEM_PROMPT_PREAMBLE — anchored at start. The preamble itself
  //     contains blank lines, so we cannot split on `\n\n`; instead we
  //     match the preamble against the canonical constant exported by
  //     useSidebarContext and slice exactly its length. Drop the
  //     `parts.join('\n\n')` separator that follows.
  if (working.startsWith(SYSTEM_PROMPT_PREAMBLE)) {
    sections.push({ kind: 'preamble', content: SYSTEM_PROMPT_PREAMBLE })
    working = working.slice(SYSTEM_PROMPT_PREAMBLE.length).replace(/^\n+/, '')
  }

  // 2b) Fenced blocks (kbcontext / a11y / ExposedContext) and
  //     [Selected] paragraphs. We pull each pattern out preserving
  //     the message's appearance order.
  type Hit = { start: number; end: number; section: KbSection }
  const hits: Hit[] = []
  for (const m of working.matchAll(FENCE_KBCONTEXT)) {
    if (m.index === undefined) continue
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind: 'kbcontext', content: m[0] },
    })
  }
  for (const m of working.matchAll(FENCE_A11Y)) {
    if (m.index === undefined) continue
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind: 'a11y', content: m[0] },
    })
  }
  for (const m of working.matchAll(FENCE_EXPOSED)) {
    if (m.index === undefined) continue
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind: 'exposed-context', content: m[0] },
    })
  }
  for (const m of working.matchAll(FENCE_SELECTED)) {
    if (m.index === undefined) continue
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      section: { kind: 'selected', content: m[0] },
    })
  }

  // Sort by appearance and stitch the remaining text into userInput.
  hits.sort((a, b) => a.start - b.start)
  let cursor = 0
  const remainder: string[] = []
  for (const hit of hits) {
    if (hit.start > cursor) {
      remainder.push(working.slice(cursor, hit.start))
    }
    sections.push(hit.section)
    cursor = hit.end
  }
  if (cursor < working.length) {
    remainder.push(working.slice(cursor))
  }

  // Collapse consecutive blank-line separators left behind by the
  // peel; the remaining text should look like the user's original
  // input as far as practical.
  const userInput = remainder.join('').replace(/\n{3,}/g, '\n\n').trim()

  return { sections, userInput }
}
