/**
 * loadTrustPatterns 単体テスト
 *
 * 仕様書 §7-3-1「パターン定義 JSON のスキーマバリデーション」に対応。
 * 不正な JSON / 空 patterns / 欠損フィールドで正しく例外が投げられることを確認する。
 */
import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { loadTrustPatterns } from '../../src/server/trust-prompt-detector'
import { DirectFsLayer } from '../../src/server/fs-layer'
import type { FileAccessLayer } from '../../src/server/fs-layer'

const PATTERNS_JSON = join(__dirname, '../../src/server/trust-patterns.json')

describe('loadTrustPatterns 正常系', () => {
  it('trust-patterns.json を正しくコンパイルする', () => {
    const fs = new DirectFsLayer()
    const patterns = loadTrustPatterns(fs, PATTERNS_JSON)
    expect(patterns.length).toBeGreaterThan(0)

    // 全パターンが必須フィールドを持つ
    for (const p of patterns) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.kind).toBe('string')
      expect(typeof p.priority).toBe('number')
      expect(p.matchAny.length).toBeGreaterThan(0)
      expect(p.footer).toBeInstanceOf(RegExp)
      expect(Array.isArray(p.choices)).toBe(true)
    }
  })

  it('5 つのパターンが定義されている', () => {
    const fs = new DirectFsLayer()
    const patterns = loadTrustPatterns(fs, PATTERNS_JSON)
    expect(patterns).toHaveLength(5)
    const ids = patterns.map(p => p.id).sort()
    expect(ids).toEqual([
      'bash-command',
      'edit-update-existing',
      'folder-trust-initial',
      'sandbox-network-escape',
      'write-create-new',
    ])
  })

  it('RegExp は multiline フラグ付きでコンパイルされる', () => {
    const fs = new DirectFsLayer()
    const patterns = loadTrustPatterns(fs, PATTERNS_JSON)
    for (const p of patterns) {
      expect(p.footer.flags).toContain('m')
      for (const r of p.matchAny) {
        expect(r.flags).toContain('m')
      }
    }
  })
})

describe('loadTrustPatterns 異常系', () => {
  /** readFileSync をモックする簡易 fs */
  function mockFs(content: string): FileAccessLayer {
    return {
      readFileSync: () => content,
      readBytesSync: () => Buffer.alloc(0),
      writeFileSync: () => {},
      unlinkSync: () => {},
      existsSync: () => false,
      statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
      readdirSync: () => [],
      mkdirSync: () => {},
      watch: () => ({ close: () => {} }),
    }
  }

  it('ファイルが存在しない場合は例外', () => {
    const fs: FileAccessLayer = {
      ...mockFs(''),
      readFileSync: () => { throw new Error('ENOENT') },
    }
    expect(() => loadTrustPatterns(fs, '/nonexistent.json'))
      .toThrow('Failed to read trust-patterns.json')
  })

  it('不正な JSON は例外', () => {
    const fs = mockFs('{ invalid json }}}')
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('Failed to parse trust-patterns.json')
  })

  it('patterns 配列がない場合は例外', () => {
    const fs = mockFs('{"version": "test"}')
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('has no patterns array')
  })

  it('patterns が空配列の場合は例外', () => {
    const fs = mockFs('{"patterns": []}')
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('patterns array is empty')
  })

  it('パターンの必須フィールドが欠損している場合は例外', () => {
    const json = JSON.stringify({
      patterns: [{ id: 'test' }], // kind, priority, matchAny, footer, choices が欠損
    })
    const fs = mockFs(json)
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('pattern definition is incomplete')
  })

  it('matchAny が空配列の場合は例外', () => {
    const json = JSON.stringify({
      patterns: [{
        id: 'test',
        kind: 'bash',
        priority: 50,
        matchAny: [],
        footer: 'test',
        choices: [],
      }],
    })
    const fs = mockFs(json)
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('has empty matchAny')
  })

  it('不正な RegExp は例外', () => {
    const json = JSON.stringify({
      patterns: [{
        id: 'test',
        kind: 'bash',
        priority: 50,
        matchAny: ['[invalid regex'],
        footer: 'test',
        choices: [],
      }],
    })
    const fs = mockFs(json)
    expect(() => loadTrustPatterns(fs, '/test.json'))
      .toThrow('RegExp compilation failed')
  })
})
