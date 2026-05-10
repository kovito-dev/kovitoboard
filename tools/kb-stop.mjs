#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard kb-stop — graceful supervisor shutdown.
 *
 * Spec SSOT: `process-lifecycle.md` v1.2 §7 (in the kovitoboard-dev
 * workspace).
 *
 * Reads the PID file written by `kb-start.mjs`, sends SIGTERM, waits
 * for graceful shutdown (PID file deletion), optionally cleans up the
 * tmux session and reports residual processes. The exit code maps
 * one-to-one with the spec table at §7.5 so callers (and the
 * agent-ref §11 protocol) can branch on it.
 *
 * Usage:
 *   node tools/kb-stop.mjs [OPTIONS]
 *
 * Options:
 *   --force        Send SIGKILL when SIGTERM does not bring the
 *                  supervisor down within 5s. Also force-kills any
 *                  residual processes reported in the diagnostic.
 *   --dry-run      Detect but do not kill anything; print the
 *                  planned actions and exit 0.
 *   --all          Bypass the PID file and discover supervisors via
 *                  `pgrep -f tools/kb-start.mjs`. Useful when the PID
 *                  file is missing or you want to clear out every KB
 *                  on the host. Required to opt into broad tmux
 *                  prefix matching as well (see KB_FORCE_TMUX_PREFIX_KILL).
 *   -h, --help     Print this usage and exit 0.
 *
 * Exit codes:
 *   0  Complete success
 *   1  Argument parsing error
 *   2  Permission denied (e.g. supervisor owned by another user)
 *   3  Graceful shutdown timed out (suggest --force)
 *   4  Partial success (children gone but tmux / port residue remains)
 */

import { execFileSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// CLI parsing — kept inline because the option set is small and the
// supervisor's parser is intentionally not shared (we want kb-stop to
// stay independently invocable, even if kb-start.mjs evolves).
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { force: false, dryRun: false, all: false, help: false, unknown: [] }
  for (const a of argv.slice(2)) {
    switch (a) {
      case '--force':
        out.force = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--all':
        out.all = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      default:
        out.unknown.push(a)
    }
  }
  return out
}

const args = parseArgs(process.argv)

if (args.help) {
  console.log(`Usage: node tools/kb-stop.mjs [OPTIONS]

Stops the KovitoBoard supervisor identified by the PID file at
<projectRoot>/.kovitoboard/run/supervisor.pid (and a fallback pgrep
sweep when the file is absent or --all is used).

Options:
  --force        SIGKILL if SIGTERM does not finish within 5s.
  --dry-run      Print the planned actions, kill nothing.
  --all          Skip the PID file; discover supervisors via pgrep.
  -h, --help     Print this usage.

Exit codes:
  0 success | 1 bad args | 2 EPERM | 3 graceful timeout | 4 residue
`)
  process.exit(0)
}

if (args.unknown.length > 0) {
  console.error(`[kb-stop] ERROR: unknown argument(s): ${args.unknown.join(' ')}`)
  process.exit(1)
}

const projectRoot =
  process.env.KOVITOBOARD_PROJECT_ROOT && process.env.KOVITOBOARD_PROJECT_ROOT.length > 0
    ? resolve(process.env.KOVITOBOARD_PROJECT_ROOT)
    : process.cwd()
const PID_FILE_PATH = resolve(projectRoot, '.kovitoboard', 'run', 'supervisor.pid')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && err.code === 'EPERM') return true
    return false
  }
}

function readPidFile() {
  if (!existsSync(PID_FILE_PATH)) return null
  let raw
  try {
    raw = readFileSync(PID_FILE_PATH, 'utf-8')
  } catch (err) {
    return { broken: 'read-failed', err }
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || typeof data.pid !== 'number') {
      return { broken: 'schema' }
    }
    return data
  } catch (err) {
    return { broken: 'parse-failed', err }
  }
}

function removePidFile() {
  try {
    unlinkSync(PID_FILE_PATH)
  } catch {
    // ENOENT is the expected case after a graceful shutdown; nothing
    // to recover.
  }
}

/**
 * Block until either the PID file disappears (graceful shutdown
 * confirmation) or `timeoutMs` elapses. Returns true on disappear,
 * false on timeout.
 */
async function waitForPidFileGone(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(PID_FILE_PATH)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !existsSync(PID_FILE_PATH)
}

function pgrepSupervisorPids() {
  // `-f` matches the full command line (so the script path is visible
  // even when argv[0] is just `node`). `-x` is intentionally NOT used
  // because we need substring matching for the script path.
  const result = spawnSync('pgrep', ['-f', 'tools/kb-start.mjs'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split('\n')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
}

function killTmuxSession(name) {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function listTmuxSessions() {
  try {
    const out = execFileSync('tmux', ['ls', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    // tmux not installed or no server — both acceptable, return [].
    return []
  }
}

function selfTmuxSessionName() {
  if (!process.env.TMUX) return null
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function reportResidue() {
  // Best-effort: print pgrep summaries the operator can act on. We
  // intentionally do NOT kill these without --force; the spec wants
  // the operator to confirm before SIGKILLing what could be an
  // orphaned but legitimate user process.
  const targets = [
    { label: 'tsx watch', pattern: 'tsx.*src/server/index\\.ts' },
    { label: 'vite child', pattern: 'node_modules/.bin/vite' },
    { label: 'claude (post-tmux orphan)', pattern: 'claude.*--agent' },
  ]
  let residue = []
  for (const t of targets) {
    const r = spawnSync('pgrep', ['-af', t.pattern], { encoding: 'utf-8' })
    if (r.status === 0 && r.stdout) {
      residue = residue.concat(
        r.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => ({ label: t.label, line })),
      )
    }
  }
  return residue
}

function killByPid(pid, signal) {
  try {
    process.kill(pid, signal)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: err && err.code, message: err && err.message }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const planned = []
  const planLog = (msg) => {
    if (args.dryRun) console.log(`[kb-stop] (dry-run) ${msg}`)
    else console.log(`[kb-stop] ${msg}`)
    planned.push(msg)
  }

  const pidEntry = args.all ? null : readPidFile()
  let supervisors = []
  let plannedTmuxSessions = new Set()
  let pidFromFile = null

  if (pidEntry && !pidEntry.broken) {
    pidFromFile = pidEntry.pid
    supervisors.push(pidEntry.pid)
    if (pidEntry.tmux && typeof pidEntry.tmux.sessionName === 'string') {
      plannedTmuxSessions.add(pidEntry.tmux.sessionName)
    }
  } else if (pidEntry && pidEntry.broken) {
    console.warn(`[kb-stop] WARN: PID file unreadable (${pidEntry.broken}); falling back to pgrep`)
    supervisors = pgrepSupervisorPids()
  } else if (args.all) {
    // No PID file but the operator explicitly asked for the
    // host-wide sweep — fall back to pgrep.
    supervisors = pgrepSupervisorPids()
  }
  // Note: with a fixed projectRoot and no PID file, the absence of
  // the PID file means "no supervisor is running FOR THIS PROJECT".
  // We deliberately do NOT pgrep host-wide in that case to avoid
  // killing supervisors that belong to other projects (the embedded
  // model can run multiple KBs side by side, one per project).
  // `--all` is the explicit opt-in for the host-wide sweep.

  if (args.all) {
    const extra = pgrepSupervisorPids()
    for (const p of extra) if (!supervisors.includes(p)) supervisors.push(p)
    // Wider tmux sweep, opt-in only.
    if (process.env.KB_FORCE_TMUX_PREFIX_KILL === '1') {
      for (const s of listTmuxSessions()) {
        if (s.startsWith('kovitoboard-')) plannedTmuxSessions.add(s)
      }
    }
  }

  if (supervisors.length === 0 && plannedTmuxSessions.size === 0) {
    console.log('[kb-stop] No KovitoBoard supervisor detected. Nothing to do.')
    process.exit(0)
  }

  // Self-suicide guard: if we are running inside one of the tmux
  // sessions we are about to kill, drop that session from the kill
  // list so we do not yank the carpet from under the calling agent.
  // Spec §7.6.
  const selfSession = selfTmuxSessionName()
  const skippedSelf = selfSession && plannedTmuxSessions.has(selfSession)
  if (skippedSelf) {
    plannedTmuxSessions.delete(selfSession)
    console.warn(
      `[kb-stop] WARN: skipping self-kill of tmux session "${selfSession}". ` +
        `Run kb-stop from a terminal outside that tmux session if you really want to kill it.`,
    )
  }

  for (const pid of supervisors) {
    if (!isPidAlive(pid)) {
      planLog(`pid ${pid} is already dead; skipping signal`)
      continue
    }
    planLog(`SIGTERM → supervisor pid ${pid}`)
    if (!args.dryRun) {
      const r = killByPid(pid, 'SIGTERM')
      if (!r.ok && r.code === 'EPERM') {
        console.error(
          `[kb-stop] ERROR: insufficient permission to signal pid ${pid} (owned by another user).`,
        )
        process.exit(2)
      }
    }
  }

  if (args.dryRun) {
    for (const s of plannedTmuxSessions) planLog(`tmux kill-session -t ${s}`)
    console.log(`[kb-stop] dry-run complete; ${planned.length} action(s) planned.`)
    process.exit(0)
  }

  // Wait for graceful shutdown signal: when we used the PID file
  // path, the supervisor's shutdown handler removes the PID file as
  // the publicly-visible "shutting down" event. When we used pgrep
  // (PID file absent / --all), poll-by-pid until the supervisors
  // disappear.
  let timedOut = false
  if (pidFromFile != null) {
    const cleared = await waitForPidFileGone(5000)
    if (!cleared) timedOut = true
  } else {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (supervisors.every((p) => !isPidAlive(p))) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (supervisors.some((p) => isPidAlive(p))) timedOut = true
  }

  if (timedOut) {
    if (!args.force) {
      console.error(
        `[kb-stop] WARN: graceful shutdown did not finish within 5s. ` +
          `Re-run with --force to send SIGKILL.`,
      )
      process.exit(3)
    }
    console.warn(`[kb-stop] graceful shutdown timed out; escalating to SIGKILL`)
    for (const pid of supervisors) {
      if (isPidAlive(pid)) killByPid(pid, 'SIGKILL')
    }
    // Best-effort PID file removal after SIGKILL — the supervisor's
    // shutdown handler did not get to run, so the file may still be
    // there.
    removePidFile()
  }

  // Tmux session cleanup. Done after the supervisor is confirmed
  // gone, so we do not fight a respawn.
  for (const s of plannedTmuxSessions) {
    if (killTmuxSession(s)) {
      console.log(`[kb-stop] tmux session "${s}" terminated`)
    } else {
      console.warn(
        `[kb-stop] WARN: tmux session "${s}" not found or already gone`,
      )
    }
  }

  // Residual diagnostic (and optional --force kill).
  const residue = reportResidue()
  if (residue.length > 0) {
    console.warn(`[kb-stop] WARN: residual KB-related processes detected:`)
    for (const r of residue) {
      console.warn(`[kb-stop]   (${r.label}) ${r.line}`)
    }
    if (args.force) {
      // Kill the pids parsed from `pgrep -af` lines.
      for (const r of residue) {
        const pid = Number.parseInt(r.line.split(/\s+/)[0], 10)
        if (Number.isInteger(pid) && pid > 0) killByPid(pid, 'SIGKILL')
      }
      console.log(`[kb-stop] residual processes SIGKILL'd (--force).`)
    } else {
      console.warn(
        `[kb-stop] To terminate, re-run with --force. ` +
          `Some processes may legitimately belong to another KB or to you; review before forcing.`,
      )
      process.exit(4)
    }
  }

  console.log(
    `[kb-stop] Done.${skippedSelf ? ` (skipped self tmux session "${selfSession}")` : ''}`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error(`[kb-stop] FATAL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
