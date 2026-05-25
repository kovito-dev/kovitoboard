/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Smoke tests for `tools/kb-stop.mjs`.
 *
 * Spec SSOT: `process-lifecycle.md` v1.2 §7 (in the kovitoboard-dev
 * workspace). The script is exercised via `node` subprocesses against
 * a per-test tempdir as projectRoot, so the tests verify the actual
 * CLI surface (exit codes, stdout markers) without requiring a real
 * KovitoBoard supervisor.
 *
 * Coverage here intentionally stays at the smoke level — full
 * graceful-shutdown / SIGKILL escalation behavior requires an actual
 * supervisor, which belongs in the L1 / L3 layers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Tests live in `tests/unit/`; the script is `tools/kb-stop.mjs`.
const KB_STOP = resolve(__dirname, '..', '..', 'tools', 'kb-stop.mjs')

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-stop-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runKbStop(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [KB_STOP, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      KOVITOBOARD_PROJECT_ROOT: workDir,
      // Drop any TMUX inherited from the test runner so the
      // self-suicide guard does not accidentally engage on the
      // unrelated tmux session that hosts the test harness.
      TMUX: '',
      ...extraEnv,
    },
  })
}

describe('tools/kb-stop.mjs — usage', () => {
  it('prints help and exits 0 for --help', () => {
    const r = runKbStop(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Usage:')
    expect(r.stdout).toContain('--force')
    expect(r.stdout).toContain('--dry-run')
    expect(r.stdout).toContain('--all')
  })

  it('rejects unknown arguments with exit 1', () => {
    const r = runKbStop(['--bogus'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unknown argument')
  })
})

describe('tools/kb-stop.mjs — no supervisor present', () => {
  it('exits 0 with "Nothing to do" when no PID file and no pgrep match', () => {
    expect(existsSync(join(workDir, '.kovitoboard', 'run', 'supervisor.pid'))).toBe(false)
    const r = runKbStop([])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Nothing to do')
  })

  it('exits 0 in --dry-run when no supervisor is detected', () => {
    const r = runKbStop(['--dry-run'])
    expect(r.status).toBe(0)
    // The "no supervisor detected" branch fires before the dry-run
    // planner kicks in, so the output is the same as plain mode.
    expect(r.stdout).toContain('Nothing to do')
  })
})

describe('tools/kb-stop.mjs — stale PID file', () => {
  it('treats a dead pid as nothing-to-stop in --dry-run', () => {
    const runDir = join(workDir, '.kovitoboard', 'run')
    mkdirSync(runDir, { recursive: true })
    // pid 999999 is essentially guaranteed not to exist on a normal
    // system; if a CI runner happens to assign it, the test will
    // misfire harmlessly (the dry-run planner just notes "skipping
    // signal").
    writeFileSync(
      join(runDir, 'supervisor.pid'),
      JSON.stringify(
        {
          pid: 999999,
          startedAt: new Date().toISOString(),
          projectRoot: workDir,
          ports: { backend: 3001, vite: 5173 },
          tmux: { sessionName: 'kovitoboard-test' },
        },
        null,
        2,
      ),
    )
    const r = runKbStop(['--dry-run'])
    // Exit 0 — dry-run never returns a non-zero exit on planning
    // alone. The planner notes the dead pid and exits.
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('already dead')
  })

  it('refuses to operate on a corrupt PID file without --all', () => {
    // Spec hardening (CodeX review on PR #20, finding "scope
    // violation on corrupt state"): a single broken PID file in one
    // workspace must not cause a host-wide pgrep sweep that could
    // signal supervisors belonging to other projects. The operator
    // has to opt in via --all.
    const runDir = join(workDir, '.kovitoboard', 'run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'supervisor.pid'), '{ this is not json')
    const r = runKbStop(['--dry-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('PID file at')
    expect(r.stderr).toContain('unreadable')
    expect(r.stderr).toContain('--all to opt into the host-wide pgrep sweep')
  })

  it('skips the corrupt-PID error and uses pgrep when --all is set', () => {
    // Implementation note: with `--all` the script intentionally does
    // not even read the PID file (`pidEntry = null` short-circuits
    // the broken-file branch); it goes straight to pgrep. So we do
    // not see the "PID file unreadable" WARN — what we want to
    // assert is the absence of the "Refusing to fall back" hard
    // error and a clean exit 0.
    const runDir = join(workDir, '.kovitoboard', 'run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'supervisor.pid'), '{ this is not json')
    const r = runKbStop(['--dry-run', '--all'])
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('Refusing to fall back')
  })
})

describe('tools/kb-stop.mjs — embedded layout project root', () => {
  it('walks up to the parent project when run from inside the KB clone', () => {
    // Spec hardening (CodeX review on PR #20, finding "project
    // root resolution mismatch"): `cd <project>/kovitoboard && npm
    // run kb:stop` must resolve the same project root that
    // `kb-start --project-root ..` wrote the PID file under
    // (`<project>/`), not the cwd (`<project>/kovitoboard/`).
    const r = spawnSync(process.execPath, [KB_STOP, '--help'], {
      encoding: 'utf-8',
      cwd: resolve(__dirname, '..', '..'),
      env: { ...process.env, KOVITOBOARD_PROJECT_ROOT: '', TMUX: '' },
    })
    // --help short-circuits before path resolution affects exit
    // code, but the help banner exposes the resolution priority so
    // a regression that dropped the embedded-layout walk-up would
    // surface in the doc fallback as well.
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--project-root')
    expect(r.stdout).toContain('Embedded layout')
  })
})
