/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * PatternMatcher unit tests
 *
 * Corresponds to spec §7-3-1 "Positive/negative match tests for each pattern regex".
 * Uses verification fixtures (live captures from Claude Code 2.1.97) to confirm
 * each pattern is correctly detected and extracted.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PatternMatcher, loadTrustPatterns, type MatchResult } from '../../src/server/trust-prompt-detector'
import { DirectFsLayer } from '../../src/server/fs-layer'

const FIXTURE_DIR = join(__dirname, '../fixtures/trust-prompts/claude-2.1.97')
const PATTERNS_JSON = join(__dirname, '../../src/server/trust-patterns.json')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8')
}

let matcher: PatternMatcher

beforeAll(() => {
  const fs = new DirectFsLayer()
  const config = loadTrustPatterns(fs, PATTERNS_JSON)
  matcher = new PatternMatcher(config.patterns)
})

// =========================
// Positive match tests
// =========================

describe('PatternMatcher 正マッチ', () => {
  it('folder-trust-initial: フォルダ信頼プロンプトを検出する', () => {
    const capture = loadFixture('folder-trust-initial.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('folder-trust-initial')
    expect(result!.pattern.kind).toBe('folder-trust')
    expect(result!.degenerate).toBe(false)
    // Workspace path extraction
    expect(result!.extracted.workspace).toMatch(/kb-test-example/)
  })

  it('edit-modify-existing: Edit(Update) プロンプトを検出する', () => {
    const capture = loadFixture('edit-modify-existing.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('edit-update-existing')
    expect(result!.pattern.kind).toBe('edit')
    expect(result!.degenerate).toBe(false)
    // Path extraction
    expect(result!.extracted.path).toBe('sample.txt')
  })

  it('write-create-new-file: Write プロンプトを検出する', () => {
    const capture = loadFixture('write-create-new-file.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('write-create-new')
    expect(result!.pattern.kind).toBe('write')
    expect(result!.degenerate).toBe(false)
    // Path extraction
    expect(result!.extracted.path).toBe('.claude/agents/test-agent.md')
  })

  it('bash-short-redirect: Bash プロンプトを検出する', () => {
    const capture = loadFixture('bash-short-redirect.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
    expect(result!.pattern.kind).toBe('bash')
  })

  it('bash-touch-command: Bash プロンプトを検出する', () => {
    const capture = loadFixture('bash-touch-command.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
  })

  it('bash-long-piped: 長いパイプの Bash プロンプトを検出する', () => {
    const capture = loadFixture('bash-long-piped.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
  })

  it('bash-grep-pipe: grep パイプの Bash プロンプトを検出する', () => {
    const capture = loadFixture('bash-grep-pipe.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
  })

  it('bash-multiline-heredoc: heredoc 複合の Bash プロンプトを検出する', () => {
    const capture = loadFixture('bash-multiline-heredoc.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
  })

  it('sandbox-network-escape: Sandbox Network プロンプトを検出する', () => {
    const capture = loadFixture('sandbox-network-escape.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('sandbox-network-escape')
    expect(result!.pattern.kind).toBe('sandbox-network')
    // Host extraction
    expect(result!.extracted.host).toMatch(/example\.com/)
  })
})

// =========================
// read-file pattern tests
// =========================

describe('read-file pattern', () => {
  it('detects Read prompt with matchAny + footer', () => {
    const capture = loadFixture('read-file-01.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('read-file')
    expect(result!.pattern.kind).toBe('read')
    // Check path extraction
    expect(result!.extracted.path).toMatch(/README\.md/)
  })

  it('does not match when footer differs from read-file footer', () => {
    // Create a synthetic capture that has Read pattern body text
    // but uses Bash footer ("ctrl+e to explain") — should not match read-file
    const capture = [
      '● Read(/path/to/file.txt)',
      'Read file',
      'Do you want to proceed?',
      '1. Yes',
      '2. No',
      'ctrl+e to explain',
    ].join('\n')
    const result = matcher.match(capture)
    // Should match bash-command (which uses ctrl+e footer), NOT read-file
    if (result) {
      expect(result.pattern.id).not.toBe('read-file')
    }
  })

  it('extracts path from "● Read(...)" activity line', () => {
    const capture = loadFixture('read-file-01.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.extracted.path).toBeDefined()
    expect(typeof result!.extracted.path).toBe('string')
  })

  it('read-file has yes/yes-session/no 3 choices', () => {
    const capture = loadFixture('read-file-01.txt')
    const result = matcher.match(capture)!
    expect(result.pattern.choices).toHaveLength(3)
    expect(result.pattern.choices.map(c => c.id)).toEqual(['yes', 'yes-session', 'no'])
  })
})

// =========================
// Claude Code 2.1.126 fixtures
// =========================

describe('PatternMatcher 2.1.126', () => {
  const FIXTURE_DIR_2_1_126 = join(__dirname, '../fixtures/trust-prompts/claude-2.1.126')
  const load = (name: string) => readFileSync(join(FIXTURE_DIR_2_1_126, name), 'utf-8')

  it('matches the new 2-choice bash prompt and exposes labelPattern on every choice', () => {
    const capture = load('bash-command-two-choices.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('bash-command')
    // Every migrated choice must declare a labelPattern; otherwise
    // resolveVisibleChoices cannot rewrite keys for the 2-choice menu.
    for (const c of result!.pattern.choices) {
      expect(c.labelPattern, `choice "${c.id}" missing labelPattern`).toBeDefined()
    }
  })

  it('still matches the unchanged folder-trust layout', () => {
    const capture = load('folder-trust-initial.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('folder-trust-initial')
  })
})

// =========================
// Negative match tests
// =========================

describe('PatternMatcher 不マッチ', () => {
  it('bash-plan-mode-refusal: trust prompt ではないので null を返す', () => {
    const capture = loadFixture('bash-plan-mode-refusal.txt')
    const result = matcher.match(capture)
    expect(result).toBeNull()
  })

  it('空文字列は null を返す', () => {
    expect(matcher.match('')).toBeNull()
  })

  it('通常の入力待ち画面は null を返す', () => {
    // Simulate a normal screen containing "? for shortcuts"
    // This is actually meant to be rejected by exclusion conditions, not PatternMatcher,
    // so matcher.match() itself returns null if the footer does not match
    const normalPrompt = `
╭─── Claude Code v2.1.97 ──╮
│  Welcome back Developer!  │
╰───────────────────────────╯

❯ Hello

  Hello! How can I help you today?

────────────────────
❯
────────────────────
  ? for shortcuts
`
    expect(matcher.match(normalPrompt)).toBeNull()
  })
})

// =========================
// Choices structure tests
// =========================

describe('PatternMatcher choices', () => {
  it('folder-trust は yes/no の 2 択を持つ', () => {
    const capture = loadFixture('folder-trust-initial.txt')
    const result = matcher.match(capture)!
    expect(result.pattern.choices).toHaveLength(2)
    expect(result.pattern.choices.map(c => c.id)).toEqual(['yes', 'no'])
  })

  it('bash-command は yes/yes-session/no の 3 択を持つ', () => {
    const capture = loadFixture('bash-short-redirect.txt')
    const result = matcher.match(capture)!
    expect(result.pattern.choices).toHaveLength(3)
    expect(result.pattern.choices.map(c => c.id)).toEqual(['yes', 'yes-session', 'no'])
  })
})
