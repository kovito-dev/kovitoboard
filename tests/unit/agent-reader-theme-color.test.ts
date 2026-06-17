/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for themeColor frontmatter parsing in agent-reader.
 *
 * Regression for the bug where the reader regex accepted only
 * double-quoted hex values (`"#hex"`) while the writer (gray-matter /
 * js-yaml) single-quotes values that begin with `#` to keep them from
 * being read as YAML comments. Single-quoted colors were therefore
 * silently dropped to the fallback color.
 *
 * Coverage: all three serialized quote styles (single / double /
 * unquoted) plus a writer -> reader round-trip through the real
 * `safeStringify` serializer so a future change to the writer's quote
 * style is caught here too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadAgentDefinitions } from '../../src/server/agent-reader'
import { safeStringify } from '../../src/server/recipe/safe-matter'
import { _resetProjectRootCache } from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import type { ViewerConfig } from '../../src/server/types'

const PROJECT_ROOT = '/project'
const AGENTS_DIR = `${PROJECT_ROOT}/.claude/agents`

function createMockFs(files: Record<string, string>): FileAccessLayer {
  const dirs: Record<string, string[]> = {
    [AGENTS_DIR]: Object.keys(files)
      .map((p) => p.slice(AGENTS_DIR.length + 1))
      .filter((name) => name.length > 0 && !name.includes('/')),
  }
  return {
    existsSync: (p: string) => p in files || p in dirs,
    readFileSync: (p: string) => {
      if (p in files) return files[p]
      throw new Error(`ENOENT: ${p}`)
    },
    readdirSync: (p: string) => dirs[p] ?? [],
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    writeFileSync: () => {},
    unlinkSync: () => {},
    mkdirSync: () => {},
    symlinkSync: () => {},
    readBytesSync: () => Buffer.alloc(0),
    watch: () => ({ close: () => {} }),
  } as unknown as FileAccessLayer
}

function makeConfig(): ViewerConfig {
  return {
    claudeDir: '/home/user/.claude',
    watcher: { usePolling: true, pollInterval: 1500 },
    agents: {},
    user: { name: 'User', color: '#000' },
    ui: { theme: 'dark', maxPreviewHeight: 300, autoScroll: true },
    window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
    project: undefined,
  } as unknown as ViewerConfig
}

function agentFile(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# Test Agent\n`
}

function readColor(files: Record<string, string>): string | undefined {
  const fs = createMockFs(files)
  const agents = loadAgentDefinitions(fs, makeConfig())
  return agents.find((a) => a.id === 'test')?.color
}

describe('agent-reader themeColor quote styles', () => {
  const originalArgv = [...process.argv]
  const originalEnv = { ...process.env }

  beforeEach(() => {
    _resetProjectRootCache()
    delete process.env.KOVITOBOARD_PROJECT_ROOT
    process.argv = ['node', 'index.ts', '--project-root', PROJECT_ROOT]
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env = originalEnv
    _resetProjectRootCache()
  })

  it('reads a single-quoted hex themeColor (the writer default)', () => {
    const files = {
      [`${AGENTS_DIR}/test.md`]: agentFile(`name: test\nthemeColor: '#f59e0b'`),
    }
    expect(readColor(files)).toBe('#f59e0b')
  })

  it('reads a double-quoted hex themeColor', () => {
    const files = {
      [`${AGENTS_DIR}/test.md`]: agentFile(`name: test\nthemeColor: "#f59e0b"`),
    }
    expect(readColor(files)).toBe('#f59e0b')
  })

  it('reads an unquoted hex themeColor', () => {
    const files = {
      [`${AGENTS_DIR}/test.md`]: agentFile(`name: test\nthemeColor: #f59e0b`),
    }
    expect(readColor(files)).toBe('#f59e0b')
  })

  it('reads a 3-digit hex themeColor', () => {
    const files = {
      [`${AGENTS_DIR}/test.md`]: agentFile(`name: test\nthemeColor: '#abc'`),
    }
    expect(readColor(files)).toBe('#abc')
  })

  it('falls back to the default color when themeColor is absent', () => {
    const files = {
      [`${AGENTS_DIR}/test.md`]: agentFile(`name: test`),
    }
    expect(readColor(files)).toBe('#6B7280')
  })

  it('round-trips a themeColor written by safeStringify back through the reader', () => {
    // Build the file with the real writer-side serializer so a future
    // change to its quote style would fail this assertion.
    const serialized = safeStringify('# Test Agent\n', {
      name: 'test',
      themeColor: '#f59e0b',
    })
    // Sanity check: the serializer single-quotes #-prefixed values.
    expect(serialized).toContain("themeColor: '#f59e0b'")

    const files = { [`${AGENTS_DIR}/test.md`]: serialized }
    expect(readColor(files)).toBe('#f59e0b')
  })
})
