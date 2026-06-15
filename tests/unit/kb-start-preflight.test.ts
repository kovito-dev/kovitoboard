/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * kb-start pre-flight (process-lifecycle.md §6.6, BL-2026-237).
 *
 * Spec SSOT: `process-lifecycle.md` §6.6.1 / §6.6.2 (in the
 * kovitoboard-dev workspace). The supervisor refuses to start when a KB
 * tmux session for the resolved projectRoot already exists, complementing
 * the PID-file multi-launch refuse (§6.4) with an OR relationship. The
 * refuse is exact-match only (no host-wide enumeration) and uses the
 * §8.2-gated session-name resolution.
 *
 * These run via spawn because `tools/kb-start.mjs` is an executable
 * script (not a module), mirroring `kb-start-refuse.test.ts`. The
 * L1 E2E suite boots the renderer via `npm run dev`, which never goes
 * through the supervisor, so the pre-flight has no E2E coverage — these
 * unit tests are its only automated regression net.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function sessionNameFor(projectRoot: string): string {
  return `kovitoboard-${basename(projectRoot)}`.replace(/[.:]/g, '-')
}

function killSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

function runKbStart(projectRoot: string, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [KB_START, '--project-root', projectRoot, ...extraArgs],
    {
      encoding: 'utf-8',
      // Hard timeout so a missed refuse (which would actually launch the
      // supervisor) cannot hang the runner; the negative test relies on
      // it.
      timeout: 6000,
      env: {
        ...process.env,
        // Avoid the test runner's own env shadowing resolution.
        KOVITOBOARD_PROJECT_ROOT: '',
      },
    },
  )
}

const describeTmux = tmuxAvailable() ? describe : describe.skip

describeTmux('tools/kb-start.mjs — §6.6.2 tmux session pre-flight', () => {
  let workDir: string
  const createdSessions: string[] = []

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kb-start-preflight-'))
  })

  afterEach(() => {
    for (const s of createdSessions) killSession(s)
    createdSessions.length = 0
    // Best-effort: a missed refuse may have launched a supervisor.
    try {
      execFileSync(process.execPath, [
        resolve(REPO_ROOT, 'tools', 'kb-stop.mjs'),
        '--project-root',
        workDir,
        '--force',
      ])
    } catch {
      // nothing running
    }
    killSession(sessionNameFor(workDir))
    rmSync(workDir, { recursive: true, force: true })
  })

  it('refuses to start when the project tmux session already exists', () => {
    const session = sessionNameFor(workDir)
    execFileSync('tmux', ['new-session', '-d', '-s', session])
    createdSessions.push(session)

    const r = runKbStart(workDir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('a KB tmux session for this project already exists')
    expect(r.stderr).toContain(session)
  })

  it('does not emit the conflict error when no matching session exists', () => {
    // No session is pre-created. The supervisor passes the pre-flight and
    // proceeds to launch (then the 6s timeout kills it); afterEach stops
    // any supervisor it started. We only assert the pre-flight did NOT
    // fire its refuse message.
    const r = runKbStart(workDir, ['--port', '39101', '--vite-port', '39102'])
    expect(r.stderr ?? '').not.toContain(
      'a KB tmux session for this project already exists',
    )
  })
})
