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
 *   4  Partial success: the supervisor is gone but lineage-proven KB
 *      residue remains — an un-torn-down tmux session, a live orphan
 *      child, or a KB-assigned port still bound by a lineage-proven
 *      descendant (process-lifecycle.md §7.5 / §9). Zombies and ports
 *      held by unrelated / rebound processes are advisory only and do
 *      NOT trigger exit 4 (§9.1.1 / §9.1.2).
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
                         the candidates to processes whose entry
                         script resolves to THIS clone's
                         tools/kb-start.mjs (Phase 2-A: previous
                         host-wide substring sweep is out of
                         contract). Required to bypass the per-
                         project PID-file scope.

                         Platform note: argv comes from
                         /proc/<pid>/cmdline (NUL-separated,
                         lossless) when available. On platforms
                         without /proc (e.g. macOS) the matcher
                         falls back to a whitespace-split of the
                         pgrep -a output, which loses argv
                         boundaries — so two limitations apply:
                          (a) relative entry-script paths cannot be
                              resolved without /proc/<pid>/cwd and
                              are skipped with a WARN;
                          (b) absolute paths that contain
                              whitespace cannot be reconstructed
                              from the flat cmdline and may also
                              be missed.
                         Avoid clone paths with whitespace on
                         /proc-less platforms, or stop the
                         supervisor via the per-project PID-file
                         path (no --all flag) instead.
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
 * POSIX single-quote a path for safe inclusion in a suggested shell command
 * (e.g. the `rm` hint in the root-PID trust-gate refusal). PID_FILE_PATH is
 * derived from the operator-supplied projectRoot, so a path with spaces or
 * shell metacharacters (`$()`, backticks, `;`) printed verbatim into
 * `rm <path>` could be copy-pasted into something other than the intended
 * removal. Single-quoting neutralizes every metacharacter; an embedded
 * single quote becomes `'\''` (close-quote, literal quote, re-open).
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Escape control characters (newlines, carriage returns, ANSI escapes, other
 * C0 controls + DEL) before printing an operator-supplied path into a log /
 * error line. PID_FILE_PATH derives from the projectRoot, so a path with an
 * embedded newline or `\x1b[` sequence could otherwise forge extra log lines
 * or manipulate the terminal. Replaces each control byte with its `\xHH`
 * hex escape, keeping the message single-line and inert.
 */
function escapeForLog(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )
}

/**
 * Render a path for a suggested shell command that is BOTH shell-safe and
 * terminal-safe: single-quote it (neutralizes shell metacharacters) then
 * hex-escape any remaining control bytes (neutralizes log/terminal
 * injection). For the normal control-free path this is exactly `'<path>'`
 * and pastes correctly; a pathological path with control bytes renders inert
 * `\xHH` instead of a raw newline / ANSI sequence.
 */
function shellAndLogSafe(s) {
  return escapeForLog(shellQuote(s))
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
 * Read a process's argv from `/proc/<pid>/cmdline`. The kernel writes
 * argv NUL-separated, which preserves argument boundaries exactly the
 * way `exec()` saw them — unlike `pgrep -a` output, this survives
 * argv tokens that contain whitespace.
 *
 * Returns `null` when /proc is not available (typically macOS or a
 * restricted runtime), so callers can fall back to a lossy parser.
 */
function readArgvFromProc(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    const parts = raw.split('\0')
    // The trailing NUL produces an empty final segment. A literally
    // empty argv (no args at all) would also yield `['']`, which is
    // already useless for our argv[0] check below — drop the trailing
    // empty entry either way.
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return parts.length > 0 ? parts : null
  } catch {
    return null
  }
}

/** Read a process's cwd from `/proc/<pid>/cwd`. Returns `null` when unavailable. */
function readCwdFromProc(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Lineage snapshot + process identity (process-lifecycle.md §9.1.0,
// BL-2026-237).
//
// The residual diagnostics (§9) anchor on a snapshot of the supervisor's
// descendant PID closure, taken BEFORE any signal / tmux cleanup (§7.3
// step 3.5), plus a per-PID identity tuple (start-time + comm). After
// cleanup, a candidate PID counts as a lineage-proven KB descendant only
// when it is in the snapshot AND its identity tuple still matches — so a
// reused numeric PID (same number, different start-time) is never treated
// as KB residue. Reading the full process table with `ps` once is a
// read-only operation; it is NOT a host-wide kill/sweep (§3.4 boundary):
// kill targets stay restricted to the snapshot closure + identity match.
// ---------------------------------------------------------------------------

/**
 * Read a process's identity tuple. Linux primary: `/proc/<pid>/stat`
 * field 22 (starttime, clock-tick precision) + comm. macOS / non-procfs
 * fallback: `ps -o lstart= -o comm=` (second precision). Returns `null`
 * when the process is gone or cannot be read.
 *
 * `(pid, starttime)` is an OS-stable key the kernel does not reuse, so it
 * distinguishes a surviving KB child from an unrelated process that later
 * reused the same numeric PID.
 */
function readProcessIdentity(pid) {
  // Linux: parse /proc/<pid>/stat. comm is in parens and may itself
  // contain spaces / parens, so split on the LAST ')' to find the fields
  // after comm. starttime is field 22 (1-indexed) in the proc(5) layout,
  // i.e. index 19 of the post-comm field list (state is the first).
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const lastParen = raw.lastIndexOf(')')
    if (lastParen !== -1) {
      const firstParen = raw.indexOf('(')
      const comm =
        firstParen !== -1 && lastParen > firstParen
          ? raw.slice(firstParen + 1, lastParen)
          : null
      const after = raw.slice(lastParen + 2).trim().split(/\s+/)
      // after[0] = state, ... starttime is field 22 overall = after[19].
      const starttime = after[19] ?? null
      if (starttime != null) {
        return { pid, starttime: `tick:${starttime}`, comm }
      }
    }
  } catch {
    // fall through to ps
  }
  // macOS / non-procfs fallback (second precision; the residual
  // same-second PID-reuse edge is out of scope per §9.1.0).
  try {
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (out) {
      // lstart is a fixed 24-char date; comm follows.
      const lstart = out.slice(0, 24).trim()
      const comm = out.slice(24).trim() || null
      return { pid, starttime: `lstart:${lstart}`, comm }
    }
  } catch {
    // unavailable
  }
  return null
}

/** True when two identity tuples refer to the same process incarnation. */
function identityMatches(a, b) {
  if (!a || !b) return false
  return a.starttime === b.starttime && a.comm === b.comm
}

/**
 * List every process as `{ pid, ppid, stat, comm }` via a single
 * read-only `ps -eo pid=,ppid=,stat=,comm=`. Returns `null` when `ps` is
 * unavailable so callers degrade gracefully.
 */
function listAllProcesses() {
  try {
    const out = execFileSync(
      'ps',
      ['-eo', 'pid=,ppid=,stat=,comm='],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const rows = []
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!m) continue
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        stat: m[3],
        comm: m[4].trim(),
      })
    }
    return rows
  } catch {
    return null
  }
}

/**
 * Verify that `pid` is a live supervisor of THIS clone — i.e. a node
 * runtime whose entry script realpath-resolves to this clone's
 * `tools/kb-start.mjs` — using the same argv / realpath fence as
 * `pgrepSupervisorPids()`. Used before trusting a PID-file root as the
 * lineage root + force-kill anchor, so a stale / tampered PID file cannot
 * broaden the kill scope onto an unrelated same-user process tree.
 *
 * Returns:
 *   'ok'        — verified live supervisor of this clone
 *   'dead'      — the PID is not alive (ESRCH)
 *   'mismatch'  — alive, but not a kb-start.mjs supervisor of this clone
 *   'unknown'   — alive, but argv / cwd could not be read to decide
 *                 (e.g. /proc-less platform with a relative entry script)
 */
function classifySupervisorRoot(pid) {
  if (!isPidAlive(pid)) return 'dead'
  // argv source priority: /proc (lossless) > `ps -o command=` (lossy
  // whitespace split, the only option on /proc-less platforms like macOS).
  // Without the ps fallback the gate would return 'unknown' for every
  // PID-file stop on macOS, disabling lineage / --force entirely there.
  let argv = readArgvFromProc(pid)
  if (!argv) {
    try {
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out) argv = out.split(/\s+/).filter(Boolean)
    } catch {
      // ps unavailable / not permitted
    }
  }
  // Without any argv source we cannot apply the fence; do not silently trust.
  if (!argv || argv.length < 2) return 'unknown'
  if (!isNodeRuntime(argv[0])) return 'mismatch'
  const scriptIdx = findEntryScriptIndex(argv)
  if (scriptIdx === -1) return 'mismatch'
  const scriptArg = argv[scriptIdx]
  let scriptAbs
  if (isAbsolute(scriptArg)) {
    scriptAbs = scriptArg
  } else {
    const supCwd = readCwdFromProc(pid)
    if (!supCwd) return 'unknown' // cannot resolve a relative script safely
    scriptAbs = resolve(supCwd, scriptArg)
  }
  let scriptResolved
  try {
    scriptResolved = realpathSync(scriptAbs)
  } catch {
    scriptResolved = scriptAbs
  }
  let expected
  try {
    expected = realpathSync(resolve(repoRoot, 'tools', 'kb-start.mjs'))
  } catch {
    expected = resolve(repoRoot, 'tools', 'kb-start.mjs')
  }
  return scriptResolved === expected ? 'ok' : 'mismatch'
}

/**
 * Build the descendant PID closure rooted at `rootPid` plus an identity
 * tuple per PID (§9.1.0). Returns `null` when the process table cannot be
 * read (callers then skip orphan/zombie detection + WARN, but the
 * PID-file `ports` post-flight still runs since it needs no snapshot).
 */
function buildLineageSnapshot(rootPid) {
  const all = listAllProcesses()
  if (!all) return null
  // childrenOf: ppid → [pid...]
  const childrenOf = new Map()
  for (const row of all) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, [])
    childrenOf.get(row.ppid).push(row.pid)
  }
  const byPid = new Map(all.map((r) => [r.pid, r]))
  const closure = new Map()
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (closure.has(pid)) continue
    const row = byPid.get(pid)
    // Record identity now (start-time + comm) so a later PID-reuse can be
    // detected even after the original process exits.
    const identity = readProcessIdentity(pid)
    closure.set(pid, {
      pid,
      ppid: row ? row.ppid : null,
      comm: row ? row.comm : identity ? identity.comm : null,
      identity,
    })
    for (const child of childrenOf.get(pid) ?? []) stack.push(child)
  }
  return closure
}

/**
 * Build a merged descendant snapshot covering every root in `roots`
 * (used in `--all` mode where pgrep may discover multiple supervisors, so
 * orphan/zombie detection is not limited to the first one). Returns `null`
 * only when the process table cannot be read at all.
 */
function buildLineageSnapshotForRoots(roots) {
  let merged = null
  for (const root of roots) {
    const snap = buildLineageSnapshot(root)
    if (snap == null) return null // ps unavailable → degrade entirely
    if (merged == null) merged = new Map()
    for (const [pid, entry] of snap) {
      if (!merged.has(pid)) merged.set(pid, entry)
    }
  }
  return merged
}

/**
 * Best-effort: return the listening process for `port` as
 * `{ pid, cmd }`, or `null` when nothing is listening / lookup is not
 * permitted (§9.1.1 / §11.5). lsof primary, ss fallback. Never signals
 * the owner.
 */
function findPortListener(port) {
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let pid = null
    let cmd = null
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1).trim())
      else if (line.startsWith('c')) cmd = line.slice(1).trim()
    }
    if (pid) return { pid, cmd }
  } catch {
    // fall through to ss
  }
  try {
    const out = execFileSync('ss', ['-ltnp', `( sport = :${port} )`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/users:\(\("([^"]+)",pid=(\d+)/)
    if (m) return { pid: Number(m[2]), cmd: m[1] }
  } catch {
    // unavailable
  }
  return null
}

/**
 * Detect whether `argv[0]`'s basename names a Node-compatible
 * runtime: `node`, `nodejs` (Debian/Ubuntu legacy alternative), and
 * versioned variants like `node20`, `node22.1.0`.
 *
 * The match is intentionally narrow. Earlier permissive forms
 * (`^node([\d_-].*)?$`) admitted unrelated binaries that happen to
 * begin with `node`, including third-party watchers (`node-dev`),
 * monitors (`node_exporter`), and supervisor wrappers (`nodemon`),
 * any of which could carry kb-start.mjs in argv as data and trigger
 * a false-positive kill if accepted as the runtime.
 */
function isNodeRuntime(argv0) {
  const base = basename(argv0)
  return /^node(js|\d+(\.\d+)*)?$/.test(base)
}

/**
 * Node flags whose two-token form consumes the following argv as a
 * value operand. We need this list so the entry-script walker can
 * skip past `<flag> <value>` pairs without mis-treating the value as
 * the script. The `=value` form (e.g. `--require=mod`) is handled
 * separately by the leading-`-` check, since the entire token still
 * starts with `-`.
 *
 * The list covers the value-taking Node flags that reasonably appear
 * in a real KB / contributor invocation. New flags introduced by
 * future Node versions and not listed here would cause a false
 * negative (the value would be mistaken for the script and the
 * supervisor missed). Add to this set when that happens.
 */
const NODE_VALUE_FLAGS = new Set([
  // Module loading
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  // Policy
  '--experimental-policy',
  '--policy',
  '--policy-integrity',
  // Env file
  '--env-file',
  '--env-file-if-exists',
  // Profiling
  '--cpu-prof-dir',
  '--cpu-prof-name',
  '--cpu-prof-interval',
  '--heap-prof-dir',
  '--heap-prof-name',
  '--heap-prof-interval',
  // Diagnostic / report
  '--diagnostic-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  // Inspector
  '--inspect-port',
  '--inspect-host',
  '--inspect-brk-node',
  // V8 / sizes
  '--max-http-header-size',
  '--max-old-space-size',
  '--max-semi-space-size',
  '--v8-pool-size',
  // TLS / security
  '--unhandled-rejections',
  '--tls-cipher-list',
  '--openssl-config',
  '--openssl-shared-config',
  // Conditions / inputs
  '--conditions',
  '-C',
  '--input-type',
  // Snapshot
  '--snapshot-blob',
  '--build-snapshot-config',
  // Process / runtime metadata
  '--title',
  '--redirect-warnings',
  // Test runner
  '--test-shard',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-concurrency',
  // Tracing
  '--trace-event-categories',
  '--trace-event-file-pattern',
  // Watch
  '--watch-path',
])

/**
 * Node flags that put the runtime into "no entry script" mode: the
 * code is supplied inline via `<flag> <code>`, and any subsequent
 * positional becomes a data argument to that code, NOT the entry
 * script. We must recognize these explicitly so a process invoked as
 * `node -e "..." /abs/tools/kb-start.mjs` is not mistaken for a
 * supervisor (the kb-start.mjs token is data, not the entry script).
 */
const NODE_NO_SCRIPT_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  // `--check` runs syntax check on a script and exits without running
  // it. The supervisor must actually run, so a checker process is not
  // the supervisor. Skip those candidates.
  '--check',
  '-c',
  // `--test` / `--test-only` put node into the test runner mode. In
  // that mode argv positionals are *test files*, not the entry
  // script — `node --test /abs/tools/kb-start.mjs` runs the
  // KovitoBoard supervisor file as a test target, not as the
  // supervisor launch shape. Reject so kb-stop --all does not
  // SIGTERM unrelated test runners.
  '--test',
  '--test-only',
])

/**
 * Boolean Node flags that take no operand. The walker treats any
 * leading-`-` token NOT in this set, NODE_VALUE_FLAGS, or
 * NODE_NO_SCRIPT_FLAGS as an unknown flag and rejects the candidate
 * (refuse-on-unknown). The conservative bias is intentional: a false
 * negative (we miss a legitimate supervisor on a future Node flag)
 * is recoverable (the operator can re-run with `--force` or a
 * per-PID kill), but a false positive (we SIGTERM the wrong process)
 * is destructive.
 *
 * `--name=value` form is recognized inline; we don't need each
 * value-flag also listed here for the `=value` shape because the
 * leading `-` plus the embedded `=` makes the token unambiguously
 * a single flag-and-value.
 *
 * Source: Node.js v22 / v20 documented CLI options, narrowed to the
 * boolean (no-operand) subset that has appeared in production usage.
 */
const NODE_BOOLEAN_FLAGS = new Set([
  // Inspector (the bare forms; -port / -host / -brk-node are in VALUE_FLAGS)
  '--inspect',
  '--inspect-brk',
  // Source maps and warnings
  '--enable-source-maps',
  '--no-warnings',
  '--trace-warnings',
  '--trace-deprecation',
  '--throw-deprecation',
  '--no-deprecation',
  '--pending-deprecation',
  '--trace-uncaught',
  '--trace-exit',
  '--trace-sigint',
  '--trace-sync-io',
  '--trace-tls',
  // Memory / V8 (sizes are in VALUE_FLAGS)
  '--expose-gc',
  '--track-heap-objects',
  '--zero-fill-buffers',
  '--v8-options',
  // Module modes / experimental (boolean toggles)
  '--experimental-modules',
  '--experimental-vm-modules',
  '--experimental-wasi-unstable-preview1',
  '--experimental-fetch',
  '--experimental-global-customevent',
  '--experimental-global-webcrypto',
  '--experimental-network-imports',
  '--experimental-permission',
  '--experimental-shadow-realm',
  '--experimental-test-coverage',
  '--experimental-websocket',
  '--no-experimental-fetch',
  '--no-experimental-global-customevent',
  '--no-experimental-global-webcrypto',
  '--no-experimental-network-imports',
  '--no-experimental-shadow-realm',
  // TLS toggles (boolean, no operand). Values like cipher-list are VALUE_FLAGS.
  '--tls-min-v1.0',
  '--tls-min-v1.1',
  '--tls-min-v1.2',
  '--tls-min-v1.3',
  '--tls-max-v1.2',
  '--tls-max-v1.3',
  '--use-bundled-ca',
  '--use-openssl-ca',
  '--use-system-ca',
  // Reports (boolean toggles; directory / filename are VALUE_FLAGS)
  '--report-on-fatalerror',
  '--report-on-signal',
  '--report-uncaught-exception',
  '--report-compact',
  // Misc
  '--abort-on-uncaught-exception',
  '--force-async-hooks-checks',
  '--force-fips',
  '--force-node-api-uncaught-exceptions-policy',
  '--frozen-intrinsics',
  '--insecure-http-parser',
  '--interactive',
  '-i',
  '--no-addons',
  '--no-force-async-hooks-checks',
  '--node-memory-debug',
  '--openssl-legacy-provider',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--prof',
  '--prof-process',
  '--secure-heap',
  '--build-snapshot',
  // Watch (the bare toggle; --watch-path takes a value).
  // `--test` / `--test-only` are intentionally NOT here — they put
  // node into test-runner mode where argv positionals are test
  // files, so they belong in NODE_NO_SCRIPT_FLAGS instead.
  '--watch',
  '--watch-preserve-output',
])

/**
 * Locate the entry-script argument inside an argv array exec'd as
 * `node [node-flags...] script [script-args...]`. Returns the index
 * of the entry script in `argv`, or `-1` if none exists (e.g. eval
 * mode, missing script, unknown leading-`-` token before the script).
 *
 * Walks past:
 *   - boolean flags listed in NODE_BOOLEAN_FLAGS.
 *   - `<flag> <value>` pairs for flags listed in NODE_VALUE_FLAGS.
 *   - `--flag=value` tokens (any leading `-` token containing `=`).
 *
 * Rejects (returns -1) when:
 *   - a no-script flag is encountered (`-e` / `--eval` / `-p` /
 *     `--print` / `-c` / `--check`).
 *   - a leading-`-` token is unrecognized. This is the
 *     refuse-on-unknown bias — we'd rather miss a legitimate
 *     supervisor on a future Node flag than treat the value of an
 *     unknown value-taking flag as the entry script and SIGTERM
 *     the wrong process.
 *   - argv runs out before a non-flag positional appears.
 */
/**
 * `--eval=...` / `--print=...` are the inline-`=` forms of the
 * no-script flags. They put the runtime into eval mode just like
 * the two-token `-e <code>` / `--eval <code>` forms, so subsequent
 * positionals are eval-data, NOT the entry script. Matched as a
 * prefix because the suffix (`<code>`) is the eval payload.
 */
const NODE_NO_SCRIPT_INLINE_PREFIXES = ['--eval=', '--print=']

function isNoScriptInlineFlag(tok) {
  for (const prefix of NODE_NO_SCRIPT_INLINE_PREFIXES) {
    if (tok.startsWith(prefix)) return true
  }
  return false
}

function findEntryScriptIndex(argv) {
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (NODE_NO_SCRIPT_FLAGS.has(tok)) {
      return -1
    }
    if (isNoScriptInlineFlag(tok)) {
      // `--eval=<code>` and `--print=<code>` look like `--flag=value`
      // tokens, but they put node into a no-script mode, so the
      // walker must reject the candidate before the generic
      // `--flag=value` branch swallows them.
      return -1
    }
    if (tok === '--') {
      // Bare `--` is Node's documented end-of-options marker. The
      // next argv (if any) is unconditionally the entry script,
      // even when it would otherwise look like a flag. Without
      // this branch the walker would fall into the unknown-flag
      // rejection path and miss a supervisor launched as
      // `node -- tools/kb-start.mjs ...`.
      return i + 1 < argv.length ? i + 1 : -1
    }
    if (NODE_VALUE_FLAGS.has(tok)) {
      if (i + 1 >= argv.length) return -1
      i += 1
      continue
    }
    if (tok.startsWith('-')) {
      // `--flag=value` is one self-contained token.
      if (tok.includes('=')) continue
      // Single-letter combined boolean flags like `-rT` (uncommon)
      // and the canonical short forms (`-i`).
      if (NODE_BOOLEAN_FLAGS.has(tok)) continue
      // Unknown flag: refuse the candidate. We do not silently
      // continue past it because that would alias a future
      // value-taking flag's operand into the entry-script slot.
      return -1
    }
    // First non-flag positional is the entry script.
    return i
  }
  return -1
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
 * unrelated processes. We now require both:
 *
 *   1. `argv[0]` basename is a Node-compatible runtime
 *      (`node` / `nodejs` / `node20`-style versioned binaries).
 *      Shebang-launched invocations (`#!/usr/bin/env node`) still
 *      pass since the kernel re-execs through the runtime.
 *   2. The Node entry script — located by walking past Node flags
 *      and their operands per `findEntryScriptIndex` — resolves
 *      (after `realpath`) to the absolute path of
 *      `<repoRoot>/tools/kb-start.mjs`. We do NOT scan every argv
 *      token, because that would let `node other-script.js
 *      /abs/tools/kb-start.mjs` (where kb-start.mjs is data, not
 *      the entry script) and `node -e "..." /abs/tools/kb-start.mjs`
 *      (eval-mode, no entry script) match falsely. The walker
 *      recognizes value-taking flags (`--require`, `--import`,
 *      `--env-file`, etc.) and refuses eval-mode flags
 *      (`-e`, `--eval`, `-p`, `--print`).
 *
 * Argv comes from `/proc/<pid>/cmdline` when available (NUL-separated,
 * lossless). On platforms without /proc (e.g. macOS) we fall back to
 * the flat `pgrep -a` output and a naive whitespace split — argv
 * tokens that contain spaces are not recovered in that case, and the
 * affected candidate is skipped.
 *
 * Relative script paths (the embedded-layout default, `node
 * tools/kb-start.mjs --project-root ..`) are resolved against the
 * supervisor's cwd read from `/proc/<pid>/cwd`. When that cwd cannot
 * be obtained — same /proc-less platforms — we **refuse** to resolve
 * the relative path against kb-stop's own cwd. Doing so would let a
 * supervisor from a different clone match this clone's expected
 * script path whenever both clones happen to lay out the file at
 * `tools/kb-start.mjs` under their respective project roots; the
 * fence is exactly the cross-clone collateral kill that Phase 2-A is
 * designed to prevent. The candidate is skipped with a DEBUG note
 * instead, and operators can re-run the supervisor with an absolute
 * `node /abs/path/to/tools/kb-start.mjs` invocation if they need the
 * `--all` sweep to reach it on macOS.
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
    // joined cmdline. We extract the pid first; argv parsing
    // immediately switches to /proc when available so the flat
    // cmdline below is only used as a last resort.
    const space = trimmed.indexOf(' ')
    const pidPart = space >= 0 ? trimmed.slice(0, space) : trimmed
    const flatCmdline = space >= 0 ? trimmed.slice(space + 1) : ''
    const pid = Number.parseInt(pidPart, 10)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue

    // Argv source priority: /proc (lossless) > pgrep flat output
    // (lossy whitespace split). The lossy path keeps the macOS flow
    // working when paths have no embedded whitespace.
    let argv = readArgvFromProc(pid)
    if (!argv) {
      argv = flatCmdline.split(/\s+/).filter(Boolean)
    }
    if (argv.length < 2) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: argv has fewer than 2 tokens ` +
            `(source=${readArgvFromProc(pid) ? 'proc' : 'pgrep-fallback'})`,
        )
      }
      continue
    }
    const argv0 = argv[0]

    if (!isNodeRuntime(argv0)) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: argv[0]=${argv0} is not a node-compatible runtime`,
        )
      }
      continue
    }

    const scriptIdx = findEntryScriptIndex(argv)
    if (scriptIdx === -1) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: no entry script (eval mode or missing positional)`,
        )
      }
      continue
    }
    const scriptArg = argv[scriptIdx]

    let scriptAbs
    if (isAbsolute(scriptArg)) {
      scriptAbs = scriptArg
    } else {
      // Resolve the relative entry script using the supervisor's own
      // cwd, not kb-stop's cwd. Falling back to kb-stop's cwd would
      // alias a different clone's relative `tools/kb-start.mjs` onto
      // THIS clone's expected path whenever kb-stop is invoked from
      // inside a clone — the cross-clone collateral kill Phase 2-A
      // is meant to prevent.
      const supCwd = readCwdFromProc(pid)
      if (!supCwd) {
        // WARN-level (not DEBUG) so operators on /proc-less
        // platforms can see, in normal output, that `--all`
        // intentionally skipped a candidate. The embedded-layout
        // default starts the supervisor with `node tools/kb-start.mjs
        // --project-root ..` (relative argv[1]); on macOS this
        // skip path is the common case, and silently exiting 0
        // would falsely suggest no supervisor was present.
        console.warn(
          `[kb-stop] WARN: --all skipped pid ${pid}: relative entry script ${scriptArg} ` +
            `and the supervisor cwd is not available via /proc on this platform. ` +
            `If this is a real KovitoBoard supervisor, restart it with an absolute ` +
            `script path (e.g. "node /abs/path/tools/kb-start.mjs --project-root ..") ` +
            `so --all can fence it without aliasing to a different clone.`,
        )
        continue
      }
      scriptAbs = resolve(supCwd, scriptArg)
    }

    let scriptResolved
    try {
      scriptResolved = realpathSync(scriptAbs)
    } catch {
      scriptResolved = scriptAbs
    }

    if (scriptResolved !== expectedScriptPath) {
      if (debug) {
        console.error(
          `[kb-stop] DEBUG: skipping pid ${pid}: entry script resolves to ${scriptResolved}, ` +
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

/**
 * Residual diagnostics after the supervisor is confirmed gone
 * (process-lifecycle.md §9). Anchors only on (a) the lineage snapshot
 * taken before cleanup (§9.1.0), (b) the PID-file `tmux.sessionName`, and
 * (c) the PID-file `ports`. Never starts from a host-wide pgrep / port
 * scan (§3.4 boundary).
 *
 * Returns:
 *   exitResidue  — lineage-proven KB residue that warrants exit 4
 *                  (live orphans / tmux session / lineage-proven port).
 *   advisories   — informational only, do NOT affect the exit code
 *                  (zombies = OS/init reaps; unrelated/rebound port owner).
 *   killable     — lineage-proven live orphan PIDs that `--force` may
 *                  SIGKILL (zombies and unrelated processes excluded).
 *   snapshotUnavailable — true when the lineage snapshot could not be
 *                  taken; orphan/zombie detection was skipped.
 */
function reportResidue(pidEntry, lineageSnapshot, supervisorRoots = new Set()) {
  const exitResidue = []
  const advisories = []
  const killable = []
  const snapshotUnavailable = lineageSnapshot == null

  // --- tmux session not torn down (PID-file anchor, exact match) ---
  if (pidEntry?.tmux?.sessionName) {
    if (listTmuxSessions().includes(pidEntry.tmux.sessionName)) {
      exitResidue.push({
        label: 'tmux session not torn down',
        line: `tmux session "${pidEntry.tmux.sessionName}" is still active after supervisor stop`,
      })
    }
  }

  // --- live orphans + zombies (lineage snapshot anchor, §9.1 / §9.1.2) ---
  if (lineageSnapshot) {
    for (const entry of lineageSnapshot.values()) {
      // The supervisor roots are the stop targets, not orphans. On a
      // --force SIGKILL they may briefly linger (dying / zombie) before
      // the kernel reaps them, so excluding them here keeps the residue
      // diagnostic from reporting a successfully-killed supervisor as
      // residue and making the exit code timing-dependent.
      if (supervisorRoots.has(entry.pid)) continue
      // The supervisor PID itself is expected to be gone by now; a PID
      // that exited is not residue.
      if (!isPidAlive(entry.pid)) continue
      // PID reuse guard: the numeric PID is alive, but if its identity
      // tuple no longer matches the snapshot it is a different process
      // that reused the number — not KB residue (§9.1.0).
      const now = readProcessIdentity(entry.pid)
      if (!identityMatches(entry.identity, now)) continue

      const stat = now && now.comm != null ? readStatField(entry.pid) : null
      const isZombie = stat ? stat.includes('Z') : false
      if (isZombie) {
        // §9.1.2: report only, never reap; not an exit-code factor.
        advisories.push({
          label: 'zombie',
          line: `pid=${entry.pid} <defunct> ppid=${entry.ppid ?? '?'} (zombie — OS/init will reap; not killed)`,
        })
        continue
      }
      // Live orphan (§9.1): lineage-proven KB descendant still running.
      exitResidue.push({
        label: 'orphan',
        line: `pid=${entry.pid} cmd=${entry.comm ?? '?'} (orphan, lineage proven)`,
      })
      // `--force` may only SIGKILL an orphan whose identity rests on a
      // NON-REUSABLE kernel key (Linux `/proc/<pid>/stat` starttime,
      // recorded as `tick:`). The macOS / non-procfs `ps -o lstart`
      // fallback is second-precision, so a same-second PID reuse of
      // another process with the same comm could pass identityMatches();
      // killing by PID on that evidence risks signalling an unrelated
      // process. Such orphans are still reported (exit 4) but excluded
      // from the force-kill set, fail-safe toward not mis-killing.
      const strongIdentity =
        typeof now?.starttime === 'string' && now.starttime.startsWith('tick:')
      if (strongIdentity) {
        killable.push(entry.pid)
      } else {
        advisories.push({
          label: 'orphan not force-killable',
          line: `pid=${entry.pid} identity is second-precision (non-procfs); --force will not SIGKILL it to avoid mis-targeting a reused PID`,
        })
      }
    }
  }

  // --- port release post-flight (PID-file `ports` anchor, §9.1.1) ---
  const ports = pidEntry?.ports
  for (const [label, port] of [
    ['backend', ports?.backend],
    ['vite', ports?.vite],
  ]) {
    if (typeof port !== 'number') continue
    const owner = findPortListener(port)
    if (!owner) continue // released
    if (snapshotUnavailable) {
      // Without a lineage snapshot we cannot establish provenance, so we
      // must NOT claim the owner is "unrelated" (that could downgrade a
      // real leaked KB child from exit 4 to a false success). Report it as
      // ownership-unknown. We do not exit 4 (lineage is unproven, §9.1.1),
      // but the operator is told the diagnostics were degraded.
      advisories.push({
        label: 'port held; ownership unknown',
        line: `port ${port} (${label}) is still bound by pid=${owner.pid}${owner.cmd ? ` (${owner.cmd})` : ''}; lineage snapshot unavailable, KB-ownership could not be determined`,
      })
      continue
    }
    // Is the owner a lineage-proven KB descendant?
    const snapEntry = lineageSnapshot.get(owner.pid)
    const proven =
      snapEntry != null &&
      identityMatches(snapEntry.identity, readProcessIdentity(owner.pid))
    if (proven) {
      exitResidue.push({
        label: 'port still bound',
        line: `port ${port} (${label}) still bound by pid=${owner.pid} (lineage proven KB descendant)`,
      })
    } else {
      // PID reuse / external rebind: advisory only, exit 0 (§9.1.1).
      advisories.push({
        label: 'port held by unrelated process',
        line: `port ${port} (${label}) is now held by an unrelated process (pid=${owner.pid}${owner.cmd ? ` ${owner.cmd}` : ''}); not a KB residual`,
      })
    }
  }

  return { exitResidue, advisories, killable, snapshotUnavailable }
}

/** Read the `stat` (state) field for a live pid, or `null`. */
function readStatField(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const lastParen = raw.lastIndexOf(')')
    if (lastParen === -1) return null
    const after = raw.slice(lastParen + 2).trim().split(/\s+/)
    return after[0] ?? null // state char (R/S/D/Z/T/...)
  } catch {
    // macOS / non-procfs fallback
    try {
      const out = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return out || null
    } catch {
      return null
    }
  }
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

  // Root PID trust gate, positioned BEFORE the first signal (§7.3 step
  // 3.5(a) / §9.1.0, BL-2026-244). For a PID-file root in the normal
  // (non---all) path we classify it with `classifySupervisorRoot()` (the
  // clone-level fence: a live node runtime whose entry script realpaths to
  // THIS clone's tools/kb-start.mjs) and branch on the result:
  //
  //   ok        → proceed to signal it (the only path that sends SIGTERM)
  //   dead      → §7.4 stale path: remove the PID file, exit 0 (no signal,
  //               nothing alive to stop)
  //   mismatch  → exit 2: alive but NOT a supervisor of this clone — a
  //   unknown     stale / tampered PID file pointing at an unrelated
  //               (or unverifiable, /proc-less) process. Send NO signal;
  //               report only. Same "cannot safely stop, so do not touch"
  //               refuse as the EPERM (another user's supervisor) case.
  //
  // Before v1.8 this fence only gated the lineage snapshot / `--force`
  // kill scope, while the first graceful SIGTERM was sent to the raw PID
  // unconditionally. That left a window where a corrupt/tampered PID file
  // could route a graceful SIGTERM to an unrelated same-user process.
  // Hoisting the fence ahead of the signal closes graceful + force signal
  // mis-delivery to out-of-clone / other-user / non-KB processes
  // (process-lifecycle.md v1.8 §6.4 / §7.3 step 4 / §9.1.0 SSOT). The
  // residual same-clone-other-project window (a tampered PID file pointing
  // at a sibling project's supervisor of THIS clone) still passes `ok` and
  // is an explicit hedged residual pending a project-identity anchor
  // decision (process-lifecycle.md §6.4 "unresolved residual").
  //
  // `--all` / pgrep roots come from `pgrepSupervisorPids()`, which already
  // applies the same argv/realpath fence, so they are pre-validated and
  // skip this re-check.
  let pidFromFileKind = null
  if (pidFromFile != null && !args.all) {
    pidFromFileKind = classifySupervisorRoot(pidFromFile)
  }
  if (pidFromFileKind != null && pidFromFileKind !== 'ok' && !args.dryRun) {
    // Real-run signal-front gate. In --dry-run we never send a signal, so
    // the planner below (the SIGTERM loop's planLog) reports the planned
    // actions instead — the hard refuse / stale-clear exits belong to the
    // actual stop flow (§7.3 step 3.5(a)).
    if (pidFromFileKind === 'dead') {
      // Stale PID file: the recorded supervisor is gone. Clear the file
      // and report success (§7.4 stale path). Nothing to signal.
      //
      // TOCTOU guard: a fresh `kb-start` could overwrite the PID file in
      // the window between our read/classify and this unlink (its own §6.4
      // stale branch would overwrite the same dead-pid file and launch a
      // new supervisor pid Y). Removing the file unconditionally would then
      // delete the FRESH file for the live supervisor Y, leaving it running
      // untracked — re-opening the single-supervisor tracking window the
      // PID file guards. So re-read immediately before unlinking and only
      // remove the file while it still records the EXACT stale record we
      // classified. If it changed concurrently, leave it for the new owner
      // and report rather than clobber it.
      //
      // Identity is `pid` + `startedAt`, not `pid` alone: a concurrent
      // rewrite that reuses the same numeric pid (quick PID reuse, or a
      // rewrite that keeps `pid` but is a different launch) would slip past
      // a pid-only check. `startedAt` is minted fresh per launch
      // (`kb-start.mjs writePidFile` → `new Date().toISOString()`), so the
      // pair distinguishes our classified-dead record from any new launch.
      const recheck = readPidFile()
      const sameStaleRecord =
        recheck != null &&
        !recheck.broken &&
        recheck.pid === pidFromFile &&
        recheck.startedAt === pidEntry?.startedAt
      // Unlink ONLY when the file is still the exact stale record we
      // classified. Every other re-read outcome means the file is no longer
      // ours to remove: a different non-broken record (concurrent restart),
      // a broken/unreadable entry (a rewrite in progress, or a new corrupt
      // file we must not silently clobber — that is kb-start's §6.4
      // fail-loud territory), or null (already removed by someone else).
      // In all those cases, leave the file and report rather than delete a
      // file we no longer own.
      if (!sameStaleRecord) {
        const detail =
          recheck == null
            ? 'the PID file was removed concurrently'
            : recheck.broken
              ? `the PID file became unreadable concurrently (${recheck.broken})`
              : `the PID file now records pid ${recheck.pid}`
        console.warn(
          `[kb-stop] WARN: not removing the stale PID file — ${detail}. ` +
            `A new supervisor may have just started; re-run kb-stop to act on it.`,
        )
        console.log('[kb-stop] Done (stale PID file changed concurrently; left in place).')
        process.exit(0)
      }
      console.warn(
        `[kb-stop] WARN: PID-file root pid ${pidFromFile} is no longer alive ` +
          `(stale PID file); removing ${escapeForLog(PID_FILE_PATH)} and exiting.`,
      )
      removePidFile()
      console.log('[kb-stop] Done (stale PID file cleared; nothing was running).')
      process.exit(0)
    }
    if (pidFromFileKind === 'mismatch' || pidFromFileKind === 'unknown') {
      const reason =
        pidFromFileKind === 'mismatch'
          ? 'is alive but is not a KovitoBoard supervisor of this clone'
          : 'could not be verified as a supervisor of this clone on this platform'
      // Refuse to signal: a stale / tampered PID file must not route a
      // signal onto an unrelated process. exit 2 = same "cannot safely
      // stop, so do not touch" contract as EPERM (§7.5, BL-2026-244).
      console.error(
        `[kb-stop] ERROR: the recorded supervisor PID ${pidFromFile} ${reason}.\n` +
          `[kb-stop]        PID file: ${escapeForLog(PID_FILE_PATH)}\n` +
          `[kb-stop]        Refusing to send any signal: the PID file may be stale or\n` +
          `[kb-stop]        tampered and this PID could belong to a different process.\n` +
          `[kb-stop]        Inspect the PID file and remove it if no supervisor is running\n` +
          `[kb-stop]        (rm -- ${shellAndLogSafe(PID_FILE_PATH)}), or use --all to opt into the\n` +
          `[kb-stop]        host-wide supervisor sweep.`,
      )
      process.exit(2)
    }
  }

  // Lineage snapshot (§7.3 step 3.5 / §9.1.0): capture the supervisor's
  // descendant PID closure + identity tuples BEFORE any signal or tmux
  // cleanup, so post-cleanup orphan/zombie detection can anchor on it (the
  // tmux session is torn down later, which would make the pane PID tree
  // unrecoverable without a host-wide scan). Covers EVERY targeted
  // supervisor — in --all / pgrep mode pgrep may discover more than one, so
  // orphan/zombie detection is not limited to the first. Only an 'ok' root
  // anchors the snapshot; non-'ok' PID-file roots have already exited the
  // process at the signal-front gate above, so the guard below is defensive.
  let lineageSnapshot = null
  if (!args.dryRun && supervisors.length > 0) {
    let snapshotRoots = supervisors
    if (pidFromFile != null && !args.all && pidFromFileKind !== 'ok') {
      // Unreachable in practice: the signal-front gate above exits the
      // process for every non-'ok' PID-file kind. Kept as a defensive
      // guard so the lineage anchor is never built on an untrusted root if
      // the gate's branching ever changes (the §9.1.0 invariant: only an
      // 'ok' clone supervisor may anchor lineage + force-kill).
      snapshotRoots = []
    }
    if (snapshotRoots.length > 0) {
      lineageSnapshot = buildLineageSnapshotForRoots(snapshotRoots)
      if (lineageSnapshot == null) {
        console.warn(
          `[kb-stop] WARN: lineage snapshot unavailable; skipping orphan/zombie diagnostics`,
        )
      }
    }
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

  // Residual diagnostic (§9). Anchored on the lineage snapshot + PID-file
  // tmux session + PID-file ports — never a host-wide sweep. Splits into:
  //   - exitResidue: lineage-proven KB residue → exit 4 (§7.5)
  //   - advisories:  zombies (OS/init reaps) + unrelated port owners →
  //                  reported but do NOT affect the exit code (§9.1.1/§9.1.2)
  //
  // In --all mode there is no per-project PID-file anchor, so the
  // tmux-session / port post-flight cannot run (orphan/zombie detection
  // still works off the lineage snapshot). This is the accepted
  // degradation of the host-wide opt-in path (§7.4 / §9.1); make it
  // visible so a clean exit is not mistaken for a full residue check.
  if (pidEntry == null && supervisors.length > 0) {
    console.warn(
      `[kb-stop] WARN: --all mode has no PID-file anchor; tmux-session / ` +
        `port residue checks are skipped (orphan/zombie diagnostics still ` +
        `run). Use the normal PID-file stop for full residue diagnostics.`,
    )
  }
  const supervisorRootSet = new Set(supervisors)
  let { exitResidue, advisories, killable, snapshotUnavailable } =
    reportResidue(pidEntry, lineageSnapshot, supervisorRootSet)

  // --force: SIGKILL only lineage-proven live orphans. Zombies are never
  // reaped (OS/init responsibility, §9.1.2); unrelated / rebound port
  // owners are never signalled (lineage unproven, §9.1.1 / §9.2).
  if (args.force && killable.length > 0) {
    for (const pid of killable) {
      if (isPidAlive(pid)) {
        console.warn(`[kb-stop] --force: SIGKILL → lineage-proven orphan pid ${pid}`)
        killByPid(pid, 'SIGKILL')
      }
    }
    // SIGKILL delivery is asynchronous: a just-killed orphan can briefly
    // still appear alive and still hold its listening socket. Wait (bounded,
    // 2s / 50ms poll) for every killed PID to actually disappear before
    // re-evaluating, so a successful --force does not produce a spurious
    // exit 4 / "manual cleanup needed" report on the lingering window.
    const killDeadline = Date.now() + 2000
    while (Date.now() < killDeadline && killable.some((p) => isPidAlive(p))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    // Re-run the full diagnostic after the kill pass so EVERY derived
    // residue reflects the post-kill state — not just orphan entries. A
    // killed orphan that was the port owner releases its port, so the
    // "port still bound" entry must be re-evaluated too; otherwise
    // `--force` could exit 4 on stale pre-kill data even though the
    // residue is gone. (The killable set was lineage-proven before the
    // kill; we keep it from the pre-kill snapshot since the snapshot is
    // immutable, and the re-run anchors live/port state freshly.)
    ;({ exitResidue, advisories, snapshotUnavailable } = reportResidue(
      pidEntry,
      lineageSnapshot,
      supervisorRootSet,
    ))
  }

  for (const a of advisories) {
    console.warn(`[kb-stop]   (${a.label}) ${a.line}`)
  }

  if (exitResidue.length > 0) {
    console.warn(
      `[kb-stop] WARN: lineage-proven KB residual artifacts detected:`,
    )
    for (const r of exitResidue) {
      console.warn(`[kb-stop]   (${r.label}) ${r.line}`)
    }
    // The lineage anchor (§9.1.0) is held only in this kb-stop process's
    // memory and is consumed when the supervisor terminates, so a `--force`
    // RERUN after this exit-4 run cannot re-acquire it to target these
    // orphans. `--force` must be supplied on the SAME invocation that
    // performs the shutdown (process-lifecycle.md §9.2). Advertise that,
    // plus manual termination of the listed pids as the certain fallback.
    console.warn(
      `[kb-stop] These were detected after shutdown; the lineage anchor for ` +
        `this run is now gone, so a \`--force\` rerun cannot target them.\n` +
        `[kb-stop] To have KB terminate lineage-proven live processes ` +
        `automatically, re-run from a clean state with --force on the first ` +
        `invocation (\`npm run kb:stop -- --force\`).\n` +
        `[kb-stop] Otherwise, terminate the listed pids manually (e.g. ` +
        `\`kill <pid>\`). Zombies are reaped by the OS/init; unrelated ` +
        `processes are never touched.`,
    )
    process.exit(4)
  }

  if (snapshotUnavailable && advisories.length === 0) {
    // Diagnostics degraded but nothing actionable surfaced; still a
    // successful stop.
    console.log('[kb-stop] Done (orphan/zombie diagnostics skipped).')
    process.exit(0)
  }

  console.log('[kb-stop] Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error(`[kb-stop] FATAL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
