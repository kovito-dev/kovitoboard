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
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')
const REPO_APP = resolve(REPO_ROOT, 'app')

/**
 * Remove the `<repo>/app` symlink that `ensureAppSymlink()` creates when a
 * spawned kb-start gets past the pre-flight. Leaving it behind would make
 * the next spawn fail with EEXIST and could break unrelated suites.
 */
function cleanRepoAppSymlink(): void {
  try {
    if (lstatSync(REPO_APP).isSymbolicLink()) unlinkSync(REPO_APP)
  } catch {
    // not present
  }
}

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
      // Hard cap below vitest's per-test timeout so a missed refuse (which
      // would actually launch the supervisor) fails fast instead of
      // hanging the runner.
      timeout: 4000,
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
  const servers: Server[] = []

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kb-start-preflight-'))
    // A stale symlink from an earlier spawn would make ensureAppSymlink
    // throw EEXIST in the negative test.
    cleanRepoAppSymlink()
  })

  afterEach(async () => {
    for (const s of createdSessions) killSession(s)
    createdSessions.length = 0
    for (const srv of servers) {
      await new Promise<void>((r) => srv.close(() => r()))
    }
    servers.length = 0
    killSession(sessionNameFor(workDir))
    cleanRepoAppSymlink()
    rmSync(workDir, { recursive: true, force: true })
  })

  /** Occupy a TCP port and return it (kb-start exits fast on a busy --port). */
  async function occupyPort(): Promise<number> {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((res, rej) => {
      server.once('error', rej)
      server.listen(0, '127.0.0.1', () => res())
    })
    const addr = server.address()
    if (addr && typeof addr === 'object') return addr.port
    throw new Error('could not allocate port')
  }

  it('refuses to start when the project tmux session already exists', () => {
    const session = sessionNameFor(workDir)
    execFileSync('tmux', ['new-session', '-d', '-s', session])
    createdSessions.push(session)

    const r = runKbStart(workDir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('a KB tmux session for this project already exists')
    expect(r.stderr).toContain(session)
  })

  it('does not emit the conflict error when no matching session exists', async () => {
    // No session is pre-created, so the pre-flight must pass. To avoid
    // actually launching a supervisor (slow / leaves a process), we hand
    // kb-start an explicit `--port` that is already busy so it exits fast
    // during port resolution. The only assertion that matters is that the
    // tmux pre-flight did NOT refuse — kb-start got far enough to reach
    // app-symlink / port resolution (both run after the pre-flight).
    const busyPort = await occupyPort()
    const r = runKbStart(workDir, ['--port', String(busyPort)])
    expect(r.stderr ?? '').not.toContain(
      'a KB tmux session for this project already exists',
    )
  })
})
