/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Regression: a template-derived agent whose `description` is a long
 * single-line sentence must round-trip through the writer and reader
 * with its description intact.
 *
 * Background: `createAgentFromTemplate` re-serializes the template
 * frontmatter via `safeStringify` (js-yaml `yaml.dump`). With js-yaml's
 * default 80-column line folding, a long `description:` is rewritten
 * into a multi-line folded block scalar (`>-` plus indented
 * continuation lines). The single-line frontmatter regex in
 * `agent-reader.parseAgentDefinition` then matches the `>-` indicator
 * instead of the text, so the agent list showed an empty description
 * after creation (notably in English mode, where the bundled templates
 * carry long English descriptions). Pinning `lineWidth: -1` in the
 * stringify engine keeps the scalar on one line and restores the
 * round-trip. These tests guard against that folding regression.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createAgentFromTemplate } from '../../src/server/agent-writer'
import { loadAgentDefinitions } from '../../src/server/agent-reader'
import { _resetProjectRootCache } from '../../src/server/config'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import type { ViewerConfig } from '../../src/server/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    readdirSync: (p: string) =>
      [...files.keys()]
        .filter((f) => dirname(f) === p)
        .map((f) => f.slice(p.length + 1)),
    mkdirSync: (p: string) => {
      dirs.add(p)
    },
    symlinkSync: () => {},
    watch: () => ({ close: () => {} }),
  } as unknown as MockFs
}

const ORIGINAL_ARGV = [...process.argv]
const PROJECT_ROOT = '/tmp/roundtrip-project'

// `getTemplatesDir` resolves relative to the compiled module location.
// In the vitest run that is src/server/, so `../../templates/agents`
// matches the real repo layout. Seeding this exact path makes
// `getAgentTemplateContent` read our fixture template.
const TEMPLATES_DIR = resolve(__dirname, '../../templates/agents')

// A description long enough to trip js-yaml's 80-column fold, and
// containing a single quote like the bundled concierge template.
const LONG_DESCRIPTION =
  "Kovito Concierge 'Kobi'. A reliable guide for using KB, managing agents, recipes, and light custom app development."

function makeConfig(): ViewerConfig {
  return { agents: {}, claudeDir: '/tmp/claude' } as unknown as ViewerConfig
}

describe('createAgentFromTemplate -> loadAgentDefinitions round-trip', () => {
  let fs: MockFs

  beforeEach(() => {
    _resetProjectRootCache()
    process.argv = [...ORIGINAL_ARGV, `--project-root=${PROJECT_ROOT}`]
    fs = createMockFs()
    fs.dirs.add(PROJECT_ROOT)
    fs.dirs.add(TEMPLATES_DIR)
    fs.files.set(
      join(TEMPLATES_DIR, 'test-concierge.en.md'),
      `---\nname: test-concierge\ndescription: "${LONG_DESCRIPTION}"\n---\n\n# Test Concierge\n\nBody.\n`,
    )
  })

  afterEach(() => {
    process.argv = ORIGINAL_ARGV
    _resetProjectRootCache()
  })

  it('keeps the long description on a single line in the written file', () => {
    const result = createAgentFromTemplate(fs, {
      templateId: 'test-concierge',
      agentId: 'my-concierge',
      locale: 'en',
    })
    expect(result.success).toBe(true)

    const written = fs.files.get(result.filePath!)!
    // The folding regression produced `description: >-` followed by
    // indented continuation lines. Assert the value stays inline on a
    // single `description:` line. js-yaml emits it as a plain scalar
    // (no surrounding quotes) under CORE_SCHEMA, so match the line as
    // written rather than a specific quoting style.
    expect(written).toContain(`description: ${LONG_DESCRIPTION}\n`)
    expect(written).not.toContain('description: >-')
    expect(written).not.toContain('description: >')
  })

  it('reads the full description back via the agent reader', () => {
    const created = createAgentFromTemplate(fs, {
      templateId: 'test-concierge',
      agentId: 'my-concierge',
      locale: 'en',
    })
    expect(created.success).toBe(true)

    const agents = loadAgentDefinitions(fs, makeConfig())
    const agent = agents.find((a) => a.id === 'my-concierge')
    expect(agent).toBeDefined()
    expect(agent!.description).toBe(LONG_DESCRIPTION)
  })
})
