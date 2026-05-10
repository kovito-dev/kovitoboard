#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard kb-stop — graceful supervisor shutdown.
 *
 * Spec SSOT: `process-lifecycle.md` v1.3 §7 (in the kovitoboard-dev
 * workspace). The Phase 2-A absolute-path discovery rule for `--all`
 * lives at §3.6 / §7.4 of the same spec.
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
 *                  `pgrep -af tools/kb-start.mjs`, then narrow the
 *                  candidates to processes whose argv[0] is `node`
 *                  and whose argv[1] resolves to THIS clone's
 *                  `tools/kb-start.mjs`. Useful when the PID file
 *                  is missing. Required to opt into broad tmux
 *                  prefix matching as well (see
 *                  KB_FORCE_TMUX_PREFIX_KILL). Cross-clone host-wide
 *                  kill is intentionally OUT of contract after the
 *                  Phase 2-A hardening — set up a per-clone PID file
 *                  flow instead of relying on substring sweeps.
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
import {
  existsSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  unlinkSync,
} from 'fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// CLI parsing — kept inline because the option set is small and the
// supervisor's parser is intentionally not shared (we want kb-stop to
// stay independently invocable, even if kb-start.mjs evolves).
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    force: false,
    dryRun: false,
    all: false,
    help: false,
    projectRoot: null,
    unknown: [],
  }
  const argList = argv.slice(2)
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i]
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
      case '--project-root': {
        // Allow either `--project-root <path>` (two args) or
        // `--project-root=<path>` (single arg with equals).
        const next = argList[i + 1]
        if (next && !next.startsWith('-')) {
          out.projectRoot = next
          i += 1
        } else {
          out.unknown.push(a)
        }
        break
      }
      default:
        if (a.startsWith('--project-root=')) {
          out.projectRoot = a.slice('--project-root='.length)
        } else {
          out.unknown.push(a)
        }
    }
  }
  return out
}

const args = parseArgs(process.argv)

if (args.help) {
  console.log(`Usage: node tools/kb-stop.mjs [OPTIONS]

Stops the KovitoBoard supervisor identified by the PID file at
<projectRoot>/.kovitoboard/run/supervisor.pid.

Project root resolution (highest to lowest priority):
  1. --project-root <path>           CLI flag
  2. KOVITOBOARD_PROJECT_ROOT        env var
  3. Embedded layout: when invoked from inside the KB clone (e.g.
     'cd <project>/kovitoboard && npm run kb:stop'), the parent of
     the clone is used so the PID file written by kb-start is
     discovered automatically.
  4. process.cwd()                   final fallback

Options:
  --project-root <path>  Explicit project root (overrides env / cwd).
  --force                SIGKILL if SIGTERM does not finish within 5s.
  --dry-run              Print the planned actions, kill nothing.
  --all                  Sweep for supervisors via pgrep, narrowing
                         the candidates to processes whose argv[1]
                         resolves to THIS clone's tools/kb-start.mjs
                         (Phase 2-A: previous host-wide substring
                         sweep is out of contract). Required to
                         bypass the per-project PID-file scope.
  -h, --help             Print this usage.

Exit codes:
  0 success | 1 bad args / corrupt PID | 2 EPERM | 3 graceful timeout
  4 residue diagnostics (informational; processes were NOT killed)
`)
  process.exit(0)
}

if (args.unknown.length > 0) {
  console.error(`[kb-stop] ERROR: unknown argument(s): ${args.unknown.join(' ')}`)
  process.exit(1)
}

/**
 * Resolve the project root using the same priority chain as
 * `kb-start` (CLI > env > embedded-layout > cwd). The
 * embedded-layout step is the one that lets
 * `cd <project>/kovitoboard && npm run kb:stop` work without an
 * explicit flag — when the cwd lives inside the KB clone we walk
 * up one level so the PID file written by `kb-start --project-root ..`
 * is discovered.
 */
function resolveProjectRoot() {
  if (args.projectRoot) return resolve(args.projectRoot)
  const env = process.env.KOVITOBOARD_PROJECT_ROOT
  if (env && env.length > 0) return resolve(env)
  const cwd = process.cwd()
  const rel = relative(repoRoot, cwd)
  const cwdInsideClone = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (cwdInsideClone) {
    // Embedded layout: assume the supervisor was started with
    // `--project-root ..` and the operator now ran us from the same
    // clone. The parent of the clone is the project root.
    return resolve(repoRoot, '..')
  }
  return cwd
}

const projectRoot = resolveProjectRoot()
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

/**
 * Block until the supervisor PID is no longer alive, or `timeoutMs`
 * elapses. Used after `waitForPidFileGone` because `kb-start` removes
 * the PID file at the BEGINNING of shutdown (to publish the
 * "shutting down" state), then proceeds to terminate children and
 * exit. Treating PID-file disappearance as proof of completion would
 * report success while the supervisor is still draining and reopen a
 * start/stop race where a new supervisor could slip in before the old
 * one released its ports.
 */
async function waitForPidExit(pid, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isPidAlive(pid)
}

/**
 * Discover supervisor PIDs via pgrep, then narrow the candidates to
 * the ones started from THIS clone of `tools/kb-start.mjs`.
 *
 * Phase 2-A hardening (spec `process-lifecycle.md` v1.3 §3.6 / §7.4):
 * the older implementation called `pgrep -f "tools/kb-start.mjs"` and
 * returned every PID whose cmdline contained that substring. That let
 * unrelated processes through:
 *
 *   - editors viewing the script: `nvim tools/kb-start.mjs`
 *   - shells reading it: `bash -c 'cat tools/kb-start.mjs'`
 *   - greps: `grep -r 'tools/kb-start.mjs' .`
 *
 * On `--all` (host-wide sweep) those would all receive SIGTERM, killing
 * unrelated developer processes. We now require both:
 *
 *   1. `argv[0]` basename is `node` — rules out editors, shells,
 *      greps. Shebang-launched invocations (`#!/usr/bin/env node`)
 *      still pass, since the kernel re-execs through `node`.
 *   2. `argv[1]` resolves (after `realpath`) to the absolute path of
 *      `<repoRoot>/tools/kb-start.mjs` — rules out supervisors from
 *      other KB clones on the same host. `--all` is intentionally
 *      scoped to this clone after Phase 2-A; cross-clone host-wide
 *      kill is out of contract.
 *
 * Relative `argv[1]` (the embedded-layout default — `node
 * tools/kb-start.mjs --project-root ..`) is resolved against the
 * supervisor's cwd when readable from `/proc/<pid>/cwd` (Linux), and
 * falls back to kb-stop's own cwd otherwise. The fallback holds for
 * the typical flow where kb-stop is invoked from the same clone.
 *
 * Set `KB_DEBUG=1` to log skipped candidates with the reason; the
 * default is silent because host-wide sweeps can list many unrelated
 * processes and a noisy stderr would obscure the actual stop trace.
 */
function pgrepSupervisorPids() {
  const result = spawnSync('pgrep', ['-af', 'tools/kb-start.mjs'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0 || !result.stdout) return []

  let expectedScriptPath
  try {
    expectedScriptPath = realpathSync(resolve(repoRoot, 'tools', 'kb-start.mjs'))
  } catch {
    // realpath fails if the script file no longer exists in this
    // clone. Fall back to the un-resolved absolute path so the
    // comparison still tightens substring match into prefix-equality
    // — better than reverting to the legacy false-positive surface.
    expectedScriptPath = resolve(repoRoot, 'tools', 'kb-start.mjs')
  }

  const debug = process.env.KB_DEBUG === '1'
  const pids = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // `pgrep -a` prepends each match with `<pid> ` followed by the
    // joined cmdline. The cmdline itself can contain spaces, so we
    // split only on the first whitespace run to keep argv intact.
    const space = trimmed.indexOf(' ')
    const pidPart = space >= 0 ? trimmed.slice(0, space) : trimmed
    const cmdline = space >= 0 ? trimmed.slice(space + 1) : ''
    const pid = Number.parseInt(pidPart, 10)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue

    // Naive whitespace tokenization: pgrep does not faithfully
    // recover quoting, but the supervisor's invocation never quotes
    // its first two argv tokens (`node tools/kb-start.mjs`), so a
    // simple split is sufficient. If a future invocation needs
    // quoting we revisit; until then we keep the parser minimal.
    const tokens = cmdline.split(/\s+/).filter(Boolean)
    if (tokens.length < 2) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: cmdline has fewer than 2 tokens (${cmdline})`,
        )
      }
      continue
    }
    const argv0 = tokens[0]
    const argv1 = tokens[1]

    if (basename(argv0) !== 'node') {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: argv[0]=${argv0} is not a node binary`,
        )
      }
      continue
    }

    let argv1Abs
    if (isAbsolute(argv1)) {
      argv1Abs = argv1
    } else {
      // Best-effort relative-path resolution. /proc/<pid>/cwd is
      // Linux-specific; on macOS we fall back to kb-stop's cwd, which
      // is correct when the operator runs `npm run kb:stop` from the
      // same clone (the typical embedded-layout flow).
      let supCwd = process.cwd()
      try {
        supCwd = readlinkSync(`/proc/${pid}/cwd`)
      } catch {
        // /proc not available or permission denied — keep kb-stop's
        // cwd. This is the documented best-effort fallback.
      }
      argv1Abs = resolve(supCwd, argv1)
    }

    let argv1Resolved
    try {
      argv1Resolved = realpathSync(argv1Abs)
    } catch {
      argv1Resolved = argv1Abs
    }

    if (argv1Resolved !== expectedScriptPath) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: argv[1] resolves to ${argv1Resolved}, ` +
            `expected ${expectedScriptPath}`,
        )
      }
      continue
    }

    pids.push(pid)
  }
  return pids
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

function reportResidue(pidEntry) {
  // Scope: only check artifacts that we can tie back to the supervisor
  // we just stopped. The previous host-wide `pgrep -af tsx /
  // node_modules/.bin/vite / claude.*--agent` sweep would catch
  // unrelated processes from other workspaces (or from the operator's
  // unrelated dev work) and falsely return exit 4 on a clean stop,
  // echoing those unrelated command lines to stderr.
  //
  // Target-scoped check: did the tmux session recorded in the
  // supervisor's PID file survive shutdown? That session is the only
  // thing we have a direct anchor on after the supervisor PID is gone
  // (children inherit the session, so a leaked claude/tmux pane shows
  // up as the session not getting torn down).
  if (!pidEntry?.tmux?.sessionName) return []
  if (!listTmuxSessions().includes(pidEntry.tmux.sessionName)) return []
  return [
    {
      label: 'tmux session not torn down',
      line: `tmux session "${pidEntry.tmux.sessionName}" is still active after supervisor stop`,
    },
  ]
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
    if (args.all) {
      console.warn(
        `[kb-stop] WARN: PID file unreadable (${pidEntry.broken}); --all is set so falling back to pgrep`,
      )
      supervisors = pgrepSupervisorPids()
    } else {
      console.error(
        `[kb-stop] ERROR: PID file at ${PID_FILE_PATH} is unreadable (${pidEntry.broken}).\n` +
          `[kb-stop]        Refusing to fall back to a host-wide pgrep sweep because that would risk\n` +
          `[kb-stop]        signaling supervisors that belong to other projects.\n` +
          `[kb-stop]        Options:\n` +
          `[kb-stop]          - inspect / repair / remove ${PID_FILE_PATH} and retry, or\n` +
          `[kb-stop]          - re-run with --all to opt into the host-wide pgrep sweep.`,
      )
      process.exit(1)
    }
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

  // Self-suicide guard (revision 4 strengthening of spec §7.6).
  //
  // Earlier revisions only removed the self tmux session from the
  // explicit `plannedTmuxSessions` kill list, but they still sent
  // SIGTERM (and SIGKILL on `--force`) to the supervisor PID. Because
  // the supervisor owns the tmux pane processes inside its own
  // session as descendants, signaling the supervisor cascades through
  // SIGHUP / SIGTERM to those panes and tears down the session that
  // hosts the calling agent — exactly the failure mode §7.6 wants to
  // prevent. So we now refuse the run BEFORE any signal goes out
  // when the target supervisor is hosted in our own tmux session.
  //
  // The agent-side rule in `agent-ref/11-lifecycle.md` §5 remains
  // the primary defense (agents are told never to call `kb:stop`
  // from inside KB); this branch is the depth-in-defense layer.
  const selfSession = selfTmuxSessionName()
  if (selfSession && plannedTmuxSessions.has(selfSession)) {
    console.error(
      `[kb-stop] ERROR: refusing to stop a supervisor whose tmux session\n` +
        `[kb-stop]        ("${selfSession}") hosts the current shell. Signaling the\n` +
        `[kb-stop]        supervisor would cascade SIGHUP/SIGTERM through its tmux\n` +
        `[kb-stop]        descendants and kill the calling agent.\n` +
        `[kb-stop]        Run kb-stop from a terminal outside this tmux session.`,
    )
    process.exit(1)
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
    // Two-phase wait: first the PID file disappears (kb-start
    // publishes "shutting down" by removing it early), then the
    // supervisor process actually exits. Treating PID-file removal
    // alone as success would race against `kb-start`'s child-cleanup
    // and port release, so we follow up with `kill(0)` polling.
    const cleared = await waitForPidFileGone(5000)
    if (!cleared) {
      timedOut = true
    } else {
      const exited = await waitForPidExit(pidFromFile, 5000)
      if (!exited) timedOut = true
    }
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

  // Residual diagnostic — informational only, scoped to artifacts
  // we can tie back to the supervisor we just stopped (currently the
  // tmux session recorded in the PID file). The previous host-wide
  // pgrep sweep would catch unrelated dev servers and report exit 4
  // on a clean stop; the session-anchored check here only fires when
  // the supervisor's own tmux session survived shutdown, which is a
  // genuine "something inside our scope leaked" signal.
  const residue = reportResidue(pidEntry)
  if (residue.length > 0) {
    console.warn(`[kb-stop] WARN: KB-scoped residual artifacts detected:`)
    for (const r of residue) {
      console.warn(`[kb-stop]   (${r.label}) ${r.line}`)
    }
    console.warn(
      `[kb-stop] Review and terminate manually if needed:\n` +
        `[kb-stop]   tmux kill-session -t <name>`,
    )
    process.exit(4)
  }

  console.log('[kb-stop] Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error(`[kb-stop] FATAL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
