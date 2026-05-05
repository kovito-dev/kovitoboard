/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * State-based detection tests (exclusion conditions, footer, utilities)
 *
 * Corresponds to spec §7-3-1 "Individual signal tests for state-based detection"
 * and "Combination judgment tests for state-based detection".
 *
 * TrustPromptDetector's private methods (isExcluded / hasTrustFooter) cannot be
 * tested directly, so the same regex patterns are used to verify behavior.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { lastNonEmptyLine, tailLines, normalizeForIdleHash } from '../../src/server/trust-prompt-detector'

const FIXTURE_DIR = join(__dirname, '../fixtures/trust-prompts/claude-2.1.97')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8')
}

// =========================
// Utility function tests
// =========================

describe('lastNonEmptyLine', () => {
  it('末尾に空行がある場合、最後の非空行を返す', () => {
    const text = 'line1\nline2\n  \n\n'
    expect(lastNonEmptyLine(text)).toBe('line2')
  })

  it('末尾が非空行の場合、その行を返す', () => {
    expect(lastNonEmptyLine('aaa\nbbb')).toBe('bbb')
  })

  it('全て空行の場合、空文字列を返す', () => {
    expect(lastNonEmptyLine('\n\n  \n')).toBe('')
  })

  it('空文字列は空文字列を返す', () => {
    expect(lastNonEmptyLine('')).toBe('')
  })
})

describe('tailLines', () => {
  it('末尾 n 行を返す', () => {
    const text = 'a\nb\nc\nd\ne'
    expect(tailLines(text, 3)).toBe('c\nd\ne')
  })

  it('n が総行数を超える場合、全行を返す', () => {
    const text = 'a\nb'
    expect(tailLines(text, 10)).toBe('a\nb')
  })

  it('空文字列は空文字列を返す', () => {
    expect(tailLines('', 5)).toBe('')
  })
})

// =========================
// Exclusion condition tests
// =========================

// Reproduce the same definitions as in TrustPromptDetector
const EXCLUDE_PATTERNS: RegExp[] = [
  /\? for shortcuts/,
  /⎿\s+Running…/,
  /✢\s+\w+…\s+\(thinking\)/,
]

const EXCLUDE_CHECK_TAIL_LINES = 5

/** Same logic as the implementation: exclusion check on tail lines only */
function isExcluded(capture: string): boolean {
  const tail = tailLines(capture, EXCLUDE_CHECK_TAIL_LINES)
  return EXCLUDE_PATTERNS.some((r) => r.test(tail))
}

describe('除外条件 (EXCLUDE_PATTERNS)', () => {
  it('通常の入力待ち画面（? for shortcuts）は除外される', () => {
    const capture = `
❯
────────────────────
  ? for shortcuts
`
    expect(isExcluded(capture)).toBe(true)
  })

  it('処理中（Running…）は除外される', () => {
    const capture = `
● Bash(echo hello)
  ⎿  Running…
`
    expect(isExcluded(capture)).toBe(true)
  })

  it('thinking 中は除外される', () => {
    const capture = `
✢ Transfiguring… (thinking)
`
    expect(isExcluded(capture)).toBe(true)
  })

  it('全 trust prompt fixture は除外されない（末尾行判定）', () => {
    const fixtures = [
      'folder-trust-initial.txt',
      'edit-modify-existing.txt',
      'write-create-new-file.txt',
      'bash-short-redirect.txt',
      'sandbox-network-escape.txt',
    ]
    for (const name of fixtures) {
      const capture = loadFixture(name)
      // Trust prompt tail lines do not match exclusion patterns
      // (sandbox-network capture contains Running... as a history line,
      //  but it is not excluded when checking only the last 5 lines)
      expect(isExcluded(capture)).toBe(false)
    }
  })

  it('plan-mode-refusal（通常応答）は ? for shortcuts を含まないが除外されない', () => {
    const capture = loadFixture('bash-plan-mode-refusal.txt')
    // plan-mode-refusal's last line is "plan mode on (shift+tab to cycle)"
    // This does not match exclusion conditions
    expect(isExcluded(capture)).toBe(false)
  })
})

// =========================
// Footer pattern tests
// =========================

const TRUST_FOOTER_PATTERNS: RegExp[] = [
  /Esc to cancel · Tab to amend/,
  /Enter to confirm · Esc to cancel/,
  /ctrl\+e to explain/,
  /tell Claude what to do differently/,
]

function hasTrustFooter(capture: string): boolean {
  const line = lastNonEmptyLine(capture)
  return TRUST_FOOTER_PATTERNS.some((r) => r.test(line))
}

describe('フッターパターン (TRUST_FOOTER_PATTERNS)', () => {
  it('folder-trust のフッター（Enter to confirm）を検出', () => {
    expect(hasTrustFooter(loadFixture('folder-trust-initial.txt'))).toBe(true)
  })

  it('edit のフッター（Esc to cancel · Tab to amend）を検出', () => {
    expect(hasTrustFooter(loadFixture('edit-modify-existing.txt'))).toBe(true)
  })

  it('write のフッター（Esc to cancel · Tab to amend）を検出', () => {
    expect(hasTrustFooter(loadFixture('write-create-new-file.txt'))).toBe(true)
  })

  it('bash のフッター（ctrl+e to explain）を検出', () => {
    expect(hasTrustFooter(loadFixture('bash-short-redirect.txt'))).toBe(true)
  })

  it('sandbox-network のフッター（tell Claude what to do differently）を検出', () => {
    expect(hasTrustFooter(loadFixture('sandbox-network-escape.txt'))).toBe(true)
  })

  it('plan-mode-refusal はフッターに一致しない', () => {
    expect(hasTrustFooter(loadFixture('bash-plan-mode-refusal.txt'))).toBe(false)
  })

  it('通常の入力待ち画面はフッターに一致しない', () => {
    const capture = `some output\n  ? for shortcuts\n\n`
    expect(hasTrustFooter(capture)).toBe(false)
  })
})

// =========================
// Combination judgment tests
// =========================

describe('除外条件 + フッター の組み合わせ', () => {
  it('除外されず & フッター一致 → trust prompt 候補（trust prompt fixture）', () => {
    const trustFixtures = [
      'folder-trust-initial.txt',
      'edit-modify-existing.txt',
      'write-create-new-file.txt',
      'sandbox-network-escape.txt',
    ]
    for (const name of trustFixtures) {
      const capture = loadFixture(name)
      expect(isExcluded(capture)).toBe(false)
      expect(hasTrustFooter(capture)).toBe(true)
    }
  })

  it('除外されず & フッター不一致 → 通常状態（plan-mode-refusal）', () => {
    const capture = loadFixture('bash-plan-mode-refusal.txt')
    expect(isExcluded(capture)).toBe(false)
    expect(hasTrustFooter(capture)).toBe(false)
  })
})


// =========================
// normalizeForIdleHash (DEC-014-followup: spinner-induced flicker)
// =========================

describe("normalizeForIdleHash", () => {
  it("same capture with toggled bullet hashes identically", () => {
    // Claude Code renders the bullet ON frame as "● Reading …" and the
    // OFF frame as "  Reading …" (two leading spaces). Both must
    // normalize to the same string so the idle hash stays stable.
    const withBullet =
      "line1\n● Reading 1 file… (ctrl+o to expand)\nline3\n"
    const withoutBullet =
      "line1\n  Reading 1 file… (ctrl+o to expand)\nline3\n"
    expect(normalizeForIdleHash(withBullet))
      .toBe(normalizeForIdleHash(withoutBullet))
  })

  it("only touches line-leading bullets, not inline characters", () => {
    const input = "prefix ● inline bullet stays\n● at start becomes space"
    const out = normalizeForIdleHash(input)
    expect(out).toContain("prefix ● inline")
    expect(out.split("\n")[1]).toBe("  at start becomes space")
  })

  it("is a no-op for captures with no bullet lines", () => {
    const input = "just some lines\nno bullets here\n"
    expect(normalizeForIdleHash(input)).toBe(input)
  })
})

