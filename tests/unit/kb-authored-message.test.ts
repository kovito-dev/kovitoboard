/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for `parseKbAuthoredSections` after the v0.2.0 K-15 cutover
 * (spec `kb-authored-sentinel.md` v1.3 §11.3). The legacy anchor
 * ladder and the v1.0 HTML-comment fallback have been removed; the
 * parser now only recognizes rule-line sentinel blocks. JSONL written
 * before the rule-line rollout falls through to `userInput` as plain
 * text — the accepted degrade.
 *
 * Sentinel-shape edge cases (label escapes, unknown kinds, broken
 * envelopes) live next door in `kb-authored-sentinel.test.ts`. This
 * file pins the higher-level contract callers depend on:
 *   - whole-message types (one sentinel, no leftover userInput)
 *   - composite messages (multiple sentinels + trailing userInput)
 *   - tmux-bridge sanitization tolerance (`\n` / `\t` literals)
 *   - degrade behavior for legacy anchor / fence inputs
 */
import { describe, expect, it } from 'vitest'
import { parseKbAuthoredSections } from '../../src/renderer/utils/kb-authored-message'
import {
  SYSTEM_PROMPT_PREAMBLE,
} from '../../src/renderer/hooks/useSidebarContext'
import { wrapWithSentinel } from '../../src/shared/kb-authored-sentinel'

const PREAMBLE_BODY = SYSTEM_PROMPT_PREAMBLE
const KBCONTEXT_BODY = [
  'url: /agents/kobi',
  'activeMenu: agents',
  'appId: agents',
  'screenLabel: Agents',
].join('\n')
const A11Y_BODY = '- heading[level=1]: "KovitoBoard"'
const SELECTED_BODY = ['tag: button', 'text: 送信'].join('\n')
const EXPOSED_BODY = '{"reportId":"42"}'

describe('parseKbAuthoredSections', () => {
  describe('whole-message sentinel types', () => {
    it('extracts an app-create sentinel as one section with no userInput', () => {
      const text = wrapWithSentinel('app-create', '## ユーザーの要件\n\n…body…')
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0].kind).toBe('app-create')
      expect(r.sections[0].content).toContain('## ユーザーの要件')
      expect(r.userInput).toBe('')
    })

    it('extracts a recipe-install sentinel and surfaces the recipe name as label', () => {
      const text = wrapWithSentinel(
        'recipe-install',
        '## Recipe Information\n\n### name\n\nTODO Manager',
        { label: 'TODO Manager' },
      )
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({
        kind: 'recipe-install',
        label: 'TODO Manager',
      })
      expect(r.userInput).toBe('')
    })

    it('extracts a continue-session sentinel and pulls the short session id from the label', () => {
      const text = wrapWithSentinel(
        'continue-session',
        '<previous-session>\n## User\nHello\n</previous-session>',
        { label: '988e0a43' },
      )
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({
        kind: 'continue-session',
        label: '988e0a43',
      })
      expect(r.userInput).toBe('')
    })

    it('does not match plain text that mentions the brand name', () => {
      // Without a rule-line sentinel envelope, the parser must not
      // chip-collapse arbitrary text — it returns the message as-is.
      const text = 'Just a regular message that mentions KovitoBoard somewhere'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })
  })

  describe('composite (sidebar-origin) messages', () => {
    it('peels off a single preamble sentinel when the message starts with it', () => {
      const text = `${wrapWithSentinel('preamble', PREAMBLE_BODY)}\n\nhello`
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0].kind).toBe('preamble')
      expect(r.userInput).toBe('hello')
    })

    it('peels off a kbcontext sentinel and keeps the user text intact', () => {
      const text = `${wrapWithSentinel('kbcontext', KBCONTEXT_BODY)}\n\nopen ext/research-reports`
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext'])
      expect(r.sections[0].content).toBe(KBCONTEXT_BODY)
      expect(r.userInput).toBe('open ext/research-reports')
    })

    it('peels all five sidebar sentinel sections in appearance order', () => {
      const text = [
        wrapWithSentinel('preamble', PREAMBLE_BODY),
        wrapWithSentinel('kbcontext', KBCONTEXT_BODY),
        wrapWithSentinel('a11y', A11Y_BODY),
        wrapWithSentinel('selected', SELECTED_BODY),
        wrapWithSentinel('exposed-context', EXPOSED_BODY),
        'do the thing',
      ].join('\n\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual([
        'preamble',
        'kbcontext',
        'a11y',
        'selected',
        'exposed-context',
      ])
      expect(r.userInput).toBe('do the thing')
    })

    it('keeps user input intact when no sidebar sentinels are present', () => {
      const text = 'just a plain user message'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('handles two kbcontext sentinels in the same message (defensive)', () => {
      // Should not happen in practice but the parser still carries
      // them through individually instead of merging.
      const block = wrapWithSentinel('kbcontext', KBCONTEXT_BODY)
      const text = [block, block, 'tail'].join('\n\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext', 'kbcontext'])
      expect(r.userInput).toBe('tail')
    })

    it('preserves the kbcontext body verbatim for the expanded view', () => {
      const text = `${wrapWithSentinel('kbcontext', KBCONTEXT_BODY)}\n\nuser tail`
      const r = parseKbAuthoredSections(text)
      expect(r.sections[0].content).toContain('url: /agents/kobi')
      expect(r.sections[0].content).toContain('appId: agents')
    })

    it('returns no sections for empty input', () => {
      const r = parseKbAuthoredSections('')
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe('')
    })
  })

  describe('mixed-input edge cases', () => {
    it('treats arbitrary fenced code blocks as user content', () => {
      // A user-typed code fence must survive into userInput unchanged
      // — the sentinel parser only matches rule-line envelopes.
      const text = '```typescript\nconst x = 1\n```\n\nplease review'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('preserves leading user text when the sentinel is not first', () => {
      // Defensive: the production composer always puts user text last,
      // but make sure leading user text is preserved through the peel.
      const text = `leading question\n\n${wrapWithSentinel('kbcontext', KBCONTEXT_BODY)}`
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext'])
      expect(r.userInput).toBe('leading question')
    })
  })

  describe('tmux-bridge sanitized input (literal `\\n` / `\\t` chars)', () => {
    // `tmux-bridge.sendViaBuffer` rewrites real newlines/tabs into the
    // literal 2-char sequences before pasting into tmux. Claude stores
    // the message as-pasted, so the events the parser sees on read-back
    // contain `\n` / `\t` as literal characters. The parser must undo
    // that sanitization before pattern matching.

    /** Replicate the server-side sanitization end-to-end on a string. */
    function sanitize(s: string): string {
      return s.replace(/\r\n/g, '\\n').replace(/[\r\n]/g, '\\n').replace(/\t/g, '\\t')
    }

    it('detects the preamble sentinel even when newlines are escaped', () => {
      const text = sanitize(`${wrapWithSentinel('preamble', PREAMBLE_BODY)}\n\nhello`)
      // Sanity check: the literal escapes really do come through.
      expect(text).toContain('\\n')
      expect(text).not.toContain('\n')

      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['preamble'])
      expect(r.userInput).toBe('hello')
    })

    it('detects all sentinel sections when newlines are escaped', () => {
      const text = sanitize(
        [
          wrapWithSentinel('preamble', PREAMBLE_BODY),
          wrapWithSentinel('kbcontext', KBCONTEXT_BODY),
          wrapWithSentinel('a11y', A11Y_BODY),
          wrapWithSentinel('selected', SELECTED_BODY),
          wrapWithSentinel('exposed-context', EXPOSED_BODY),
          'do the thing',
        ].join('\n\n'),
      )
      expect(text).not.toContain('\n')

      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual([
        'preamble',
        'kbcontext',
        'a11y',
        'selected',
        'exposed-context',
      ])
      expect(r.userInput).toBe('do the thing')
    })
  })

  describe('legacy-anchor / fence degrade (v0.1.x JSONL)', () => {
    // After the K-15 cutover, JSONL written before the rule-line
    // sentinel rollout no longer chip-collapses — it falls through to
    // userInput as raw text. Spec §11.3 documents this as an accepted
    // degrade because v0.1.x had no long-term users.

    it('renders a legacy app-create anchor as raw user input', () => {
      const text = 'KovitoBoard App Creation Request\n\n## ユーザーの要件\n\n…body…'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('renders a legacy recipe-install anchor as raw user input', () => {
      const text = [
        'KovitoBoard Recipe Installation Request',
        '',
        '## Recipe Information',
      ].join('\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('renders a legacy continue-session anchor as raw user input', () => {
      const text =
        'Please continue working from the previous session (988e0a43).\n\n<previous-session>\n…\n</previous-session>'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('renders legacy fenced kbcontext / a11y / Selected / ExposedContext blocks as raw user input', () => {
      const text = [
        '```kbcontext',
        'url: /agents/kobi',
        '```',
        '',
        '```a11y',
        '<heading>KB</heading>',
        '```',
        '',
        '```Selected',
        'tag: button',
        '```',
        '',
        '```ExposedContext',
        '{"reportId":"42"}',
        '```',
        '',
        'tail',
      ].join('\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toContain('```kbcontext')
      expect(r.userInput).toContain('tail')
    })
  })
})
