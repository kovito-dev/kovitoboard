/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KB-Authored Sentinel — shared helper for the construction sites
 * that wrap automated KB messages with rule-line sentinels (spec
 * `docs/specs/v0.1.0-kb-authored-sentinel.md` §2.1, v2.0).
 *
 * Living in `src/shared/` lets server-side prompt builders (recipe
 * applicator, app-creation-prompt, …) and renderer-side ones
 * (sidebar composer, continue-session formatter, …) share one
 * canonical wrap helper. The parser side reads the same constants
 * via the regex in `kb-authored-message.ts`.
 *
 * Format (v2.0 — rule-line variant)
 * ---------------------------------
 *   ━━━━━ KovitoBoard:<kind>[:<label>] ━━━━━
 *   <content>
 *   ━━━━━ KovitoBoard:end ━━━━━
 *
 * The label is folded into the header as a colon-suffixed
 * identifier (e.g. `KovitoBoard:recipe-install:my-recipe`) rather
 * than the previous `label="…"` attribute syntax. Reasoning:
 *   - The `key="value"` shape gave the model an obvious surface
 *     to interpret as configuration ("am I in label=todo mode?").
 *   - The colon-segmented identifier reads as a slash-style ID
 *     instead, which is consumed as a single token group and
 *     blends into the surrounding decoration.
 *   - The escape budget shrinks: no `"` / `\` quoting is needed
 *     because the parser slices on the first `:` and treats the
 *     remainder of the header line as the literal label.
 *
 * `version` is reserved on the wire (`KbSentinelAttrs.version`) for
 * future backward-incompatible template revisions but no v0.1.0
 * builder emits it — keeping the envelope short reduces the
 * surface that the model could try to interpret as a directive.
 *
 * Why rule-line, not HTML comments?
 *   - The HTML comment form (v1.0) sat in a Markdown grey zone:
 *     trained-on as "developer-facing notes / TODOs", which gives
 *     Claude a real motive to read the comment for instructions.
 *   - U+2501 (HEAVY HORIZONTAL) carries no syntactic meaning in
 *     Markdown / programming languages. It reads as decoration /
 *     section-divider in TUI output, so the model has effectively
 *     no incentive to interpret the inner `KovitoBoard:<kind>`
 *     identifier as a directive.
 *   - U+2501 is virtually impossible to produce by accident — IMEs
 *     do not surface it — so the chance of a user message colliding
 *     with the sentinel is zero in practice.
 *
 * The sentinel is purely a UI hint for the renderer's collapsing
 * chip. Claude Code preserves these characters verbatim in JSONL,
 * so the renderer can extract the payload out of every replayed
 * message without reaching back into the application logs. The
 * spec calls out an implementation-time verification (§6) that
 * Claude does not regress on responses when these sentinels appear
 * in user messages — see the verification notes in the same spec.
 */

/**
 * Stable list of v1.0 sentinel `type` values. Mirror of
 * `KbSectionKind` in the renderer parser; kept in sync via the
 * spec's §2.2 table.
 *
 * Adding a new type:
 *   1. Append the kind here.
 *   2. Update `KbSectionKind` in `renderer/utils/kb-authored-message.ts`.
 *   3. Add an icon + i18n label in `renderer/components/KbAuthoredSections.tsx`.
 *   4. Wrap the corresponding construction site with `wrapWithSentinel`.
 */
export type KbAuthoredType =
  | 'preamble'
  | 'kbcontext'
  | 'a11y'
  | 'exposed-context'
  | 'selected'
  | 'recipe-install'
  | 'app-create'
  | 'continue-session'
  | 'skill-base-dir'
  | 'other'

/**
 * Optional attributes the renderer can extract for chip labels
 * (recipe name, short session id, etc.). The label rides as a
 * colon-suffixed segment of the header (`KovitoBoard:<type>:<label>`),
 * not as a quoted attribute, so callers do not have to think about
 * escaping when the value contains `:` or whitespace — the parser
 * splits on the first `:` only.
 */
export interface KbSentinelAttrs {
  /**
   * Free-form label that the renderer may interpolate into the chip
   * header. A newline aborts the parse; everything else (`:`, ` `,
   * unicode, etc.) is preserved verbatim.
   */
  label?: string
  /**
   * Template version of the wrapped content. Reserved for future
   * backward-incompatible template revisions — the v0.1.0 line does
   * not emit it. When a future builder needs to fork its prompt
   * format, ship a structurally distinct sentinel (e.g. a new type
   * value or a v3 helper) rather than tacking version onto this
   * envelope; we are keeping the field in the interface only as a
   * hint that "envelope evolution will go through this object".
   */
  version?: string
}

/**
 * Rule-line characters used to bracket the sentinel header / footer.
 * Five characters give a clear visual band without spending many
 * tokens. U+2501 (HEAVY HORIZONTAL) is preferred over light/double
 * variants because it stands out at default terminal widths.
 */
const RULE = '━━━━━'

/** Brand prefix that keeps the sentinel unmistakable in payloads. */
const BRAND = 'KovitoBoard'

/** Closing-marker label. The full close line reads `<RULE> KovitoBoard:end <RULE>`. */
const CLOSE_TYPE = 'end'

/**
 * Sanitize the label so it cannot break the header line. Rule-line
 * sentinels live on a single physical line, so a label containing
 * `\n` or the rule character itself would split the envelope. We
 * collapse those to spaces; everything else — including `:`,
 * whitespace, unicode — is preserved so the renderer can show the
 * operator's exact value.
 */
function sanitizeLabel(value: string): string {
  return value.replace(/[\n\r]/g, ' ').replace(/━/g, ' ')
}

/**
 * Build the opening sentinel line for a given type + attribute bag.
 * Exposed for parser test fixtures; production callers should reach
 * for `wrapWithSentinel` instead.
 *
 * Output shape:
 *   `━━━━━ KovitoBoard:<type>[:<label>] ━━━━━`
 *
 * `version` is intentionally not emitted on the wire (see the type
 * doc comment); the field is kept on `KbSentinelAttrs` only as a
 * forward-looking marker.
 */
export function buildSentinelOpenTag(
  type: KbAuthoredType,
  attrs?: KbSentinelAttrs,
): string {
  const labelSegment =
    attrs?.label !== undefined && attrs.label.length > 0
      ? `:${sanitizeLabel(attrs.label)}`
      : ''
  return `${RULE} ${BRAND}:${type}${labelSegment} ${RULE}`
}

/**
 * Build the closing sentinel line. Public so test fixtures and any
 * future structural validators can construct it without re-encoding
 * the literal.
 */
export function buildSentinelCloseTag(): string {
  return `${RULE} ${BRAND}:${CLOSE_TYPE} ${RULE}`
}

/**
 * Wrap `content` with rule-line sentinels so the renderer recognizes
 * the block as an auto-generated message and renders a collapsing
 * chip. Existing legacy anchors inside `content` survive untouched
 * — dual-write is the spec's §4.2 mandate during F1.
 *
 * Trims trailing newlines on `content` so the closing sentinel sits
 * on its own line regardless of how the caller composed the body.
 */
export function wrapWithSentinel(
  type: KbAuthoredType,
  content: string,
  attrs?: KbSentinelAttrs,
): string {
  const open = buildSentinelOpenTag(type, attrs)
  const close = buildSentinelCloseTag()
  const trimmed = content.replace(/\n+$/, '')
  return `${open}\n${trimmed}\n${close}`
}
