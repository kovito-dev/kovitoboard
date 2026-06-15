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
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_STOP = resolve(REPO_ROOT, 'tools', 'kb-stop.mjs')

/**
 * Capability probe: this suite needs to create detached subprocesses (the
 * decoy supervisors are re-parented to init). On restricted / sandboxed
 * runners `detached: true` can fail with EPERM, so probe it once and skip
 * the suite cleanly rather than failing every test before the assertions.
 */
function detachedSpawnCapable(): boolean {
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      detached: true,
    })
    if (child.pid == null) return false
    child.unref()
    try {
      process.kill(child.pid, 'SIGKILL')
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
  it('exits 0 with no residue when the supervisor stops cleanly and ports are free', () => {
    const pid = spawnDecoySupervisor()
    writePidFile({
      pid,
      startedAt: new Date().toISOString(),
      projectRoot: workDir,
      projectRootSource: 'cli-arg',
      ports: { backend: 39201, vite: 39202 }, // not bound by anyone
      tmux: { sessionName: `kovitoboard-${Date.now()}-absent` },
    })

    const r = runKbStop()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[kb-stop] Done')
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
  })

  // Provenance gate (§9.1.0 root trust): the lineage / force-kill anchor
  // is only trusted when the PID-file root is a LIVE supervisor of THIS
  // clone (argv realpath-resolves to tools/kb-start.mjs). A decoy / unrelated
  // process is NOT a valid root, so diagnostics degrade: a process holding a
  // recorded port is reported as ownership-unknown (NOT "unrelated") and the
  // stop stays exit 0 without claiming the listener is outside KB lineage.
  //
  // NOTE on lineage-PROVEN coverage: a root that passes the provenance fence
  // is a real `node tools/kb-start.mjs` supervisor, which cannot be spawned
  // in a unit test without booting the KB supervisor (ports / tmux / vite).
  // The lineage-proven exit-4 (orphan + bound port) and `--force` release
  // (exit 0) paths are therefore exercised end-to-end against a real
  // supervisor outside the unit suite; this suite covers the degraded /
  // provenance branches that the decoy can reach deterministically. This
  // mirrors the negative-only strategy documented in kb-stop-all-mode.test.ts.
  it('degrades to ownership-unknown when the PID-file root is not a supervisor of this clone (mismatch)', async () => {
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
    expect(r.status).toBe(0)
    // Provenance could not be established → degrade, do NOT claim residue.
    expect(r.stderr ?? '').toContain('not a supervisor of this clone')
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
    // The held port must NOT be mislabeled as a definite "unrelated process".
    expect(r.stderr ?? '').not.toContain('unrelated process')
  })

  it('degrades (no exit 4, no force-kill) when the PID-file root is already dead', { timeout: 20000 }, async () => {
    // A PID-file root that has already exited (and may have left a
    // reparented child / bound port) cannot anchor lineage; the stop must
    // not mislabel the leak as unrelated, nor exit 4, nor force-kill an
    // unrelated tree (CodeX attempt 6 — stale PID residue / scope).
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
    expect(r.status).not.toBe(4)
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
    expect(r.stderr ?? '').not.toContain('unrelated process')
  })
})
