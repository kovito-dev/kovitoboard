#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard Supervisor (kb-start)
 *
 * Launches the backend server (tsx watch) and the Vite dev server as two
 * child processes.  Two restart paths are supported:
 *
 * 1. SIGUSR2 — preferred path used by POST /api/admin/restart.  The
 *    supervisor exposes its pid to children via KOVITOBOARD_SUPERVISOR_PID
 *    so the server can `process.kill(supPid, 'SIGUSR2')`.  The supervisor
 *    kills both children and relaunches.  This works even when the
 *    direct child is `tsx watch`, which otherwise swallows exit codes
 *    from the actual server process.
 *
 * 2. Exit code 42 — legacy / fallback path.  Used when the supervisor
 *    pid is not available to the server (e.g. running outside `npm
 *    start`) or when SIGUSR2 delivery fails.  Note this path is only
 *    reachable when the server is launched without `tsx watch` (which
 *    swallows the exit code); kept for `npm run prod` and tests.
 *
 * Any other exit terminates the supervisor.
 *
 * Usage:
 *   node tools/kb-start.mjs [OPTIONS]
 *
 * Options:
 *   --project-root <path>   Forwarded to children via the
 *                           KOVITOBOARD_PROJECT_ROOT environment variable
 *   --port=<n>              Backend (Express + WebSocket) port. When the
 *                           specified port is in use the supervisor exits
 *                           with an error. Without this flag the
 *                           supervisor probes 3001..3010 and uses the
 *                           first available port. Falls back to
 *                           `process.env.PORT` when both are unset.
 *   --vite-port=<n>         Vite dev server port. Same precedence /
 *                           probing rules as `--port`, with defaults
 *                           5173..5182 and `process.env.VITE_PORT`.
 *   --detach                Re-exec the supervisor in the background and
 *                           exit. Equivalent env var:
 *                           `KOVITOBOARD_DETACH=1`. Default behaviour is
 *                           still foreground; detach is purely additive
 *                           in v0.2.0.
 *   -h, --help              Print this help.
 *
 * Port resolution order (highest to lowest priority):
 *
 *   1. CLI flag (`--port`, `--vite-port`)        — error if in use
 *   2. Environment (`PORT`, `VITE_PORT`)         — error if in use
 *   3. Auto-probe from the default starting port — increments until
 *                                                  a free port is found
 *
 * The chosen ports are exported to children as `PORT` / `VITE_PORT`
 * before spawn so the existing readers in `src/server/index.ts` and
 * `vite.config.ts` pick them up unchanged.
 *
 * @see DEC-016 (dev-mode canonical)
 */

import { spawn } from 'child_process'
import { createServer as createNetServer } from 'net'
import { resolve, dirname, relative, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import {
  existsSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  constants as fsConstants,
} from 'fs'
import {
  decideDetach,
  buildDetachedSpawnArgs,
} from './kb-detach-helpers.mjs'

const RESTART_EXIT_CODE = 42
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

function parseStringFlag(argv, name) {
  const args = argv.slice(2)
  const idx = args.findIndex(
    (a) => a === name || a.startsWith(`${name}=`),
  )
  if (idx === -1) return null

  const arg = args[idx]
  const raw = arg.includes('=') ? arg.split('=')[1] : args[idx + 1]
  return raw && raw.length > 0 ? raw : null
}

function parsePortFlag(argv, name) {
  const raw = parseStringFlag(argv, name)
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `[kb-start] Invalid port for ${name}: "${raw}". Expected an integer in [1, 65535].`,
    )
  }
  return n
}

function parseEnvPort(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(
      `[kb-start] Ignoring invalid env ${name}="${raw}" (expected integer in [1, 65535]).`,
    )
    return null
  }
  return n
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node tools/kb-start.mjs [OPTIONS]

Options:
  --project-root <path>   Forwarded to children via KOVITOBOARD_PROJECT_ROOT
  --port=<n>              Backend port (Express + WebSocket).
                          Defaults: probe 3001..3010, then env PORT.
                          Errors out when the specified port is in use.
  --vite-port=<n>         Vite dev server port.
                          Defaults: probe 5173..5182, then env VITE_PORT.
                          Errors out when the specified port is in use.
  --detach                Run the supervisor in the background. The
                          parent shell returns immediately after spawning
                          the supervisor; stop it later with
                          \`kill <pid>\`. Equivalent env var:
                          \`KOVITOBOARD_DETACH=1\`.
  -h, --help              Print this help.

Examples:
  node tools/kb-start.mjs                                # auto-probe both
  node tools/kb-start.mjs --port=8080                    # backend fixed
  node tools/kb-start.mjs --port=8080 --vite-port=8000   # both fixed
  PORT=8080 node tools/kb-start.mjs                      # env fallback
  node tools/kb-start.mjs --detach                       # background launch
`)
  process.exit(0)
}

const projectRoot =
  (parseStringFlag(process.argv, '--project-root')
    ? resolve(parseStringFlag(process.argv, '--project-root'))
    : null) ||
  process.env.KOVITOBOARD_PROJECT_ROOT ||
  null

// ---------------------------------------------------------------------------
// PID file + multi-launch refuse (process-lifecycle.md v1.2 §6 / §10)
//
// The supervisor publishes its pid (and a small metadata blob) at
// `<projectRoot>/.kovitoboard/run/supervisor.pid` so `kb-stop` can
// find it deterministically and so a second `npm start` against the
// same projectRoot bails out instead of silently launching a parallel
// supervisor.
//
// Path anchoring: when projectRoot is unresolved (no --project-root,
// no env var, and the cwd is outside the KB clone), we fall back to
// the KB clone root for the same reason the detach branch does — the
// PID file goes somewhere predictable so `kb-stop` can still find it.
// In the embedded model (the only supported deployment per
// kovitoboard-master-spec §2.2 / process-lifecycle §1) projectRoot is
// always set, so the fallback only matters for contributor / test
// usage from inside the clone.
// ---------------------------------------------------------------------------

const PID_FILE_PATH = resolve(
  projectRoot ?? repoRoot,
  '.kovitoboard',
  'run',
  'supervisor.pid',
)

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 = no signal sent, just check the deliverability. The
    // call succeeds when the pid exists and we are allowed to signal
    // it; throws ESRCH when the process is gone, EPERM when it
    // exists but is owned by another user (still alive — we treat
    // that as "running", because launching a second supervisor would
    // collide on ports anyway).
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
  } catch {
    return { broken: 'read-failed' }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { broken: 'parse-failed' }
  }
  if (!data || typeof data !== 'object' || typeof data.pid !== 'number') {
    return { broken: 'schema' }
  }
  return data
}

function writePidFile(meta) {
  const dir = dirname(PID_FILE_PATH)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn(
      `[kb-start] WARN: failed to prepare ${dir} (${err && err.message}); skipping PID file write`,
    )
    return false
  }
  // Atomic write: same-directory temp file + rename. Without atomicity,
  // a crash mid-write would leave a half-written PID file that
  // multi-launch detection cannot parse (and would treat as broken on
  // every subsequent startup until the user removed it).
  const tempPath = `${PID_FILE_PATH}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tempPath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
    renameSync(tempPath, PID_FILE_PATH)
    return true
  } catch (err) {
    try {
      unlinkSync(tempPath)
    } catch {
      // best-effort cleanup
    }
    console.warn(
      `[kb-start] WARN: failed to write PID file (${err && err.message})`,
    )
    return false
  }
}

function removePidFile() {
  try {
    unlinkSync(PID_FILE_PATH)
  } catch {
    // ENOENT is the expected case after a SIGKILL clean-up; ignore.
  }
}

/**
 * Examine an existing PID file and either bail out (alive supervisor),
 * warn + overwrite (stale / corrupt PID file), or do nothing (no PID
 * file). Spec process-lifecycle §6.4.
 */
function checkExistingSupervisor() {
  const existing = readPidFile()
  if (!existing) return
  if (existing.broken) {
    console.warn(
      `[kb-start] WARN: ${existing.broken === 'parse-failed' ? 'corrupt' : 'unreadable'} PID file at ${PID_FILE_PATH}; overwriting`,
    )
    return
  }
  if (isPidAlive(existing.pid)) {
    const url =
      existing.ports && existing.ports.vite
        ? ` (Frontend: http://localhost:${existing.ports.vite})`
        : ''
    // The `kb:stop` script lives in `package.json` inside the KB clone
    // (`repoRoot`), NOT in the user project root. In the embedded
    // layout — `<project>/kovitoboard/` is the clone, and `kb-start`
    // launches with `--project-root ..` — pointing the operator at
    // `projectRoot` would land them outside the clone where the npm
    // script does not exist. Use `repoRoot` so the hint is always
    // runnable.
    const stopHint = `cd ${repoRoot} && npm run kb:stop`
    console.error(
      `[kb-start] ERROR: KovitoBoard supervisor is already running` +
        ` (pid=${existing.pid})${url}.\n` +
        `[kb-start]        To stop it, run: ${stopHint}`,
    )
    process.exit(1)
  }
  console.warn(
    `[kb-start] WARN: stale PID file detected (pid=${existing.pid}, dead); overwriting`,
  )
}

/**
 * Refuse to start when the cwd lives inside the KB clone and the user
 * did not point us at a target project (M-1, spec
 * `shared-installation-prevention-request.md` §M-1). The embedded
 * model expects `cd <project>/kovitoboard && npm start -- --project-root ..`,
 * which sets projectRoot via --project-root and bypasses this branch.
 *
 * The check is bounded by `projectRoot == null` so any explicit
 * --project-root or KOVITOBOARD_PROJECT_ROOT immediately satisfies
 * the requirement, even if the operator happens to be running from
 * inside a checkout for development reasons.
 */
function refuseKbCloneSelfManagement() {
  if (projectRoot) return
  const rel = relative(repoRoot, process.cwd())
  // `relative` returns '' when paths match, '..' / '../...' when cwd
  // is outside repoRoot, and an in-tree relative path (no leading
  // '..', not absolute) when cwd is inside.
  const cwdInsideClone =
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (!cwdInsideClone) return
  console.error(
    `[kb-start] ERROR: KovitoBoard cannot manage itself as a project.\n` +
      `[kb-start]        Specify the target project explicitly:\n` +
      `[kb-start]          npm start -- --project-root <path-to-project>\n` +
      `[kb-start]        Or set KOVITOBOARD_PROJECT_ROOT=<path>.\n` +
      `[kb-start]        See README.md "Starting the server" for the embedded deployment model.`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Detach branch: re-exec self in the background, then exit
//
// When the user invokes `--detach` (or sets `KOVITOBOARD_DETACH=1`), we
// fork a fresh node process with the same arguments minus `--detach`,
// wire it up so it survives the parent shell, and exit. The child
// inherits `KOVITOBOARD_DETACHED=1` and therefore takes the normal
// foreground branch below — no recursion, no double fork.
//
// Placement: this branch runs AFTER projectRoot resolution because the
// detach log directory is anchored under projectRoot. Putting detach
// before that step would either lose the resolved log location or
// require duplicating the resolution.
//
// Stopping is intentionally manual for v0.2.0: the supervisor PID is
// printed and the user kills it directly. A `kb:stop` script will be
// added by the process-lifecycle Phase 1 work; once landed, this
// message will mention `npm run kb:stop` as the preferred command.
// ---------------------------------------------------------------------------

// M-1 must run BEFORE the detach branch so a stray
// `cd <kb-clone> && npm start -- --detach` does not silently
// background a self-managing supervisor; the refuse covers both
// foreground and detached invocations.
refuseKbCloneSelfManagement()

// Multi-launch detection runs in the parent here so a misfire (an
// already-running supervisor) is reported in the operator's terminal
// instead of buried in `kb-detach-stderr.log`. The detached child
// re-runs the same check from `launch()` to catch anything that
// changed during the spawn window.
checkExistingSupervisor()

if (decideDetach(process.argv.slice(2), process.env)) {
  const { childArgs, childEnv } = buildDetachedSpawnArgs(
    process.argv,
    process.env,
    process.execArgv,
  )

  // Anchor early-startup diagnostics to a real file so an EACCES /
  // EMFILE / ENOMEM at fork time leaves a trace. We only redirect
  // stderr — stdout is `'ignore'` because the regular server pipeline
  // (pino) writes its own rotated `.kovitoboard/logs/server.*.log` and
  // duplicating its output here would (a) double the on-disk volume
  // and (b) accidentally persist anything an app prints to stdout
  // (e.g. recipe install scripts). The stderr file is intentionally
  // narrow: it captures bootstrap-time crashes, not the steady-state
  // process output.
  const logBase = projectRoot ?? repoRoot
  const logDir = resolve(logBase, '.kovitoboard', 'logs')
  let logFd
  let logPath
  try {
    mkdirSync(logDir, { recursive: true })
    logPath = resolve(logDir, 'kb-detach-stderr.log')
    // Open with explicit numeric flags rather than the 'w' shorthand
    // so we can add `O_NOFOLLOW`. Without it, an attacker (or a buggy
    // earlier run) that replaced the path with a symlink could redirect
    // our truncate-and-write into a file outside `.kovitoboard/logs/`.
    // `O_TRUNC` keeps the per-run-fresh semantics (disk usage bounded
    // to a single run); `0o600` blocks other users on shared hosts
    // from reading whatever stderr captures.
    logFd = openSync(
      logPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    )
  } catch (err) {
    const reason =
      err instanceof Error && /** @type {{code?: string}} */ (err).code === 'ELOOP'
        ? `${logPath} is a symlink (refused by O_NOFOLLOW); remove it and retry.`
        : err instanceof Error
          ? err.message
          : String(err)
    console.error(`[kb-start] Failed to prepare detach log at ${logDir}: ${reason}`)
    process.exit(1)
  }

  // Use process.execPath rather than process.argv[0] so symlinked /
  // aliased entrypoints (e.g. `nodejs` on Debian, nvm shims) resolve
  // to the actual node binary. Pair it with execArgv prepended via
  // buildDetachedSpawnArgs so loaders, inspector ports, and future
  // permission flags carry over to the child.
  let child
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      env: childEnv,
    })
  } catch (err) {
    closeSync(logFd)
    console.error(
      `[kb-start] Failed to spawn detached supervisor: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    process.exit(1)
  }

  // Positive confirmation: wait for either the `'spawn'` event
  // (Node 15.1+, the child has actually been forked) or an `'error'`
  // event (async failure such as EACCES delivered after `spawn()`
  // returned). Without this, the parent could exit `0` and print the
  // "Detached" line before the kernel reported the spawn failure,
  // leaving the user staring at a fake success.
  const spawnResult = await new Promise((resolveSpawn) => {
    let settled = false
    child.once('spawn', () => {
      if (settled) return
      settled = true
      resolveSpawn({ ok: true })
    })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      resolveSpawn({ ok: false, err })
    })
  })

  if (!spawnResult.ok) {
    closeSync(logFd)
    console.error(
      `[kb-start] Detached supervisor failed to start: ${spawnResult.err.message}`,
    )
    process.exit(1)
  }

  if (typeof child.pid !== 'number' || child.pid <= 0) {
    closeSync(logFd)
    console.error('[kb-start] Detached supervisor produced no pid.')
    process.exit(1)
  }

  // Early-exit window: after the fork is confirmed via the 'spawn'
  // event, watch briefly for an immediate `'exit'` so a child that
  // crashes during initial setup (e.g. invalid CLI args, bad
  // execArgv) does not present as a successful detach. The window is
  // intentionally short — full startup readiness (port bind, server
  // listening) is out of scope for this PR and belongs with the
  // process-lifecycle Phase 1 handshake work.
  const EARLY_EXIT_WINDOW_MS = 200
  const earlyExitCheck = await new Promise((resolveCheck) => {
    const timer = setTimeout(() => resolveCheck({ ok: true }), EARLY_EXIT_WINDOW_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveCheck({ ok: false, code, signal })
    })
  })

  if (!earlyExitCheck.ok) {
    closeSync(logFd)
    const reason =
      earlyExitCheck.signal !== null
        ? `signal=${earlyExitCheck.signal}`
        : `code=${earlyExitCheck.code}`
    console.error(
      `[kb-start] Detached supervisor exited during early startup (${reason}). See ${logPath} for stderr.`,
    )
    process.exit(1)
  }

  child.unref()
  // The parent's reference to the log fd is no longer needed; the
  // child inherited a dup'd handle for its stderr. Leaving the parent
  // fd open would just leak it on exit.
  closeSync(logFd)

  console.log(
    `[kb-start] Detached (pid=${child.pid}). Stop with 'kill ${child.pid}'.`,
  )
  console.log(`[kb-start] Detach stderr log: ${logPath}`)
  process.exit(0)
}

let cliBackendPort
let cliVitePort
try {
  cliBackendPort = parsePortFlag(process.argv, '--port')
  cliVitePort = parsePortFlag(process.argv, '--vite-port')
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(2)
}
const envBackendPort = parseEnvPort('PORT')
const envVitePort = parseEnvPort('VITE_PORT')

// ---------------------------------------------------------------------------
// Port resolution
// ---------------------------------------------------------------------------

const DEFAULT_BACKEND_PORT = 3001
const DEFAULT_VITE_PORT = 5173
const PORT_PROBE_ATTEMPTS = 10

/**
 * Check whether `port` is free for an IPv4 listener on all interfaces.
 *
 * Uses `net.createServer().listen(port)` (no host) so the probe binds
 * to the same set of interfaces the actual server / Vite use. The
 * server is closed before the promise resolves, so the port is
 * released before the real listener starts. There is a small race
 * window between the probe close and the child process bind, but in
 * practice that window is microseconds and the auto-probe loop simply
 * advances on the next attempt if it loses the race.
 */
function isPortAvailable(port) {
  return new Promise((resolveProbe) => {
    const probe = createNetServer()
    probe.once('error', () => resolveProbe(false))
    probe.once('listening', () => {
      probe.close(() => resolveProbe(true))
    })
    try {
      probe.listen(port)
    } catch {
      resolveProbe(false)
    }
  })
}

/**
 * Resolve the port to use for a service.
 *
 * Priority: CLI flag > environment variable > auto-probe.
 *
 * - CLI / env path: the specified port is checked once. When it is in
 *   use we throw, because the user expressed intent and falling back
 *   silently would surprise them later (the supervisor would advertise
 *   a port the user did not ask for).
 * - Auto-probe path: scan `default..default + attempts` and use the
 *   first free port. Only this path tolerates collisions.
 *
 * The throw is caught by the caller so the supervisor exits cleanly
 * with a diagnostic instead of a stack trace.
 */
async function resolvePort({
  label,
  cliFlag,
  envVarName,
  cliValue,
  envValue,
  defaultStart,
  attempts,
}) {
  if (cliValue !== null) {
    if (await isPortAvailable(cliValue)) return cliValue
    throw new Error(
      `[kb-start] ${label} port ${cliValue} (specified via ${cliFlag}) is already in use.`,
    )
  }
  if (envValue !== null) {
    if (await isPortAvailable(envValue)) return envValue
    throw new Error(
      `[kb-start] ${label} port ${envValue} (specified via env ${envVarName}) is already in use.`,
    )
  }
  for (let i = 0; i < attempts; i++) {
    const candidate = defaultStart + i
    if (await isPortAvailable(candidate)) {
      if (i > 0) {
        console.log(
          `[kb-start] ${label} default port ${defaultStart} unavailable; using ${candidate}.`,
        )
      }
      return candidate
    }
  }
  throw new Error(
    `[kb-start] No available ${label} port in [${defaultStart}, ${defaultStart + attempts}). ` +
      `Specify one explicitly with the matching CLI flag or env var.`,
  )
}

// ---------------------------------------------------------------------------
// A3: Symlink <repo>/app → <projectRoot>/app
// ---------------------------------------------------------------------------

function ensureAppSymlink() {
  if (!projectRoot) {
    console.warn(
      '[kb-start] projectRoot not specified; skipping app/ symlink setup',
    )
    return
  }

  const target = resolve(projectRoot, 'app')
  const linkPath = resolve(repoRoot, 'app')

  if (existsSync(linkPath)) {
    let stat
    try {
      stat = lstatSync(linkPath)
    } catch {
      return // cannot stat — leave as-is
    }

    if (stat.isSymbolicLink()) {
      const current = readlinkSync(linkPath)
      if (resolve(repoRoot, current) === target) {
        // Already correctly linked
        return
      }
      console.warn(
        `[kb-start] ${linkPath} already points elsewhere (${current}). ` +
          `Leaving as-is; user apps at ${target} may not be visible. ` +
          `Remove ${linkPath} manually and restart to re-link.`,
      )
      return
    }

    // Regular file or directory — don't touch
    console.warn(
      `[kb-start] ${linkPath} exists as a regular ${stat.isDirectory() ? 'directory' : 'file'}. ` +
        `Leaving as-is; user apps at ${target} may not be visible. ` +
        `If this is unexpected, rename/remove ${linkPath} and restart.`,
    )
    return
  }

  // Ensure target exists (create empty dir if not)
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true })
    console.log(
      `[kb-start] Created ${target} (empty, will be populated by recipe apply)`,
    )
  }

  symlinkSync(target, linkPath, 'dir')
  console.log(`[kb-start] Linked ${linkPath} → ${target}`)
}

// ---------------------------------------------------------------------------
// Resolve binaries from node_modules/.bin
// ---------------------------------------------------------------------------

const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const viteBin = resolve(repoRoot, 'node_modules/.bin/vite')

// ---------------------------------------------------------------------------
// Launch children
// ---------------------------------------------------------------------------

/** @type {import('child_process').ChildProcess | null} */
let serverChild = null
/** @type {import('child_process').ChildProcess | null} */
let viteChild = null
let shuttingDown = false
let restarting = false

function killChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill(signal)
  } catch {
    // already dead — ignore
  }
}

async function launch() {
  if (shuttingDown) return
  restarting = false

  // Resolve ports before spawn so children inherit a definite PORT /
  // VITE_PORT. SIGUSR2-driven restarts also flow through here, which
  // means each restart re-probes — handy when an old child took a
  // moment to release its port.
  let backendPort
  let vitePort
  try {
    backendPort = await resolvePort({
      label: 'Backend',
      cliFlag: '--port',
      envVarName: 'PORT',
      cliValue: cliBackendPort,
      envValue: envBackendPort,
      defaultStart: DEFAULT_BACKEND_PORT,
      attempts: PORT_PROBE_ATTEMPTS,
    })
    vitePort = await resolvePort({
      label: 'Frontend (Vite)',
      cliFlag: '--vite-port',
      envVarName: 'VITE_PORT',
      cliValue: cliVitePort,
      envValue: envVitePort,
      defaultStart: DEFAULT_VITE_PORT,
      attempts: PORT_PROBE_ATTEMPTS,
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    shuttingDown = true
    process.exit(1)
  }

  // Per-launch authentication token (32 hex chars = 128 bits of entropy).
  // The supervisor mints a fresh token for every launch — including each
  // SIGUSR2-driven restart — so any token captured before the restart is
  // immediately invalidated when the server reboots. The token gates
  // privileged HTTP routes and the WebSocket upgrade (see middleware in
  // src/server/index.ts and the renderer kbFetch helper). Logging the
  // token is intentionally avoided: it only travels through the env vars
  // of the two children, never through stdout.
  const launchToken = randomBytes(16).toString('hex')
  // Internal token (v0.2.0 / spec v1.7 §6.10.6.9). Issued per launch
  // alongside the launch token; gates the host-only capture-mount /
  // capture-token / host-bootstrap audit endpoints so recipe code
  // cannot mint or revoke capture identities even if it observes
  // the launch token. Same format (32-char hex) and lifetime rules
  // as KB_LAUNCH_TOKEN. Honest claim: same-realm in v0.2.x means
  // this is hardening, not structural isolation — see spec
  // §6.10.6.11.
  const internalToken = randomBytes(16).toString('hex')

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    KOVITOBOARD_PROJECT_ROOT: projectRoot ?? '',
    PORT: String(backendPort),
    VITE_PORT: String(vitePort),
    // Expose the supervisor pid so the server's restart endpoint can
    // signal us directly (SIGUSR2). `process.ppid` is not usable here
    // because the direct parent of the server is `tsx watch`, not us.
    KOVITOBOARD_SUPERVISOR_PID: String(process.pid),
    // Per-launch token: the backend reads this and rejects any request
    // whose `X-Kovitoboard-Token` header (HTTP) or `?token=` query (WS
    // upgrade) does not match. Vite picks it up too so the index.html
    // transform can embed the token in a meta tag for the renderer.
    KB_LAUNCH_TOKEN: launchToken,
    KB_INTERNAL_TOKEN: internalToken,
  }

  // --- Server (tsx watch — auto-reloads server source changes; the
  //     supervisor relies on SIGUSR2 for restart, not the child exit
  //     code, so `tsx watch`'s exit-code swallowing is not an issue) ---
  serverChild = spawn(tsxBin, ['watch', 'src/server/index.ts'], {
    stdio: 'inherit',
    cwd: repoRoot,
    env,
  })

  // --- Vite dev server ---
  viteChild = spawn(viteBin, [], {
    stdio: 'inherit',
    cwd: repoRoot,
    env,
  })

  // Publish the supervisor pid + chosen ports + tmux session name so
  // `kb-stop` (and a future second `kb-start` against the same
  // projectRoot) can find this process deterministically. Spec
  // process-lifecycle.md v1.2 §6.3 SSOT for the lifecycle (write at
  // launch / delete at shutdown). The write happens AFTER spawn so
  // we know the children survived the fork; if a port collision
  // killed us mid-resolvePort() above, no PID file gets created.
  const tmuxSessionName =
    process.env.KOVITOBOARD_E2E_TMUX_SESSION ??
    `kovitoboard-${(projectRoot ? projectRoot.split('/').pop() : repoRoot.split('/').pop()) ?? 'unknown'}`.replace(/[.:]/g, '-')
  writePidFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: projectRoot ?? repoRoot,
    projectRootSource: projectRoot
      ? parseStringFlag(process.argv, '--project-root')
        ? 'cli-arg'
        : 'env'
      : 'cwd-fallback',
    ports: { backend: backendPort, vite: vitePort },
    tmux: { sessionName: tmuxSessionName },
  })

  // Surface the resolved URLs and operational metadata prominently so
  // a user who specified no ports (and thus may have landed on
  // something other than 5173) knows exactly where to point their
  // browser, and so the operator can copy-paste the projectRoot /
  // tmux session into a kb-stop / kb-diagnose invocation. Shown
  // after spawn because that is the moment we have committed to
  // these ports.
  console.log('')
  console.log('[kb-start] KovitoBoard ready')
  console.log(`[kb-start]   Project:  ${projectRoot ?? '(cwd fallback) ' + repoRoot}`)
  console.log(`[kb-start]   Backend:  http://localhost:${backendPort}`)
  console.log(
    `[kb-start]   Frontend: http://localhost:${vitePort}  ← open this in your browser`,
  )
  console.log(`[kb-start]   tmux session: ${tmuxSessionName}`)
  console.log(`[kb-start]   PID file: ${PID_FILE_PATH}`)
  console.log('[kb-start]   Stop with: npm run kb:stop')
  console.log('')

  // --- Server exit handler ---
  serverChild.on('exit', (code, signal) => {
    // During a SIGUSR2-driven restart, both children are intentionally
    // killed by triggerRestart(); the relaunch is orchestrated there.
    // Without this guard, the SIGTERM exit would be misclassified as
    // "Normal exit or error" below and shut the supervisor down.
    if (shuttingDown || restarting) return

    if (code === RESTART_EXIT_CODE) {
      console.log('[kb-start] Restart signaled (exit 42), relaunching...')
      restarting = true
      killChild(viteChild)
      // Wait for vite to exit before relaunching
      const waitForVite = () => {
        if (
          !viteChild ||
          viteChild.exitCode !== null ||
          viteChild.signalCode !== null
        ) {
          setTimeout(() => {
            launch().catch((err) => {
              console.error('[kb-start] Restart launch failed:', err)
              shuttingDown = true
              process.exit(1)
            })
          }, 500)
        } else {
          setTimeout(waitForVite, 100)
        }
      }
      waitForVite()
      return
    }

    // Normal exit or error — shut down everything
    console.log(
      `[kb-start] Server exited (code=${code}, signal=${signal}). Shutting down.`,
    )
    shuttingDown = true
    killChild(viteChild)
    process.exitCode = code ?? 1
  })

  // --- Vite exit handler ---
  viteChild.on('exit', (code, signal) => {
    if (shuttingDown || restarting) return

    // Unexpected vite death while server is still running
    console.error(
      `[kb-start] Vite exited unexpectedly (code=${code}, signal=${signal}). Shutting down.`,
    )
    shuttingDown = true
    killChild(serverChild)
    process.exitCode = 1
  })
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[kb-start] Received ${signal}, shutting down...`)
  // Remove the PID file before kicking the children so a racing
  // kb-stop sees the file disappear (its readiness signal). The
  // children kill is best-effort either way; the absence of a PID
  // file is our publicly-visible "graceful shutdown started" state.
  removePidFile()
  killChild(serverChild, signal)
  killChild(viteChild, signal)

  // Give children a moment to exit, then force-exit
  setTimeout(() => {
    process.exit(0)
  }, 3000)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ---------------------------------------------------------------------------
// SIGUSR2: restart trigger from POST /api/admin/restart
// ---------------------------------------------------------------------------

/**
 * Kill both children, wait for both to exit, then relaunch.
 * Idempotent: ignored if a restart or shutdown is already in progress.
 */
function triggerRestart() {
  if (shuttingDown || restarting) return
  console.log('[kb-start] Restart requested via SIGUSR2, relaunching...')
  restarting = true

  killChild(serverChild)
  killChild(viteChild)

  // Force-kill fallback in case `tsx watch` ignores SIGTERM. tsx watch
  // is generally well-behaved and exits on SIGTERM, but we keep this
  // as defense-in-depth.
  const forceKillTimer = setTimeout(() => {
    if (
      serverChild &&
      serverChild.exitCode === null &&
      serverChild.signalCode === null
    ) {
      console.warn('[kb-start] Server child did not exit on SIGTERM; SIGKILL.')
      killChild(serverChild, 'SIGKILL')
    }
    if (
      viteChild &&
      viteChild.exitCode === null &&
      viteChild.signalCode === null
    ) {
      console.warn('[kb-start] Vite child did not exit on SIGTERM; SIGKILL.')
      killChild(viteChild, 'SIGKILL')
    }
  }, 5000)

  // Wait for both children to exit before relaunching.
  const waitForBoth = () => {
    const serverDead =
      !serverChild ||
      serverChild.exitCode !== null ||
      serverChild.signalCode !== null
    const viteDead =
      !viteChild ||
      viteChild.exitCode !== null ||
      viteChild.signalCode !== null
    if (serverDead && viteDead) {
      clearTimeout(forceKillTimer)
      setTimeout(() => {
        launch().catch((err) => {
          console.error('[kb-start] Restart launch failed:', err)
          shuttingDown = true
          process.exit(1)
        })
      }, 500)
    } else {
      setTimeout(waitForBoth, 100)
    }
  }
  waitForBoth()
}

process.on('SIGUSR2', () => triggerRestart())

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('[kb-start] KovitoBoard Supervisor starting...')
if (projectRoot) {
  console.log(`[kb-start] Project root: ${projectRoot}`)
}

ensureAppSymlink()
launch().catch((err) => {
  console.error('[kb-start] Initial launch failed:', err)
  process.exit(1)
})
