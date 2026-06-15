/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for resolveProjectRoot() (DEC-009)
 *
 * Verifies 4 priority cases:
 * 1. --project-root CLI argument
 * 2. KOVITOBOARD_PROJECT_ROOT environment variable
 * 3. .kovitoboard/setting.json project.path
 * 4. process.cwd() fallback
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveProjectRoot,
  resolveProjectRootWithSource,
  _resetProjectRootCache,
} from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'

/** Minimal mock for FileAccessLayer */
function createMockFs(files: Record<string, string> = {}): FileAccessLayer {
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (p in files) return files[p]
      throw new Error(`ENOENT: ${p}`)
    },
    readdirSync: () => [],
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    writeFileSync: () => {},
    unlinkSync: () => {},
    mkdirSync: () => {},
    symlinkSync: () => {},
    watch: () => ({ close: () => {} }) as unknown as ReturnType<FileAccessLayer['watch']>,
  } as FileAccessLayer
}

describe('resolveProjectRoot (DEC-009)', () => {
  const originalArgv = [...process.argv]
  const originalEnv = { ...process.env }
  const originalCwd = process.cwd()

  beforeEach(() => {
    // Reset cache before each test
    _resetProjectRootCache()
    // Restore argv and env
    process.argv = [...originalArgv]
    delete process.env.KOVITOBOARD_PROJECT_ROOT
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env = originalEnv
    _resetProjectRootCache()
  })

  it('ケース1: --project-root CLI 引数が最優先', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/foo']
    const fs = createMockFs()
    expect(resolveProjectRoot(fs)).toBe('/tmp/foo')
  })

  it('ケース1b: --project-root=value 形式も対応', () => {
    process.argv = ['node', 'index.ts', '--project-root=/tmp/bar']
    const fs = createMockFs()
    expect(resolveProjectRoot(fs)).toBe('/tmp/bar')
  })

  it('ケース2: 環境変数 KOVITOBOARD_PROJECT_ROOT', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = '/tmp/env-root'
    const fs = createMockFs()
    expect(resolveProjectRoot(fs)).toBe('/tmp/env-root')
  })

  it('ケース2b: 環境変数が空文字の場合はスキップ', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = '   '
    const fs = createMockFs()
    // Should fall through to cwd
    expect(resolveProjectRoot(fs)).toBe(originalCwd)
  })

  it('ケース3: .kovitoboard/setting.json の project.path', () => {
    const settingPath = `${originalCwd}/.kovitoboard/setting.json`
    const fs = createMockFs({
      [settingPath]: JSON.stringify({
        version: '1.1',
        project: { name: 'test', description: '', path: '/tmp/persisted' },
      }),
    })
    expect(resolveProjectRoot(fs)).toBe('/tmp/persisted')
  })

  it('ケース3b: setting.json の project.path が空文字ならスキップ', () => {
    const settingPath = `${originalCwd}/.kovitoboard/setting.json`
    const fs = createMockFs({
      [settingPath]: JSON.stringify({
        version: '1.1',
        project: { name: 'test', description: '', path: '' },
      }),
    })
    expect(resolveProjectRoot(fs)).toBe(originalCwd)
  })

  // `readPersistedProjectRoot` does not go through `validateSetting()`, so
  // the absolute-path invariant (`data-persistence.md` §6.1.1) is enforced
  // at this read site. A relative `project.path` must be rejected
  // fail-loud (return null → fall through to cwd-fallback) instead of being
  // resolved against the launch cwd, which would retarget the project root.
  it('ケース3c: setting.json の project.path が相対パスならスキップ（絶対パス強制）', () => {
    const settingPath = `${originalCwd}/.kovitoboard/setting.json`
    for (const relPath of ['relative/folder', './dot', '../parent']) {
      _resetProjectRootCache()
      const fs = createMockFs({
        [settingPath]: JSON.stringify({
          version: '1.1',
          project: { name: 'test', description: '', path: relPath },
        }),
      })
      // Falls through to cwd-fallback rather than resolve(relPath) against cwd.
      expect(resolveProjectRoot(fs)).toBe(originalCwd)
    }
  })

  it('ケース4: すべて無ければ process.cwd()', () => {
    const fs = createMockFs()
    expect(resolveProjectRoot(fs)).toBe(originalCwd)
  })

  it('優先順位: CLI 引数 > 環境変数 > setting.json', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/cli']
    process.env.KOVITOBOARD_PROJECT_ROOT = '/tmp/env'
    const settingPath = `${originalCwd}/.kovitoboard/setting.json`
    const fs = createMockFs({
      [settingPath]: JSON.stringify({
        version: '1.1',
        project: { name: 'test', description: '', path: '/tmp/persisted' },
      }),
    })
    expect(resolveProjectRoot(fs)).toBe('/tmp/cli')
  })

  it('キャッシュ: 2回目の呼び出しはキャッシュから返される', () => {
    const fs = createMockFs()
    const spy = vi.spyOn(fs, 'existsSync')
    const first = resolveProjectRoot(fs)
    const second = resolveProjectRoot(fs)
    expect(first).toBe(second)
    // existsSync should only be called on the first invocation
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('resolveProjectRootWithSource (DEC-014): source tracking', () => {
  const originalArgv = [...process.argv]
  const originalEnv = { ...process.env }
  const originalCwd = process.cwd()

  beforeEach(() => {
    _resetProjectRootCache()
    process.argv = [...originalArgv]
    delete process.env.KOVITOBOARD_PROJECT_ROOT
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env = originalEnv
    _resetProjectRootCache()
  })

  it('source: cli-arg', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/cli-src']
    const fs = createMockFs()
    expect(resolveProjectRootWithSource(fs)).toEqual({
      path: '/tmp/cli-src',
      source: 'cli-arg',
    })
  })

  it('source: env', () => {
    process.env.KOVITOBOARD_PROJECT_ROOT = '/tmp/env-src'
    const fs = createMockFs()
    expect(resolveProjectRootWithSource(fs)).toEqual({
      path: '/tmp/env-src',
      source: 'env',
    })
  })

  it('source: setting-json', () => {
    const settingPath = `${originalCwd}/.kovitoboard/setting.json`
    const fs = createMockFs({
      [settingPath]: JSON.stringify({
        version: '1.1',
        project: { name: 'test', description: '', path: '/tmp/persisted-src' },
      }),
    })
    expect(resolveProjectRootWithSource(fs)).toEqual({
      path: '/tmp/persisted-src',
      source: 'setting-json',
    })
  })

  it('source: cwd-fallback', () => {
    const fs = createMockFs()
    expect(resolveProjectRootWithSource(fs)).toEqual({
      path: originalCwd,
      source: 'cwd-fallback',
    })
  })

  it('resolveProjectRoot() returns the same path', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/wrap']
    const fs = createMockFs()
    expect(resolveProjectRoot(fs)).toBe(resolveProjectRootWithSource(fs).path)
  })
})
