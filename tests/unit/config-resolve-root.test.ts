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
import { resolveProjectRoot, _resetProjectRootCache } from '../../src/server/config'
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
