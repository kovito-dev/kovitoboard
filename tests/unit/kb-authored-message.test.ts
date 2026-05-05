/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'
import { parseKbAuthoredSections } from '../../src/renderer/utils/kb-authored-message'
import { SYSTEM_PROMPT_PREAMBLE } from '../../src/renderer/hooks/useSidebarContext'

const PREAMBLE = SYSTEM_PROMPT_PREAMBLE

const KBCONTEXT = ['```kbcontext', 'url: /agents/kobi', 'activeMenu: agents', 'appId: agents', 'screenLabel: Agents', '```'].join('\n')
const A11Y = ['```a11y', '<heading level="1">KovitoBoard</heading>', '```'].join('\n')
const EXPOSED = ['```ExposedContext', '{"reportId":"42"}', '```'].join('\n')
// `Selected` is emitted by `describePickedElement` as a fenced block
// (info string `Selected`), not as a `[Selected]` paragraph.
const SELECTED = ['```Selected', 'tag: button', 'text: 送信', '```'].join('\n')

describe('parseKbAuthoredSections', () => {
  describe('whole-message types', () => {
    it('detects app creation requests', () => {
      const text = 'KovitoBoard App Creation Request\n\n## ユーザーの要件\n\n### 目的と概要\n\n```\np\n```'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toEqual({ kind: 'app-create', content: text })
      expect(r.userInput).toBe('')
    })

    it('detects v2.0 recipe install requests and pulls the name from the body', () => {
      // The v2.0 prompt header no longer embeds the name — the
      // parser extracts it from the `### name` block instead.
      const text = [
        'KovitoBoard Recipe Installation Request',
        '',
        '## Recipe Information',
        '',
        '### recipeId',
        '',
        'todo-manager',
        '',
        '### name',
        '',
        'TODO Manager',
        '',
        '### version',
        '',
        '1.0.0',
      ].join('\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({ kind: 'recipe-install', label: 'TODO Manager' })
      expect(r.userInput).toBe('')
    })

    it('still detects legacy v1.x recipe install requests', () => {
      // Sessions captured before the v2.0 header change keep
      // rendering as collapsible chips after the upgrade.
      const text = 'KovitoBoard Recipe Application: "todo" v0.1.0\n\n## CONSTRAINTS'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({ kind: 'recipe-install', label: 'todo' })
      expect(r.userInput).toBe('')
    })

    it('detects continue-session handover messages and captures the short session ID', () => {
      // The handover message is built by `format.ts:buildContinueSessionMessage`
      // and contains a `<previous-session>` block. KB recognizes the
      // first-line anchor and folds the entire message into a chip so
      // the timeline does not display the carbon-copied transcript
      // verbatim.
      const text = [
        'Please continue working from the previous session (988e0a43).',
        '',
        '<previous-session>',
        '## User',
        'Hello',
        '## Assistant',
        'Hi there!',
        '</previous-session>',
        '',
        'Based on the context above, please continue with the remaining work.',
      ].join('\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({
        kind: 'continue-session',
        label: '988e0a43',
      })
      // The full original message must be preserved as the chip's
      // content so expanding it shows the agent-facing payload.
      expect(r.sections[0].content).toBe(text)
      expect(r.userInput).toBe('')
    })

    it('detects the short-form continue-session message with no embedded transcript', () => {
      // When the previous session has no extractable conversation,
      // `buildContinueSessionMessage` falls back to the single-sentence
      // form. KB still folds it into a chip for a consistent UX.
      const text = 'Please continue working from the previous session (abcd1234).'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0]).toMatchObject({
        kind: 'continue-session',
        label: 'abcd1234',
      })
      expect(r.userInput).toBe('')
    })

    it('does not over-match similar prefixes', () => {
      // Whole-message types only fire on the literal anchors; other text
      // returns empty sections + the original userInput.
      const text = 'Just a regular message that mentions KovitoBoard somewhere'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })
  })

  describe('composite (sidebar-origin) messages', () => {
    it('peels off the preamble when the message starts with it', () => {
      const text = PREAMBLE + '\n\nhello'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(1)
      expect(r.sections[0].kind).toBe('preamble')
      expect(r.userInput).toBe('hello')
    })

    it('peels off the kbcontext fence', () => {
      const text = KBCONTEXT + '\n\nopen ext/research-reports'
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext'])
      expect(r.sections[0].content).toBe(KBCONTEXT)
      expect(r.userInput).toBe('open ext/research-reports')
    })

    it('peels off all five sidebar sections in appearance order', () => {
      const text = [PREAMBLE, KBCONTEXT, A11Y, SELECTED, EXPOSED, 'do the thing'].join('\n\n')
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

    it('keeps user input intact when no sidebar sections are present', () => {
      const text = 'just a plain user message'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('peels just the kbcontext when only that section exists', () => {
      // An ambient sidebar follow-up message (kbcontext only, no preamble).
      const text = KBCONTEXT + '\n\nfollow-up question'
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext'])
      expect(r.userInput).toBe('follow-up question')
    })

    it('handles two kbcontext fences in the same message (defensive)', () => {
      // Should not happen in practice but the parser still carries
      // them through individually instead of merging.
      const text = [KBCONTEXT, KBCONTEXT, 'tail'].join('\n\n')
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['kbcontext', 'kbcontext'])
      expect(r.userInput).toBe('tail')
    })

    it('preserves kbcontext fence body unchanged for the expanded view', () => {
      const text = KBCONTEXT + '\n\nuser tail'
      const r = parseKbAuthoredSections(text)
      expect(r.sections[0].content).toContain('url: /agents/kobi')
      expect(r.sections[0].content).toContain('appId: agents')
    })

    it('extracts a Selected fenced block when present', () => {
      const text = SELECTED + '\n\nselect this for me'
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['selected'])
      expect(r.sections[0].content).toBe(SELECTED)
      expect(r.userInput).toBe('select this for me')
    })

    it('returns no sections for empty input', () => {
      const r = parseKbAuthoredSections('')
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe('')
    })
  })

  describe('mixed-input edge cases', () => {
    it('treats unknown fences as user content (not as kb-authored)', () => {
      const text = '```typescript\nconst x = 1\n```\n\nplease review'
      const r = parseKbAuthoredSections(text)
      expect(r.sections).toHaveLength(0)
      expect(r.userInput).toBe(text)
    })

    it('still peels sidebar sections when the user message comes first', () => {
      // Defensive: the production composer always puts user text last,
      // but make sure leading user text is preserved through the peel.
      const text = 'leading question\n\n' + KBCONTEXT
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

    it('detects the preamble even when newlines are escaped', () => {
      const text = sanitize(PREAMBLE + '\n\nhello')
      // Sanity check: the literal escapes really do come through.
      expect(text).toContain('\\n')
      expect(text).not.toContain('\n')

      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['preamble'])
      expect(r.userInput).toBe('hello')
    })

    it('detects fenced blocks (kbcontext / a11y / Selected / ExposedContext) when newlines are escaped', () => {
      const text = sanitize([PREAMBLE, KBCONTEXT, A11Y, SELECTED, EXPOSED, 'do the thing'].join('\n\n'))
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

    it('whole-message types still match after sanitization', () => {
      const text = sanitize('KovitoBoard Recipe Application: "todo" v0.1.0\n\n## CONSTRAINTS')
      const r = parseKbAuthoredSections(text)
      expect(r.sections.map((s) => s.kind)).toEqual(['recipe-install'])
      expect(r.sections[0].label).toBe('todo')
      expect(r.userInput).toBe('')
    })
  })
})
