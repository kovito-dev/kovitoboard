/**
 * 状態ベース検知テスト（除外条件・フッター・ユーティリティ）
 *
 * 仕様書 §7-3-1「状態ベース検知の各シグナル単独テスト」
 * 「状態ベース検知の組み合わせ判定テスト」に対応。
 *
 * TrustPromptDetector の private メソッド (isExcluded / hasTrustFooter) は
 * 直接テストできないため、同じ regex パターンを用いて振る舞いを検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { lastNonEmptyLine, tailLines } from '../../src/server/trust-prompt-detector'

const FIXTURE_DIR = join(__dirname, '../fixtures/trust-prompts/claude-2.1.97')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8')
}

// =========================
// ユーティリティ関数テスト
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
// 除外条件テスト
// =========================

// TrustPromptDetector 内と同じ定義を再現
const EXCLUDE_PATTERNS: RegExp[] = [
  /\? for shortcuts/,
  /⎿\s+Running…/,
  /✢\s+\w+…\s+\(thinking\)/,
]

const EXCLUDE_CHECK_TAIL_LINES = 5

/** 実装と同じロジック: 末尾行のみで除外判定 */
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
      // trust prompt の末尾行は除外パターンに該当しない
      // (sandbox-network の capture 全体には歴史行として Running… が含まれるが、
      //  末尾 5 行限定の判定では除外されない)
      expect(isExcluded(capture)).toBe(false)
    }
  })

  it('plan-mode-refusal（通常応答）は ? for shortcuts を含まないが除外されない', () => {
    const capture = loadFixture('bash-plan-mode-refusal.txt')
    // plan-mode-refusal の末尾は「⏸ plan mode on (shift+tab to cycle)」
    // これは除外条件にマッチしない
    expect(isExcluded(capture)).toBe(false)
  })
})

// =========================
// フッターパターンテスト
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
// 組み合わせ判定テスト
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
