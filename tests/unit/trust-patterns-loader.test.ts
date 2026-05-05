/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for loadTrustPatterns
 *
 * Corresponds to spec §7-3-1 "Pattern definition JSON schema validation".
 * Verifies correct exceptions for invalid JSON / empty patterns / missing fields.
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
    const config = loadTrustPatterns(fs, PATTERNS_JSON)
    expect(config.patterns.length).toBeGreaterThan(0)

    // All patterns have required fields
    for (const p of config.patterns) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.kind).toBe('string')
      expect(typeof p.priority).toBe('number')
      expect(p.matchAny.length).toBeGreaterThan(0)
      expect(Array.isArray(p.footer)).toBe(true)
      expect(p.footer.length).toBeGreaterThan(0)
      expect(p.footer[0]).toBeInstanceOf(RegExp)
      expect(Array.isArray(p.choices)).toBe(true)
    }
  })

  it('7 つのパターンが定義されている', () => {
    const fs = new DirectFsLayer()
    const config = loadTrustPatterns(fs, PATTERNS_JSON)
    expect(config.patterns).toHaveLength(7)
    const ids = config.patterns.map(p => p.id).sort()
    expect(ids).toEqual([
      'auto-mode-enable',
      'bash-command',
      'edit-update-existing',
      'folder-trust-initial',
      'read-file',
      'sandbox-network-escape',
      'write-create-new',
    ])
  })

  it('RegExp は multiline フラグ付きでコンパイルされる', () => {
    const fs = new DirectFsLayer()
    const config = loadTrustPatterns(fs, PATTERNS_JSON)
    for (const p of config.patterns) {
      for (const f of p.footer) {
        expect(f.flags).toContain('m')
      }
      for (const r of p.matchAny) {
        expect(r.flags).toContain('m')
      }
    }
  })

  it('DEC-015: primaryTestedVersion / bestEffortVersions を読む', () => {
    const fs = new DirectFsLayer()
    const config = loadTrustPatterns(fs, PATTERNS_JSON)
    // Bumped to 2.1.126 on 2026-05-03 because 2.1.126 dropped the
    // per-session row from `bash-command`. The detector's labelPattern
    // resolution was added at the same time so KB tracks Anthropic's
    // live menu instead of trusting a static keys mapping.
    expect(config.primaryTestedVersion).toBe('2.1.126')
    expect(config.primaryTestedChannel).toBe('stable')
    expect(config.bestEffortVersions).toEqual(['2.1.x', '2.2.x'])
  })
})

describe('loadTrustPatterns DEC-015 schema', () => {
  /** Simple fs that mocks readFileSync */
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

  it('falls back to compatibleClaudeCodeVersions when bestEffortVersions is absent', () => {
    const json = JSON.stringify({
      compatibleClaudeCodeVersions: ['2.0.x'],
      patterns: [{ id: 'test', kind: 'bash', priority: 50, matchAny: ['test'], footer: 'test', choices: [] }],
    })
    const fs = mockFs(json)
    const config = loadTrustPatterns(fs, '/test.json')
    expect(config.bestEffortVersions).toEqual(['2.0.x'])
    expect(config.primaryTestedVersion).toBe('0.0.0') // default when not declared
  })

  it('defaults primaryTestedVersion to "0.0.0" when not declared', () => {
    const json = JSON.stringify({
      patterns: [{ id: 'test', kind: 'bash', priority: 50, matchAny: ['test'], footer: 'test', choices: [] }],
    })
    const fs = mockFs(json)
    const config = loadTrustPatterns(fs, '/test.json')
    expect(config.primaryTestedVersion).toBe('0.0.0')
    expect(config.primaryTestedChannel).toBe('stable')
    expect(config.bestEffortVersions).toEqual([])
  })

  it('reads all new schema fields when present', () => {
    const json = JSON.stringify({
      version: '2026-04-23',
      primaryTestedVersion: '2.1.104',
      primaryTestedChannel: 'stable',
      bestEffortVersions: ['2.1.x', '2.2.x'],
      patterns: [{ id: 'test', kind: 'bash', priority: 50, matchAny: ['test'], footer: 'test', choices: [] }],
    })
    const fs = mockFs(json)
    const config = loadTrustPatterns(fs, '/test.json')
    expect(config.primaryTestedVersion).toBe('2.1.104')
    expect(config.primaryTestedChannel).toBe('stable')
    expect(config.bestEffortVersions).toEqual(['2.1.x', '2.2.x'])
  })
})

describe('loadTrustPatterns footer array support (R2-3)', () => {
  /** Simple fs that mocks readFileSync */
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

  it('accepts footer as a string (backward compatible)', () => {
    const json = JSON.stringify({
      patterns: [{ id: 'test', kind: 'bash', priority: 50, matchAny: ['test'], footer: 'single footer', choices: [] }],
    })
    const fs = mockFs(json)
    const config = loadTrustPatterns(fs, '/test.json')
    expect(config.patterns[0].footer).toHaveLength(1)
    expect(config.patterns[0].footer[0]).toBeInstanceOf(RegExp)
    expect(config.patterns[0].footer[0].source).toBe('single footer')
  })

  it('accepts footer as a string array', () => {
    const json = JSON.stringify({
      patterns: [{ id: 'test', kind: 'bash', priority: 50, matchAny: ['test'], footer: ['footer A', 'footer B'], choices: [] }],
    })
    const fs = mockFs(json)
    const config = loadTrustPatterns(fs, '/test.json')
    expect(config.patterns[0].footer).toHaveLength(2)
  })
})

describe('loadTrustPatterns 異常系', () => {
  /** Simple fs that mocks readFileSync */
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
      patterns: [{ id: 'test' }], // kind, priority, matchAny, footer, choices are missing
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
