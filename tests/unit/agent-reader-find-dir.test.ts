/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for findAgentsDir behavior via loadAgentDefinitions (DEC-014).
 *
 * DEC-014 removes the two implicit fallbacks that existed in v0.1.0:
 *   - parent directory traversal from process.cwd()
 *   - ~/.claude/agents/ (claudeDir fallback)
 *
 * Only the strict path `<projectRoot>/.claude/agents/` is consulted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadAgentDefinitions } from '../../src/server/agent-reader'
import { _resetProjectRootCache } from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import type { ViewerConfig } from '../../src/server/types'

function createMockFs(files: Record<string, string>, dirs: Record<string, string[]>): FileAccessLayer {
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
  } as FileAccessLayer
}

function makeConfig(claudeDir: string): ViewerConfig {
  return {
    claudeDir,
    watcher: { usePolling: true, pollInterval: 1500 },
    agents: {},
    user: { name: 'User', color: '#000' },
    ui: { theme: 'dark', maxPreviewHeight: 300, autoScroll: true },
    window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
    project: undefined,
  }
}

const AGENT_MD = `---
name: test-agent
description: "A test agent"
model: sonnet
---

# Test Agent

Body.
`

describe('findAgentsDir (DEC-014): strict projectRoot resolution', () => {
  const originalArgv = [...process.argv]
  const originalEnv = { ...process.env }

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

  /**
   * Q13 / AA-7: `loadAgentDefinitions` now appends the system default
   * agent to every result. These DEC-014 cases only care about agents
   * sourced from `<projectRoot>/.claude/agents/`, so we filter the
   * synthetic system entry out before asserting.
   */
  function userAgents(all: ReturnType<typeof loadAgentDefinitions>) {
    return all.filter((a) => !a.isSystem)
  }

  it('case 1: returns agents from <projectRoot>/.claude/agents/ when it exists', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/proj']
    const agentsDir = '/tmp/proj/.claude/agents'
    const fs = createMockFs(
      { [`${agentsDir}/test-agent.md`]: AGENT_MD },
      { [agentsDir]: ['test-agent.md'] },
    )
    const config = makeConfig('/home/user/.claude')
    const agents = userAgents(loadAgentDefinitions(fs, config))
    expect(agents).toHaveLength(1)
    expect(agents[0].id).toBe('test-agent')
  })

  it('case 2: returns empty array when <projectRoot>/.claude/agents/ does not exist', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/empty-proj']
    const fs = createMockFs({}, {})
    const config = makeConfig('/home/user/.claude')
    const agents = userAgents(loadAgentDefinitions(fs, config))
    expect(agents).toEqual([])
  })

  it('case 3: does NOT fall back to cwd parent traversal (DEC-014 removal)', () => {
    // projectRoot has no .claude/agents/, but the cwd parent does.
    // Pre-DEC-014, the upward traversal fallback would have picked this up.
    // After DEC-014, we must return [].
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/new-proj']
    const fallbackAgentsDir = `${process.cwd()}/.claude/agents`
    const fs = createMockFs(
      { [`${fallbackAgentsDir}/sneaky-agent.md`]: AGENT_MD },
      { [fallbackAgentsDir]: ['sneaky-agent.md'] },
    )
    const config = makeConfig('/home/user/.claude')
    const agents = userAgents(loadAgentDefinitions(fs, config))
    expect(agents).toEqual([])
  })

  it('case 4: does NOT fall back to claudeDir/agents (DEC-014 removal)', () => {
    // projectRoot has no .claude/agents/, but ~/.claude/agents/ does.
    // Pre-DEC-014, this was fallback #3. After DEC-014, we must return [].
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/new-proj']
    const globalAgentsDir = '/home/user/.claude/agents'
    const fs = createMockFs(
      { [`${globalAgentsDir}/global-agent.md`]: AGENT_MD },
      { [globalAgentsDir]: ['global-agent.md'] },
    )
    const config = makeConfig('/home/user/.claude')
    const agents = userAgents(loadAgentDefinitions(fs, config))
    expect(agents).toEqual([])
  })

  it('case 5: parses CRLF-line-ending definitions (Windows / autocrlf=true checkout)', () => {
    // Repro for BL-2026-084: agent definition files checked out under
    // git's `core.autocrlf=true` come back with CRLF line endings.
    // The frontmatter regex used to be authored against bare `\n` and
    // would silently fail to match, dropping the agent from the list.
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/proj']
    const agentsDir = '/tmp/proj/.claude/agents'
    const crlfAgent = AGENT_MD.replace(/\n/g, '\r\n')
    const fs = createMockFs(
      { [`${agentsDir}/test-agent.md`]: crlfAgent },
      { [agentsDir]: ['test-agent.md'] },
    )
    const config = makeConfig('/home/user/.claude')
    const agents = userAgents(loadAgentDefinitions(fs, config))
    expect(agents).toHaveLength(1)
    expect(agents[0].id).toBe('test-agent')
    // Stray `\r` must not bleed into parsed field values.
    expect(agents[0].displayName).not.toContain('\r')
    expect(agents[0].description).not.toContain('\r')
  })

  it('case 6 (Q13 / AA-7): always appends the system default agent', () => {
    process.argv = ['node', 'index.ts', '--project-root', '/tmp/empty-proj']
    const fs = createMockFs({}, {})
    const config = makeConfig('/home/user/.claude')
    const all = loadAgentDefinitions(fs, config)
    // The system default must be present even when there are zero
    // user agents — that is the whole point of Q13.
    const system = all.filter((a) => a.isSystem)
    expect(system).toHaveLength(1)
    expect(system[0].id).toBe('__claude_default__')
    expect(system[0].command).toBe('claude')
  })
})
