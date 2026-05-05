/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI = join(REPO_ROOT, 'tools', 'kb-diagnose.mjs')

/**
 * Run the kb-diagnose CLI in an isolated environment.
 *
 * @param projectRoot The KOVITOBOARD_PROJECT_ROOT to set
 * @param overrides   Optional env overrides on top of the inherited env
 */
function runCli(
  projectRoot: string,
  overrides: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KOVITOBOARD_PROJECT_ROOT: projectRoot,
    ...overrides,
  }
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) delete env[k]
  }
  const r = spawnSync(process.execPath, [CLI], {
    env,
    encoding: 'utf-8',
    timeout: 15000,
  })
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  }
}

function makeProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kb-diagnose-test-'))
}

describe('kb-diagnose / structure', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('emits Markdown with the expected headings', () => {
    const r = runCli(projectRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^# KovitoBoard Diagnostic Report/)
    expect(r.stdout).toMatch(/## Environment/)
    expect(r.stdout).toMatch(/## Project/)
    expect(r.stdout).toMatch(/## Recent server log/)
    expect(r.stdout).toMatch(/## Notes/)
  })

  it('reports KovitoBoard / Node.js / OS lines', () => {
    const r = runCli(projectRoot)
    expect(r.stdout).toMatch(/- KovitoBoard: \S/)
    expect(r.stdout).toMatch(/- Node\.js: v\d+/)
    expect(r.stdout).toMatch(/- OS: \w+/)
  })

  it('uses (not detected) when an external binary is unavailable', () => {
    // Strip claude / tmux from PATH (keep node so the script itself runs)
    const nodeBin = dirname(process.execPath)
    const isolatedPath = `${nodeBin}:/nonexistent-bin`
    const r = runCli(projectRoot, { PATH: isolatedPath })
    expect(r.status).toBe(0)
    // At least one of the binaries should now report (not detected).
    // We only assert the literal token appears somewhere in the report.
    expect(r.stdout).toMatch(/\(not detected\)/)
  })
})

describe('kb-diagnose / log file handling', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('explains when no log file exists yet', () => {
    const r = runCli(projectRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/No log file found under/)
  })

  it('reads and embeds the log tail when a rotated file exists', () => {
    const logsDir = join(projectRoot, '.kovitoboard', 'logs')
    mkdirSync(logsDir, { recursive: true })
    const logFile = join(logsDir, 'server.2026-04-25.1.log')
    const lines = [
      '{"level":"info","ts":"2026-04-25T00:00:00.000Z","pid":1,"component":"server","msg":"boot"}',
      '{"level":"warn","ts":"2026-04-25T00:00:01.000Z","pid":1,"component":"tmux-bridge","msg":"send retry"}',
    ]
    writeFileSync(logFile, lines.join('\n') + '\n', 'utf-8')

    const r = runCli(projectRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"msg":"boot"')
    expect(r.stdout).toContain('"msg":"send retry"')
    // The fenced code block should be present
    expect(r.stdout).toMatch(/```json[\s\S]+```/)
  })
})

describe('kb-diagnose / setting.json handling', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('reports the onboarding state from setting.json when present', () => {
    const settingDir = join(projectRoot, '.kovitoboard')
    mkdirSync(settingDir, { recursive: true })
    const setting = {
      version: '1.1',
      user: { displayName: 'tester', avatar: null },
      project: { name: 'p', description: 'd', path: projectRoot },
      locale: 'ja',
      onboarding: {
        completedAt: '2026-04-25T00:00:00.000Z',
        wizardVersion: '0.1.0',
      },
    }
    writeFileSync(join(settingDir, 'setting.json'), JSON.stringify(setting), 'utf-8')

    const r = runCli(projectRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Onboarding: completed at 2026-04-25T00:00:00\.000Z/)
  })

  it('reports "(no setting.json yet)" when the file is absent', () => {
    const r = runCli(projectRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Onboarding: \(no setting\.json yet\)/)
  })
})
