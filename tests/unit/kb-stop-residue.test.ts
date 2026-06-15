/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * kb-stop residual diagnostics (process-lifecycle.md §9, BL-2026-237).
 *
 * Spec SSOT: `process-lifecycle.md` §9.1.0 (lineage snapshot) / §9.1.1
 * (port post-flight) / §9.1.2 (zombie detection) / §7.5 (exit codes).
 *
 * The supervisor kb-start/kb-stop path is NOT exercised by L1 (the L1
 * webServer boots the renderer via `npm run dev`, which never writes a
 * supervisor PID file), so these spawn-based unit tests are the automated
 * regression net for the diagnostics.
 *
 * Strategy: write a crafted PID file pointing at a decoy "supervisor"
 * process that mimics the real shutdown contract (removes the PID file
 * and exits on SIGTERM), so kb-stop's two-phase wait clears quickly. We
 * then arrange residue (a free port vs. an unrelated process holding a
 * recorded port) and assert the exit code / advisory behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_STOP = resolve(REPO_ROOT, 'tools', 'kb-stop.mjs')

/**
 * Capability probe: this suite needs the exact launcher pattern the decoy
 * uses — an `execFileSync(node -e <launcher>)` that itself performs a
 * `spawn(..., { detached: true })`. On restricted / sandboxed runners that
 * nested detached spawn can fail with EPERM. Probe the SAME path (outer
 * execFileSync + inner detached spawn that reports the child pid) so the
 * probe cannot pass while the real setup fails; skip the suite cleanly
 * otherwise.
 */
function detachedSpawnCapable(): boolean {
  const launcher = `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      detached: true,
    });
    process.stdout.write(String(c.pid == null ? '' : c.pid));
    c.unref();
  `
  try {
    const out = execFileSync(process.execPath, ['-e', launcher], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const pid = Number(out)
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already exited
    }
    return true
  } catch {
    return false
  }
}

let workDir: string
const decoyPids: number[] = []
const servers: Server[] = []

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-stop-residue-'))
  mkdirSync(join(workDir, '.kovitoboard', 'run'), { recursive: true })
})

afterEach(async () => {
  for (const pid of decoyPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  decoyPids.length = 0
  for (const s of servers) {
    await new Promise<void>((r) => s.close(() => r()))
  }
  servers.length = 0
  rmSync(workDir, { recursive: true, force: true })
})

const PID_FILE = () => join(workDir, '.kovitoboard', 'run', 'supervisor.pid')

/**
 * Spawn a decoy "supervisor" that idles until SIGTERM, then removes the
 * PID file (the real `kb-start` shutdown contract publishes "shutting
 * down" by removing the file) and exits — letting kb-stop's two-phase
 * wait clear fast.
 *
 * It is launched via a throwaway launcher process that spawns the decoy
 * `detached` and exits immediately. This re-parents the decoy to init,
 * so when it exits during kb-stop's blocking `spawnSync` the OS (not this
 * blocked test process) reaps it — otherwise the decoy would linger as a
 * zombie and `waitForPidExit`'s `kill(0)` poll would never see ESRCH.
 */
function spawnDecoySupervisor(): number {
  const pidOut = join(workDir, 'decoy.pid')
  const decoyScript = `
    const { unlinkSync } = require('fs');
    const pidFile = ${JSON.stringify(PID_FILE())};
    process.on('SIGTERM', () => { try { unlinkSync(pidFile); } catch {} process.exit(0); });
    setInterval(() => {}, 1000);
  `
  const launcher = `
    const { spawn } = require('child_process');
    const { writeFileSync } = require('fs');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(decoyScript)}], {
      stdio: 'ignore',
      detached: true,
    });
    writeFileSync(${JSON.stringify(pidOut)}, String(c.pid));
    c.unref();
    process.exit(0);
  `
  execFileSync(process.execPath, ['-e', launcher])
  // Brief settle so the decoy installs its SIGTERM handler before we send
  // the signal via kb-stop.
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)'])
  const pid = Number(readFileSync(pidOut, 'utf-8').trim())
  decoyPids.push(pid)
  return pid
}

function writePidFile(entry: Record<string, unknown>): void {
  writeFileSync(PID_FILE(), JSON.stringify(entry), 'utf-8')
}

/** True when `pid` is still alive (signal-0 probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Occupy a TCP port with an unrelated listener and resolve its port. */
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

function runKbStop(extraArgs: string[] = []) {
  return spawnSync(process.execPath, [KB_STOP, '--project-root', workDir, ...extraArgs], {
    encoding: 'utf-8',
    timeout: 20000,
    env: {
      ...process.env,
      KOVITOBOARD_PROJECT_ROOT: workDir,
      // The test runner may be inside a tmux session; clear it so the
      // self-suicide guard does not engage on unrelated session names.
      TMUX: '',
    },
  })
}

const describeResidue = detachedSpawnCapable() ? describe : describe.skip

describeResidue('tools/kb-stop.mjs — §9 residual diagnostics', () => {
  // v1.8 signal-front gate (process-lifecycle.md §7.3 step 3.5(a) / §7.5 /
  // §9.1.0, BL-2026-244): the root-PID trust gate (`classifySupervisorRoot`)
  // is now applied BEFORE the first signal. Only a LIVE supervisor of THIS
  // clone (argv realpath-resolves to tools/kb-start.mjs = kind 'ok') reaches
  // the stop flow; a decoy `node -e` (kind 'mismatch') is refused with exit 2
  // and NO signal, and a dead root (kind 'dead') joins the §7.4 stale path
  // (PID file cleared, exit 0).
  //
  // NOTE on the lineage 'ok' path: a root that passes the fence is a real
  // `node tools/kb-start.mjs` supervisor, which cannot be spawned in a unit
  // test without booting the KB supervisor (ports / tmux / vite). The clean
  // stop, lineage-proven exit-4 (orphan + bound port) and `--force` release
  // (exit 0) paths are therefore exercised end-to-end against a real
  // supervisor outside the unit suite; this suite covers the gate's
  // refuse / stale branches that a decoy can reach deterministically. This
  // mirrors the negative-only strategy documented in kb-stop-all-mode.test.ts.
  it('refuses with exit 2 (no signal) when the PID-file root is not a supervisor of this clone (mismatch)', async () => {
    // A PID file pointing at a live process that is NOT a supervisor of this
    // clone must be refused BEFORE any signal — the file may be stale /
    // tampered and the PID could belong to a different same-user process.
    // exit 2 = "cannot safely stop, do not touch" (same contract as EPERM).
    // The held port is never examined because we refuse before the stop flow.
    const pid = spawnDecoySupervisor() // node -e ..., not tools/kb-start.mjs
    const heldPort = await occupyPort()
    writePidFile({
      pid,
      startedAt: new Date().toISOString(),
      projectRoot: workDir,
      projectRootSource: 'cli-arg',
      ports: { backend: heldPort, vite: 39202 },
      tmux: { sessionName: `kovitoboard-${Date.now()}-absent` },
    })

    const r = runKbStop()
    expect(r.status).toBe(2)
    expect(r.stderr ?? '').toContain('is not a KovitoBoard supervisor of this clone')
    expect(r.stderr ?? '').toContain('Refusing to send any signal')
    // The decoy must still be alive — the gate fired before any signal.
    expect(isAlive(pid)).toBe(true)
    // No residue diagnostics ran (we refused before the stop flow), so the
    // held port was never examined / mislabeled.
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
    expect(r.stderr ?? '').not.toContain('now held by an unrelated process')
    // The decoy must not have been signalled into removing the PID file.
    expect(existsSync(PID_FILE())).toBe(true)
  })

  it('clears the stale PID file and exits 0 when the PID-file root is already dead', { timeout: 20000 }, async () => {
    // v1.8 signal-front gate (process-lifecycle.md §7.3 step 3.5(a) / §7.5):
    // a dead PID-file root joins the §7.4 stale path — remove the PID file
    // and exit 0 (nothing alive to stop, no signal, no residue diagnostics,
    // no force-kill of an unrelated tree).
    const pid = spawnDecoySupervisor()
    process.kill(pid, 'SIGKILL') // kill the root before kb-stop runs
    await new Promise((r) => setTimeout(r, 200))
    const heldPort = await occupyPort()
    writePidFile({
      pid,
      startedAt: new Date().toISOString(),
      projectRoot: workDir,
      projectRootSource: 'cli-arg',
      ports: { backend: heldPort, vite: 39202 },
      tmux: { sessionName: `kovitoboard-${Date.now()}-absent` },
    })

    const r = runKbStop(['--force'])
    expect(r.status).toBe(0)
    expect(r.stdout ?? '').toContain('stale PID file cleared')
    // The stale PID file was removed. This also exercises the TOCTOU
    // re-read guard's pass-through: the recheck reads the SAME dead pid, so
    // removal proceeds. (The concurrent-rewrite branch — recheck sees a new
    // pid and leaves the file — is a narrow race covered by inspection; a
    // deterministic mid-run rewrite cannot be injected hermetically here.)
    expect(existsSync(PID_FILE())).toBe(false)
    expect(r.status).not.toBe(4)
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
    expect(r.stderr ?? '').not.toContain('now held by an unrelated process')
  })
})
