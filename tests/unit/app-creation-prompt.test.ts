/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for buildAppCreationPrompt — covers the branches in
 * spec docs/specs/v0.1.0-app-creation-flow.md §9.1 (required-only,
 * required + 1 optional, required + 3 optional, empty / undefined /
 * whitespace-only optionals, long-form text near the 500-char
 * boundary, and backtick / `${...}` / `<...>` escaping).
 */
import { describe, expect, it } from 'vitest'
import { buildAppCreationPrompt } from '../../src/shared/app-creation-prompt'

const UNFILLED_WITH_GUIDANCE =
  '（未記入。あなたの判断で適切な提案をしてください）'
const UNFILLED_PLAIN = '（未記入）'

describe('buildAppCreationPrompt', () => {
  describe('required-only input', () => {
    it('renders the purpose inside a backtick fence', () => {
      const prompt = buildAppCreationPrompt({ purpose: 'メモを横断検索したい' })
      expect(prompt).toContain('### 目的と概要')
      expect(prompt).toContain('```\nメモを横断検索したい\n```')
    })

    it('falls back to the guidance placeholder for input + output', () => {
      const prompt = buildAppCreationPrompt({ purpose: 'p' })
      expect(prompt).toContain(`### インプット（何を渡す / 何を起点に動くか）\n\n${UNFILLED_WITH_GUIDANCE}`)
      expect(prompt).toContain(`### アウトプット（何が得られるか）\n\n${UNFILLED_WITH_GUIDANCE}`)
    })

    it('falls back to the plain placeholder for frequency', () => {
      const prompt = buildAppCreationPrompt({ purpose: 'p' })
      expect(prompt).toContain(`### 使う頻度・タイミング\n\n${UNFILLED_PLAIN}`)
    })

    it('includes the four-step playbook headings', () => {
      const prompt = buildAppCreationPrompt({ purpose: 'p' })
      expect(prompt).toContain('### Step 1: 要件確認')
      expect(prompt).toContain('### Step 2: 設計提案')
      expect(prompt).toContain('### Step 3: ユーザー確認 → 実装')
      expect(prompt).toContain('### Step 4: 動作確認の案内')
    })
  })

  describe('required + one optional', () => {
    it('renders the supplied input field, leaves the rest as fallback', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: 'project markdown files',
      })
      expect(prompt).toContain('```\nproject markdown files\n```')
      expect(prompt).toContain(`### アウトプット（何が得られるか）\n\n${UNFILLED_WITH_GUIDANCE}`)
      expect(prompt).toContain(`### 使う頻度・タイミング\n\n${UNFILLED_PLAIN}`)
    })
  })

  describe('required + three optional', () => {
    it('renders all three optional fields fenced', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: 'i-text',
        output: 'o-text',
        frequency: 'daily',
      })
      expect(prompt).toContain('```\ni-text\n```')
      expect(prompt).toContain('```\no-text\n```')
      expect(prompt).toContain('```\ndaily\n```')
      expect(prompt).not.toContain(UNFILLED_WITH_GUIDANCE)
      expect(prompt).not.toContain(UNFILLED_PLAIN)
    })
  })

  describe('empty / undefined / whitespace-only optionals', () => {
    it('treats undefined as not-filled', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: undefined,
        output: undefined,
        frequency: undefined,
      })
      expect(prompt).toContain(UNFILLED_WITH_GUIDANCE)
      expect(prompt).toContain(UNFILLED_PLAIN)
    })

    it('treats an empty string as not-filled', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: '',
        output: '',
        frequency: '',
      })
      expect(prompt).toContain(UNFILLED_WITH_GUIDANCE)
      expect(prompt).toContain(UNFILLED_PLAIN)
    })

    it('treats whitespace-only as not-filled', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: '   ',
        output: '\t\n  ',
        frequency: ' ',
      })
      expect(prompt).toContain(UNFILLED_WITH_GUIDANCE)
      expect(prompt).toContain(UNFILLED_PLAIN)
    })

    it('does NOT treat purpose with whitespace-only as not-filled (purpose is required and rendered as-is)', () => {
      // Purpose is the required field; UI validation rejects whitespace-only
      // before we get here, so the prompt builder renders it verbatim.
      const prompt = buildAppCreationPrompt({ purpose: '   ' })
      expect(prompt).toContain('```\n   \n```')
    })
  })

  describe('long-form text near the 500-char boundary', () => {
    it('renders 500-character optional content fenced and intact', () => {
      const longText = 'a'.repeat(500)
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: longText,
      })
      expect(prompt).toContain('```\n' + longText + '\n```')
    })

    it('renders 2000-character purpose fenced and intact', () => {
      const longPurpose = 'P'.repeat(2000)
      const prompt = buildAppCreationPrompt({ purpose: longPurpose })
      expect(prompt).toContain('```\n' + longPurpose + '\n```')
    })
  })

  describe('escaping concerns', () => {
    it('uses a longer fence when the input itself contains triple backticks', () => {
      const trickyInput = 'before\n```\ncode-inside-user-text\n```\nafter'
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: trickyInput,
      })
      // The fence around the input must be longer than the longest backtick
      // run inside it (3) — i.e. at least 4 backticks.
      expect(prompt).toContain('````\n' + trickyInput + '\n````')
    })

    it('uses an even longer fence when the input contains 4 backticks', () => {
      const trickyInput = '````fence-of-four````'
      const prompt = buildAppCreationPrompt({
        purpose: 'p',
        input: trickyInput,
      })
      expect(prompt).toContain('`````\n' + trickyInput + '\n`````')
    })

    it('does not interpolate `${...}` sequences', () => {
      const prompt = buildAppCreationPrompt({
        purpose: '${injection}',
      })
      // The literal text must survive into the prompt unchanged.
      expect(prompt).toContain('```\n${injection}\n```')
    })

    it('preserves `<...>` brackets verbatim', () => {
      const prompt = buildAppCreationPrompt({
        purpose: '<script>alert(1)</script>',
      })
      expect(prompt).toContain('```\n<script>alert(1)</script>\n```')
    })

    it('preserves backslashes verbatim', () => {
      const prompt = buildAppCreationPrompt({
        purpose: 'C:\\path\\to\\file',
      })
      expect(prompt).toContain('```\nC:\\path\\to\\file\n```')
    })
  })

  describe('overall structure', () => {
    it('keeps the legacy anchor banner and the references section in dual-write', () => {
      // SS-3 / Q4 dual-write (v2.0): the prompt is now wrapped in a
      // `━━━━━ KovitoBoard:app-create ━━━━━` rule-line sentinel.
      // Both the sentinel envelope and the legacy banner must be
      // present so older renderers (chip-collapsing on the banner)
      // and newer ones (chip-collapsing on the sentinel) both work.
      const prompt = buildAppCreationPrompt({ purpose: 'p' })
      expect(prompt.startsWith('━━━━━ KovitoBoard:app-create')).toBe(true)
      expect(prompt.endsWith('━━━━━ KovitoBoard:end ━━━━━')).toBe(true)
      expect(prompt).toContain('KovitoBoard App Creation Request')
      expect(prompt).toContain('## 参考ドキュメント')
      expect(prompt).toContain('docs/agent-ref/05-apps.md')
    })
  })
})
