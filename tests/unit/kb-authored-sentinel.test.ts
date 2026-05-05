/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * SS-3 / Q4: sentinel-aware path of `parseKbAuthoredSections`.
 *
 * The renderer ships with two detection paths: the v1.0 sentinel
 * detector (preferred) and the legacy anchor ladder (fallback for
 * pre-sentinel JSONLs). These tests pin the sentinel path's
 * happy-path behavior, attribute extraction, dual-write coexistence
 * with legacy anchors, and the resilience knobs the spec requires
 * (open/close pairing, attribute escapes, unknown kind coercion).
 *
 * Construction-side tests live next to each prompt builder
 * (`recipe-applicator-prompt.test.ts`, `app-creation-prompt.test.ts`,
 * etc.) — this file only covers parser behavior.
 */
import { describe, expect, it } from 'vitest'
import { parseKbAuthoredSections } from '../../src/renderer/utils/kb-authored-message'
import {
  buildSentinelOpenTag,
  wrapWithSentinel,
} from '../../src/shared/kb-authored-sentinel'

describe('sentinel parser (parseKbAuthoredSections, sentinel path)', () => {
  it('extracts a single sentinel block as one section', () => {
    const text = wrapWithSentinel('app-create', 'KovitoBoard App Creation Request\n\n…body…')
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('app-create')
    expect(r.sections[0].content).toContain('KovitoBoard App Creation Request')
    expect(r.userInput).toBe('')
  })

  it('extracts the `label` attribute for chip header interpolation', () => {
    const text = wrapWithSentinel('recipe-install', 'body', { label: 'todo-manager' })
    const r = parseKbAuthoredSections(text)
    expect(r.sections[0].kind).toBe('recipe-install')
    expect(r.sections[0].label).toBe('todo-manager')
  })

  it('parses multiple sentinel blocks in appearance order', () => {
    // Mirrors the AmbientSidebar.composePayload output where the
    // preamble / kbcontext / a11y / selected blocks are separated by
    // blank lines.
    const text = [
      wrapWithSentinel('preamble', 'preamble body'),
      wrapWithSentinel('kbcontext', '```kbcontext\nurl: /agents\n```'),
      wrapWithSentinel('a11y', '```a11y\n<heading>KB</heading>\n```'),
      'real user message',
    ].join('\n\n')
    const r = parseKbAuthoredSections(text)
    expect(r.sections.map((s) => s.kind)).toEqual([
      'preamble',
      'kbcontext',
      'a11y',
    ])
    expect(r.userInput).toBe('real user message')
  })

  it('coerces an unknown sentinel kind to "other" without crashing', () => {
    // A future KB version emitting a kind the current renderer does
    // not know about must still chip-collapse — otherwise upgrades
    // become a binary "all or nothing" risk for the chat surface.
    const text =
      '<!-- KB:auto-msg type=future-kind -->\nsomething new\n<!-- KB:auto-msg-end -->'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('other')
    expect(r.sections[0].content).toBe('something new')
  })

  it('round-trips labels containing literal double quotes verbatim', () => {
    // v2.0 drops the `label="…"` attribute syntax for a colon-
    // suffixed identifier. Double quotes therefore lose their
    // structural meaning and round-trip without escaping — the
    // label is whatever sits between the first `:` after the kind
    // and the trailing rule, with newline / U+2501 collapsed away.
    const text = wrapWithSentinel('recipe-install', 'body', { label: 'a"b' })
    expect(text).toContain(':a"b ━━━━━')
    const r = parseKbAuthoredSections(text)
    expect(r.sections[0].label).toBe('a"b')
  })

  it('preserves a label that itself contains colons (split-on-first-colon contract)', () => {
    // recipeId / sessionId values can include `:` (e.g. tagged
    // versions like `todo:v2`). The split-on-first-colon contract
    // means everything after the first colon — including further
    // colons — survives as the label literal.
    const text = wrapWithSentinel('recipe-install', 'body', { label: 'todo:v2' })
    expect(text).toContain('━━━━━ KovitoBoard:recipe-install:todo:v2 ━━━━━')
    const r = parseKbAuthoredSections(text)
    expect(r.sections[0].label).toBe('todo:v2')
  })

  it('sanitizes newline / rule-line characters out of the label so the header stays on one line', () => {
    // A label with a stray newline or U+2501 would split the
    // envelope and prevent the parser from finding the closing
    // marker. We collapse those to spaces at wrap time; nothing
    // else is rewritten so unicode / spaces / `:` all survive.
    const text = wrapWithSentinel('recipe-install', 'body', {
      label: 'rec\nipe━name',
    })
    expect(text).toContain('━━━━━ KovitoBoard:recipe-install:rec ipe name ━━━━━')
    const r = parseKbAuthoredSections(text)
    expect(r.sections[0].label).toBe('rec ipe name')
  })

  it('still parses v1.0 HTML-comment sentinels (transitional fallback)', () => {
    // Spec v2.0 keeps the v1.0 HTML-comment regex as a fallback so
    // any JSONL written between `ca7d225` (v1.0 dual-write rollout)
    // and the rule-line cutover still chip-collapses. Construction
    // sites no longer emit this form, but the detector must
    // recognize it for replay compatibility.
    const text =
      '<!-- KB:auto-msg type=app-create -->\nKovitoBoard App Creation Request\n\n## body\n<!-- KB:auto-msg-end -->'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('app-create')
    expect(r.sections[0].content).toContain('KovitoBoard App Creation Request')
  })

  it('does not crash or loop on an unmatched open sentinel', () => {
    // A construction site bug that emits an open without a close
    // must degrade gracefully: the parser drops the malformed
    // block, falls through to legacy detection, and the message
    // simply renders as plain text. The point is that future regex
    // tweaks do not introduce a catastrophic-backtracking path or
    // a silent infinite loop.
    const text =
      '━━━━━ KovitoBoard:preamble ━━━━━\nbody without a close\nmore text'
    const r = parseKbAuthoredSections(text)
    // Legacy whole-message anchors are anchored at start, so the
    // unmatched sentinel preceding them prevents detection. The
    // contract is "no chip rendered" rather than "fall through to
    // mid-stream legacy detection".
    expect(r.sections).toHaveLength(0)
    expect(r.userInput).toContain('body without a close')
  })

  it('takes precedence over legacy detection when both are present in the same message', () => {
    // The legacy `KovitoBoard App Creation Request` anchor lives
    // inside the sentinel body (intentional dual-write). The
    // sentinel parser must claim the whole sentinel range first so
    // we do not double-render the same section.
    const text = wrapWithSentinel(
      'app-create',
      'KovitoBoard App Creation Request\n\n## body',
    )
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('app-create')
  })

  it('keeps user-typed text outside the sentinel as userInput', () => {
    const text = `prefix typed by user\n\n${wrapWithSentinel(
      'kbcontext',
      '```kbcontext\nfoo\n```',
    )}\n\nsuffix typed by user`
    const r = parseKbAuthoredSections(text)
    expect(r.userInput).toBe('prefix typed by user\n\nsuffix typed by user')
    expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext'])
  })

  it('is idempotent: parsing parsed message content does not multiply sections', () => {
    // Defensive — if the renderer accidentally re-parses an already
    // extracted section's content (e.g. inside a debug overlay), it
    // should not re-discover the original block.
    const text = wrapWithSentinel('preamble', 'preamble body')
    const r1 = parseKbAuthoredSections(text)
    const r2 = parseKbAuthoredSections(r1.sections[0].content)
    expect(r2.sections).toHaveLength(0)
    expect(r2.userInput).toBe('preamble body')
  })
})

describe('legacy fallback path (parseKbAuthoredSections, no sentinel)', () => {
  // Smoke tests on the legacy ladder to confirm the sentinel
  // short-circuit does not regress pre-sentinel detection. Detailed
  // coverage stays in `kb-authored-message.test.ts`.

  it('still detects legacy app-creation prompts without a sentinel', () => {
    const text =
      'KovitoBoard App Creation Request\n\n## body\n\n## 参考ドキュメント'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('app-create')
  })

  it('still detects legacy continue-session prompts without a sentinel', () => {
    const text =
      'Please continue working from the previous session (988e0a43).\n\n<previous-session>\n…body…\n</previous-session>'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('continue-session')
    expect(r.sections[0].label).toBe('988e0a43')
  })
})
