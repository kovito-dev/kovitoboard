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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_STOP = resolve(REPO_ROOT, 'tools', 'kb-stop.mjs')

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

/**
 * Spawn a decoy supervisor that, before idling, spawns its own child
 * which binds a free port and stays alive even after the supervisor
 * receives SIGTERM (a leaked lineage-proven orphan). Returns the
 * supervisor pid and the bound port. Both processes are re-parented to
 * init via the throwaway launcher (see spawnDecoySupervisor).
 */
function spawnDecoyWithOrphanHoldingPort(): {
  supervisorPid: number
  port: number
} {
  const pidOut = join(workDir, 'decoy-orphan.json')
  // The orphan binds port 0 (kernel-assigned) and reports it; the
  // supervisor relays {sup, orphan, port} to pidOut, then idles. On
  // SIGTERM the supervisor removes the PID file and exits WITHOUT killing
  // the orphan, leaving a lineage-proven leak.
  const supScript = `
    const { spawn } = require('child_process');
    const { unlinkSync, writeFileSync } = require('fs');
    const orphanScript = "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)+'\\\\n')});setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['-e', orphanScript], { stdio: ['ignore','pipe','ignore'] });
    child.stdout.on('data', (b) => {
      const port = Number(String(b).trim());
      writeFileSync(${JSON.stringify(pidOut)}, JSON.stringify({ sup: process.pid, orphan: child.pid, port }));
    });
    process.on('SIGTERM', () => { try { unlinkSync(${JSON.stringify(PID_FILE())}); } catch {} process.exit(0); });
    setInterval(() => {}, 1000);
  `
  const launcher = `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(supScript)}], {
      stdio: 'ignore',
      detached: true,
    });
    c.unref();
    process.exit(0);
  `
  execFileSync(process.execPath, ['-e', launcher])
  // Wait until the orphan reported its port.
  const deadline = Date.now() + 5000
  let data: { sup: number; orphan: number; port: number } | null = null
  while (Date.now() < deadline) {
    try {
      data = JSON.parse(readFileSync(pidOut, 'utf-8'))
      if (data && data.port) break
    } catch {
      // not written yet
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
  }
  if (!data || !data.port) throw new Error('decoy orphan did not report a port')
  decoyPids.push(data.sup, data.orphan)
  return { supervisorPid: data.sup, port: data.port }
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

describe('tools/kb-stop.mjs — §9 residual diagnostics', () => {
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

  it('reports an unrelated process holding a recorded port as advisory (exit 0, not exit 4)', async () => {
    const pid = spawnDecoySupervisor()
    // Occupy a port and record it as the backend port. After the decoy
    // supervisor exits, the port is still held by the unrelated listener,
    // which is NOT a lineage-proven KB descendant → advisory WARN, exit 0.
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
    expect(r.stderr ?? '').toContain('unrelated process')
    expect(r.stderr ?? '').not.toContain('lineage-proven KB residual')
  })

  it('detects a lineage-proven orphan holding a port (exit 4), and --force releases it (exit 0)', { timeout: 30000 }, () => {
    // The decoy supervisor spawns a child that binds a free port and
    // survives the supervisor's SIGTERM (a leaked orphan). The child is a
    // lineage-proven KB descendant, so it surfaces as both an orphan and a
    // "port still bound" residue → exit 4 without --force.
    const { supervisorPid, port } = spawnDecoyWithOrphanHoldingPort()
    writePidFile({
      pid: supervisorPid,
      startedAt: new Date().toISOString(),
      projectRoot: workDir,
      projectRootSource: 'cli-arg',
      ports: { backend: port, vite: 39202 },
      tmux: { sessionName: `kovitoboard-${Date.now()}-absent` },
    })

    const noForce = runKbStop()
    expect(noForce.status).toBe(4)
    expect(noForce.stderr ?? '').toContain('orphan, lineage proven')
    expect(noForce.stderr ?? '').toContain('still bound')

    // --force SIGKILLs the lineage-proven orphan; the port is then
    // released, so the post-kill re-evaluation must NOT exit 4 on stale
    // pre-kill residue (the bug CodeX flagged). Re-write the PID file
    // (kb-stop removed it on the first run) so the second run targets the
    // same supervisor context.
    writePidFile({
      pid: supervisorPid,
      startedAt: new Date().toISOString(),
      projectRoot: workDir,
      projectRootSource: 'cli-arg',
      ports: { backend: port, vite: 39202 },
      tmux: { sessionName: `kovitoboard-${Date.now()}-absent` },
    })
    const forced = runKbStop(['--force'])
    expect(forced.status).toBe(0)
    expect(forced.stderr ?? '').toContain('SIGKILL')
    expect(forced.stderr ?? '').not.toContain('lineage-proven KB residual')
  })
})
