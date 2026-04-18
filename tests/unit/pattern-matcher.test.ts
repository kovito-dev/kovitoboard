/**
 * PatternMatcher 単体テスト
 *
 * 仕様書 §7-3-1「各パターン regex の正マッチ・不マッチテスト」に対応。
 * 検証 fixture（Claude Code 2.1.97 の実測 capture）を使い、
 * 各パターンが正しく検出・抽出されることを確認する。
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
  const patterns = loadTrustPatterns(fs, PATTERNS_JSON)
  matcher = new PatternMatcher(patterns)
})

// =========================
// 正マッチテスト
// =========================

describe('PatternMatcher 正マッチ', () => {
  it('folder-trust-initial: フォルダ信頼プロンプトを検出する', () => {
    const capture = loadFixture('folder-trust-initial.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('folder-trust-initial')
    expect(result!.pattern.kind).toBe('folder-trust')
    expect(result!.degenerate).toBe(false)
    // workspace パスの抽出
    expect(result!.extracted.workspace).toMatch(/kb-test-example/)
  })

  it('edit-modify-existing: Edit(Update) プロンプトを検出する', () => {
    const capture = loadFixture('edit-modify-existing.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('edit-update-existing')
    expect(result!.pattern.kind).toBe('edit')
    expect(result!.degenerate).toBe(false)
    // パス抽出
    expect(result!.extracted.path).toBe('sample.txt')
  })

  it('write-create-new-file: Write プロンプトを検出する', () => {
    const capture = loadFixture('write-create-new-file.txt')
    const result = matcher.match(capture)
    expect(result).not.toBeNull()
    expect(result!.pattern.id).toBe('write-create-new')
    expect(result!.pattern.kind).toBe('write')
    expect(result!.degenerate).toBe(false)
    // パス抽出
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
    // host 抽出
    expect(result!.extracted.host).toMatch(/example\.com/)
  })
})

// =========================
// 不マッチテスト
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
    // "? for shortcuts" を含む通常画面をシミュレート
    // ただしこれは PatternMatcher ではなく除外条件で弾く対象なので、
    // matcher.match() 自体はフッターが合わなければ null になる
    const normalPrompt = `
╭─── Claude Code v2.1.97 ──╮
│   Welcome back Kousuke!   │
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
// choices の構造テスト
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
