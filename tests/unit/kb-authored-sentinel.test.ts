/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sentinel-shape edge cases for `parseKbAuthoredSections`.
 *
 * The parser ships with a single detection path: rule-line
 * `━━━━━ KovitoBoard:<kind> ━━━━━` sentinel blocks (spec
 * `kb-authored-sentinel.md` §6.1). The legacy anchor ladder and the
 * v1.0 HTML-comment sentinel fallback were both removed in the K-15
 * cutover (spec §11.3). These tests pin the sentinel envelope's
 * resilience knobs (label escapes, unknown kind coercion, malformed
 * envelopes) — higher-level "whole-message vs composite" coverage
 * lives in `kb-authored-message.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { parseKbAuthoredSections } from '../../src/renderer/utils/kb-authored-message'
import { wrapWithSentinel } from '../../src/shared/kb-authored-sentinel'

describe('sentinel parser (parseKbAuthoredSections)', () => {
  it('extracts a single sentinel block as one section', () => {
    const text = wrapWithSentinel('app-create', '## ユーザーの要件\n\n…body…')
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('app-create')
    expect(r.sections[0].content).toContain('## ユーザーの要件')
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
      wrapWithSentinel('kbcontext', 'url: /agents'),
      wrapWithSentinel('a11y', '- heading: "KB"'),
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
      '━━━━━ KovitoBoard:future-kind ━━━━━\nsomething new\n━━━━━ KovitoBoard:end ━━━━━'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('other')
    expect(r.sections[0].content).toBe('something new')
  })

  it('round-trips labels containing literal double quotes verbatim', () => {
    // The colon-suffixed identifier means double quotes lose their
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

  it('does not crash or loop on an unmatched open sentinel', () => {
    // A construction site bug that emits an open without a close
    // must degrade gracefully: the parser drops the malformed block
    // and the message simply renders as plain userInput. The point
    // is that future regex tweaks do not introduce a catastrophic-
    // backtracking path or a silent infinite loop.
    const text =
      '━━━━━ KovitoBoard:preamble ━━━━━\nbody without a close\nmore text'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(0)
    expect(r.userInput).toContain('body without a close')
  })

  it('keeps user-typed text outside the sentinel as userInput', () => {
    const text = `prefix typed by user\n\n${wrapWithSentinel(
      'kbcontext',
      'url: /agents',
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

  it('does not detect v1.0 HTML-comment sentinels (removed in K-15)', () => {
    // The transitional v1.0 HTML-comment regex was dropped at the
    // K-15 cutover (spec §11.3). Any pre-rule-line JSONL renders as
    // raw user text instead of chip-collapsing — accepted degrade.
    const text =
      '<!-- KB:auto-msg type=app-create -->\nbody\n<!-- KB:auto-msg-end -->'
    const r = parseKbAuthoredSections(text)
    expect(r.sections).toHaveLength(0)
    expect(r.userInput).toContain('<!-- KB:auto-msg')
  })
})
