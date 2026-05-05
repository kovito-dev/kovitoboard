/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `extractVisibleChoices` and `resolveVisibleChoices`.
 *
 * These cover the on-screen choice resolution introduced for Claude
 * Code 2.1.126 compatibility. The detector calls these helpers to
 * rewrite each pattern's static `keys` to whatever number Claude Code
 * actually painted next to the matching label.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  extractVisibleChoices,
  resolveVisibleChoices,
  buildDynamicChoices,
} from '../../src/server/trust-prompt-detector'
import type { TrustPromptChoice } from '../../src/shared/ws-events'

const FIXTURE_DIR_2_1_126 = join(
  __dirname,
  '../fixtures/trust-prompts/claude-2.1.126',
)
const FIXTURE_DIR_2_1_97 = join(
  __dirname,
  '../fixtures/trust-prompts/claude-2.1.97',
)

function loadFixture(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8')
}

describe('extractVisibleChoices', () => {
  it('parses the 2-row folder-trust menu', () => {
    const capture = loadFixture(FIXTURE_DIR_2_1_126, 'folder-trust-initial.txt')
    const choices = extractVisibleChoices(capture)
    expect(choices).toEqual([
      { num: 1, label: 'Yes, I trust this folder' },
      { num: 2, label: 'No, exit' },
    ])
  })

  it('parses the 2-row bash prompt that 2.1.126 ships for variable expansion commands', () => {
    const capture = loadFixture(FIXTURE_DIR_2_1_126, 'bash-command-two-choices.txt')
    const choices = extractVisibleChoices(capture)
    expect(choices).toEqual([
      { num: 1, label: 'Yes' },
      { num: 2, label: 'No' },
    ])
  })

  it('still parses the 3-row bash menu used by older Claude Code releases', () => {
    const capture = [
      ' Bash command',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and allow this session',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    expect(extractVisibleChoices(capture)).toEqual([
      { num: 1, label: 'Yes' },
      { num: 2, label: 'Yes, and allow this session' },
      { num: 3, label: 'No' },
    ])
  })

  it('returns an empty array when no menu is visible', () => {
    expect(extractVisibleChoices('just some prose without a menu\n')).toEqual([])
  })

  it('locks onto the live menu and ignores numbered prose higher up in the scrollback', () => {
    // The detector is called against the last ~200 lines of the tmux
    // pane, which routinely includes agent prose above the live menu.
    // The bottom-up scan must lock onto the menu nearest the cursor
    // rather than the prose that scrolled by earlier — otherwise the
    // modal surfaces fictitious choices like a concierge agent's
    // suggestion list.
    const capture = [
      '   1. First, consider whether this is safe.',
      '   2. Second, run the command.',
      '',
      ' Bash command',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const choices = extractVisibleChoices(capture)
    expect(choices).toEqual([
      { num: 1, label: 'Yes' },
      { num: 2, label: 'No' },
    ])
  })

  it('rejects an agent reply whose numbered list precedes the real Claude Code menu', () => {
    // Regression for the concierge-style false positive: an agent
    // system prompt that opens with "1. ...", "2. ...", "3. ..."
    // suggestions used to be picked up because the legacy
    // first-match-wins scan returned them before the actual
    // Yes / Yes-allow / No menu Claude Code rendered below. The
    // bottom-up scan must surface the Claude Code menu only.
    const capture = [
      '● Concierge',
      '',
      '  Welcome! What would you like to do?',
      '',
      '  1. "Walk me through KB" — I will give you a tour',
      '  2. "What is a recipe?" — I will introduce a core feature',
      '  3. "I want to build my own app" — Let us look at how to start',
      '',
      ' Reading 1 file… (ctrl+o to expand)',
      '   ⎿ ~/.kovitoboard/agent-ref/INDEX.md',
      '',
      '────────────────────────────────────────────────────────────',
      ' Read file',
      ' ~/.kovitoboard/agent-ref/INDEX.md',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from agent-ref/ during this session',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    const choices = extractVisibleChoices(capture)
    expect(choices).toEqual([
      { num: 1, label: 'Yes' },
      { num: 2, label: 'Yes, allow reading from agent-ref/ during this session' },
      { num: 3, label: 'No' },
    ])
  })

  it('parses cursor-marker rows (`❯ 1.`) the same as plain rows', () => {
    const capture = '   ❯ 1. Yes\n     2. No\n\n footer\n'
    expect(extractVisibleChoices(capture)).toEqual([
      { num: 1, label: 'Yes' },
      { num: 2, label: 'No' },
    ])
  })
})

describe('resolveVisibleChoices', () => {
  const bashChoices: TrustPromptChoice[] = [
    { id: 'yes', label: 'Yes', keys: '1\n', labelPattern: '^Yes$' },
    {
      id: 'yes-session',
      label: 'Yes, and allow this session',
      keys: '2\n',
      labelPattern: 'Yes,?\\s+and\\s+allow\\s+this\\s+session',
    },
    { id: 'no', label: 'No', keys: '3\n', labelPattern: '^No$' },
  ]

  it('drops yes-session when 2.1.126 omits it from the menu', () => {
    const capture = loadFixture(FIXTURE_DIR_2_1_126, 'bash-command-two-choices.txt')
    const resolved = resolveVisibleChoices(bashChoices, capture)
    expect(resolved.map((c) => c.id)).toEqual(['yes', 'no'])
    // `yes` must now correspond to `1\n`, not the `1\n` we statically
    // declared in JSON — the rewrite is what protects us from future
    // reorders.
    expect(resolved.find((c) => c.id === 'yes')!.keys).toBe('1\n')
    expect(resolved.find((c) => c.id === 'no')!.keys).toBe('2\n')
  })

  it('keeps yes-session when the older 3-row layout is in effect', () => {
    const capture = [
      ' Bash command',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and allow this session',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const resolved = resolveVisibleChoices(bashChoices, capture)
    expect(resolved.map((c) => c.id)).toEqual(['yes', 'yes-session', 'no'])
    expect(resolved.find((c) => c.id === 'yes-session')!.keys).toBe('2\n')
    expect(resolved.find((c) => c.id === 'no')!.keys).toBe('3\n')
  })

  it('passes choices without a labelPattern through untouched (legacy fixtures)', () => {
    const legacyChoices: TrustPromptChoice[] = [
      { id: 'yes', label: 'Yes, I trust this folder', keys: 'Enter' },
      { id: 'no', label: 'No, exit', keys: '2\n' },
    ]
    const capture = loadFixture(FIXTURE_DIR_2_1_126, 'folder-trust-initial.txt')
    const resolved = resolveVisibleChoices(legacyChoices, capture)
    // Without labelPattern the helper preserves both rows as-is so
    // KB does not regress on patterns that have not been migrated.
    expect(resolved).toEqual(legacyChoices)
  })

  it('returns an empty list when the capture has no menu at all', () => {
    expect(resolveVisibleChoices(bashChoices, 'no menu here')).toEqual([])
  })

  it('binds the resolved keys to whatever number is on screen even if the order shifts', () => {
    // Hypothetical future Claude Code release that swaps Yes and No.
    const capture = [
      ' Bash command',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. No',
      '   2. Yes',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const resolved = resolveVisibleChoices(bashChoices, capture)
    expect(resolved.find((c) => c.id === 'yes')!.keys).toBe('2\n')
    expect(resolved.find((c) => c.id === 'no')!.keys).toBe('1\n')
  })

  it('uses the 2.1.97 folder-trust fixture to confirm forward compatibility with older live data', () => {
    const capture = loadFixture(FIXTURE_DIR_2_1_97, 'folder-trust-initial.txt')
    const folderChoices: TrustPromptChoice[] = [
      {
        id: 'yes',
        label: 'Yes, I trust this folder',
        keys: 'Enter',
        labelPattern: 'Yes,?\\s+I\\s+trust\\s+this\\s+folder',
      },
      {
        id: 'no',
        label: 'No, exit',
        keys: '2\n',
        labelPattern: 'No,?\\s+exit',
      },
    ]
    const resolved = resolveVisibleChoices(folderChoices, capture)
    // `yes` matches row 1 → "1\n"; KB sends Enter only when the menu
    // could not be parsed, which is not the case here. tmux-bridge
    // converts trailing \n to Enter so the UX is identical.
    expect(resolved.find((c) => c.id === 'yes')!.keys).toBe('1\n')
    expect(resolved.find((c) => c.id === 'no')!.keys).toBe('2\n')
  })
})

describe('buildDynamicChoices (TP-1, spec v1.2 §4-1-4)', () => {
  it('builds a Choice[] from every visible numbered row', () => {
    const capture = [
      ' ❯ 1. Yes',
      '   2. Yes, and allow this session',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const dynamic = buildDynamicChoices(capture)
    expect(dynamic).toEqual([
      { id: 'dynamic-1', label: 'Yes', keys: '1\n' },
      {
        id: 'dynamic-2',
        label: 'Yes, and allow this session',
        keys: '2\n',
      },
      { id: 'dynamic-3', label: 'No', keys: '3\n' },
    ])
  })

  it('returns an empty array when no menu rows are visible (caller falls back)', () => {
    expect(buildDynamicChoices('Some prose without any 1./2. menu')).toEqual([])
  })

  it('captures variants the static patterns never knew about (e.g. "don\'t ask again for: ...")', () => {
    // The historical TP-1 bug: bash-command static choices declared
    // "Yes, and allow this session", but Claude Code rendered
    // "Yes, and don't ask again for: curl *". The legacy resolver
    // dropped that row; dynamic extraction must keep it.
    const capture = [
      ' Bash command',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for: curl *",
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const dynamic = buildDynamicChoices(capture)
    expect(dynamic.map((c) => ({ id: c.id, label: c.label, keys: c.keys }))).toEqual([
      { id: 'dynamic-1', label: 'Yes', keys: '1\n' },
      {
        id: 'dynamic-2',
        label: "Yes, and don't ask again for: curl *",
        keys: '2\n',
      },
      { id: 'dynamic-3', label: 'No', keys: '3\n' },
    ])
  })

  it('shortens labels longer than 50 characters and exposes the original via fullLabel', () => {
    const longLabel =
      'Yes, and allow all subsequent edits without prompting for the rest of this Claude Code session'
    const capture = [
      ' ❯ 1. Yes',
      `   2. ${longLabel}`,
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    const dynamic = buildDynamicChoices(capture)
    const long = dynamic[1]
    expect(long.id).toBe('dynamic-2')
    expect(long.label.endsWith('…')).toBe(true)
    // 30 prefix + ellipsis = 31 visible characters
    expect(long.label.length).toBe(31)
    expect(long.fullLabel).toBe(longLabel)
  })

  it('does not set fullLabel for labels at or below the 50-character budget', () => {
    const shortLabel = 'Yes, and allow this session'
    const capture = [
      ' ❯ 1. Yes',
      `   2. ${shortLabel}`,
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    const dynamic = buildDynamicChoices(capture)
    const second = dynamic[1]
    expect(second.label).toBe(shortLabel)
    expect(second.fullLabel).toBeUndefined()
  })

  it('uses the live 2.1.126 bash-two-choices fixture so KB shows whichever rows are on screen', () => {
    const capture = loadFixture(FIXTURE_DIR_2_1_126, 'bash-command-two-choices.txt')
    const dynamic = buildDynamicChoices(capture)
    // The fixture shows "1. Yes" and "2. No" (per-session row dropped).
    expect(dynamic.map((c) => c.id)).toEqual(['dynamic-1', 'dynamic-2'])
    expect(dynamic[0].label).toMatch(/^Yes/)
    expect(dynamic[1].label).toMatch(/^No/)
    expect(dynamic[0].keys).toBe('1\n')
    expect(dynamic[1].keys).toBe('2\n')
  })
})
