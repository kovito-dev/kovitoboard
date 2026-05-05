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
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  existsSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  mkdirSync,
} from 'fs'

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
  -h, --help              Print this help.

Examples:
  node tools/kb-start.mjs                                # auto-probe both
  node tools/kb-start.mjs --port=8080                    # backend fixed
  node tools/kb-start.mjs --port=8080 --vite-port=8000   # both fixed
  PORT=8080 node tools/kb-start.mjs                      # env fallback
`)
  process.exit(0)
}

const projectRoot =
  (parseStringFlag(process.argv, '--project-root')
    ? resolve(parseStringFlag(process.argv, '--project-root'))
    : null) ||
  process.env.KOVITOBOARD_PROJECT_ROOT ||
  null

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

  // Surface the resolved URLs prominently so a user who specified no
  // ports (and thus may have landed on something other than 5173)
  // knows exactly where to point their browser. Shown after spawn
  // because that is the moment we have committed to these ports.
  console.log('')
  console.log('[kb-start] KovitoBoard ready')
  console.log(`[kb-start]   Backend:  http://localhost:${backendPort}`)
  console.log(
    `[kb-start]   Frontend: http://localhost:${vitePort}  ← open this in your browser`,
  )
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
