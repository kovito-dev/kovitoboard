/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * AA-3: `createAgentFromScratch` — build an agent definition file
 * without a template.
 *
 * The scratch path is what powers the "Build from scratch" card on
 * the AgentCreatePage. These tests pin the file shape (frontmatter
 * fields, body content, optional-field omission rules) so a future
 * refactor cannot silently change what lands on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createAgentFromScratch,
  type CreateScratchAgentOptions,
} from '../../src/server/agent-writer'
import { _resetProjectRootCache } from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'

interface MockFs extends FileAccessLayer {
  files: Map<string, string>
  dirs: Set<string>
}

function createMockFs(): MockFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: (p: string, content: string | Buffer) => {
      files.set(p, content.toString())
    },
    unlinkSync: (p: string) => {
      files.delete(p)
    },
    rmSync: () => {},
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    readdirSync: () => [],
    mkdirSync: (p: string) => {
      dirs.add(p)
    },
    symlinkSync: () => {},
    watch: () => ({ close: () => {} }),
  } as unknown as MockFs
}

const ORIGINAL_ARGV = [...process.argv]
const PROJECT_ROOT = '/tmp/scratch-project'

function baseOptions(overrides: Partial<CreateScratchAgentOptions> = {}): CreateScratchAgentOptions {
  return {
    agentId: 'reviewer',
    displayName: 'Code Reviewer',
    description: 'Reviews PRs for clarity and correctness',
    systemPrompt: 'You are a senior reviewer. Focus on intent and risk.',
    ...overrides,
  }
}

describe('createAgentFromScratch (AA-3)', () => {
  let fs: MockFs

  beforeEach(() => {
    _resetProjectRootCache()
    process.argv = [...ORIGINAL_ARGV, `--project-root=${PROJECT_ROOT}`]
    fs = createMockFs()
    fs.dirs.add(PROJECT_ROOT)
  })

  afterEach(() => {
    process.argv = ORIGINAL_ARGV
    _resetProjectRootCache()
  })

  it('writes a frontmatter + body file under .claude/agents/', () => {
    const result = createAgentFromScratch(fs, baseOptions())
    expect(result.success).toBe(true)
    expect(result.filePath).toBe(`${PROJECT_ROOT}/.claude/agents/reviewer.md`)

    const written = fs.files.get(result.filePath!)
    expect(written).toBeDefined()
    expect(written).toContain('---')
    expect(written).toContain('name: reviewer')
    expect(written).toContain('displayName: Code Reviewer')
    expect(written).toContain('description: Reviews PRs for clarity and correctness')
    expect(written).toContain('You are a senior reviewer. Focus on intent and risk.')
  })

  it('omits optional fields from the frontmatter when blank', () => {
    // The reader treats `model: ""` as "explicitly cleared" but the
    // operator's intent on create is "never set" — keep the line
    // off the file entirely so default / inherited behaviour holds.
    const result = createAgentFromScratch(fs, baseOptions())
    expect(result.success).toBe(true)
    const written = fs.files.get(result.filePath!)!
    expect(written).not.toContain('model:')
    expect(written).not.toContain('themeColor:')
  })

  it('emits model + themeColor when the operator supplies them', () => {
    const result = createAgentFromScratch(
      fs,
      baseOptions({ model: 'sonnet', themeColor: '#a855f7' }),
    )
    expect(result.success).toBe(true)
    const written = fs.files.get(result.filePath!)!
    expect(written).toContain('model: sonnet')
    expect(written).toContain("themeColor: '#a855f7'")
  })

  it('rejects invalid agent IDs without writing anything', () => {
    const result = createAgentFromScratch(fs, baseOptions({ agentId: 'has spaces' }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid agent ID/i)
    expect(fs.files.size).toBe(0)
  })

  it('rejects a blank displayName / description / systemPrompt', () => {
    expect(
      createAgentFromScratch(fs, baseOptions({ displayName: '   ' })).success,
    ).toBe(false)
    expect(
      createAgentFromScratch(fs, baseOptions({ description: '' })).success,
    ).toBe(false)
    expect(
      createAgentFromScratch(fs, baseOptions({ systemPrompt: '\n\n' })).success,
    ).toBe(false)
    // None of the rejected calls should have left a file behind.
    expect(fs.files.size).toBe(0)
  })

  it('returns a 409-shaped error when the agent already exists', () => {
    const path = `${PROJECT_ROOT}/.claude/agents/reviewer.md`
    fs.files.set(path, 'existing')
    fs.dirs.add(`${PROJECT_ROOT}/.claude/agents`)

    const result = createAgentFromScratch(fs, baseOptions())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already exists/i)
    // Ensure the existing file was not overwritten.
    expect(fs.files.get(path)).toBe('existing')
  })

  it('creates .claude/agents/ on demand (mkdirSync recursive)', () => {
    expect(fs.dirs.has(`${PROJECT_ROOT}/.claude/agents`)).toBe(false)
    const result = createAgentFromScratch(fs, baseOptions())
    expect(result.success).toBe(true)
    expect(fs.dirs.has(`${PROJECT_ROOT}/.claude/agents`)).toBe(true)
  })

  it('does not inject KB:* marker blocks (markers stay opt-in via AD-2)', () => {
    // Markers belong to template-derived agents by default; scratch
    // agents are minimal so the user can author the persona before
    // deciding whether to surface a structured editor.
    const result = createAgentFromScratch(fs, baseOptions())
    expect(result.success).toBe(true)
    const written = fs.files.get(result.filePath!)!
    expect(written).not.toContain('KB:PERSONALITY')
    expect(written).not.toContain('KB:TONE_SAMPLE')
    expect(written).not.toContain('KB:EXTRA_INSTRUCTIONS')
  })

  it('trims whitespace from displayName / description / systemPrompt', () => {
    const result = createAgentFromScratch(
      fs,
      baseOptions({
        displayName: '  Code Reviewer  ',
        description: '\n\nReviews PRs\n',
        systemPrompt: '\nYou are a reviewer.\n\n',
      }),
    )
    expect(result.success).toBe(true)
    const written = fs.files.get(result.filePath!)!
    expect(written).toContain('displayName: Code Reviewer')
    expect(written).toContain('description: Reviews PRs')
    expect(written).toContain('You are a reviewer.')
    // Trailing newline normalized — no double blank line right
    // before the closing of the frontmatter or at EOF.
    expect(written.endsWith('\n')).toBe(true)
    expect(written).not.toMatch(/\n\n\n/)
  })
})
