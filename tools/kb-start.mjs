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

import { spawn, execFileSync } from 'child_process'
import { createServer as createNetServer } from 'net'
import { resolve, dirname, sep as pathSep, isAbsolute } from 'path'
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
  realpathSync,
  constants as fsConstants,
} from 'fs'
import {
  decideDetach,
  buildDetachedSpawnArgs,
} from './kb-detach-helpers.mjs'
import { escapeForLog, removalHint } from './kb-path-safety.mjs'

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

/**
 * Returns `true` when `key` is one of Claude Code's nested-instance
 * detection signal vars that must be stripped before launching children
 * that (transitively) spawn `claude`.
 *
 * Canonical definition lives in `src/server/nested-detection-env.ts`
 * (spec SSOT: `session-management.md` §8.9.1). The supervisor is a
 * separate `node` runtime that cannot import that TypeScript module
 * without a build step, so this is a kept-in-sync inline copy.
 */
function isNestedDetectionKey(key) {
  return key === 'CLAUDECODE' || key === 'AI_AGENT' || key.startsWith('CLAUDE_CODE_')
}

/**
 * Launch step b' (supervisor-startup.md v1.4 §5.2 / §6.3.1): return a
 * shallow copy of `env` with every nested-detection key removed before
 * it is injected into the child processes (server / vite). When KB is
 * launched from inside a Claude Code session those children would
 * otherwise inherit the signal vars and pass them on to the `claude`
 * processes the server spawns / launches via tmux. `ANTHROPIC_*` auth
 * vars are preserved (the predicate does not match them).
 */
function scrubNestedDetectionEnv(env) {
  const scrubbed = {}
  for (const key of Object.keys(env)) {
    if (!isNestedDetectionKey(key)) {
      scrubbed[key] = env[key]
    }
  }
  return scrubbed
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

/**
 * Read `project.path` from `<baseDir>/.kovitoboard/setting.json` (the
 * value onboarding persists). Returns an absolute path or null when the
 * file is missing / unreadable / does not contain a usable path.
 *
 * Kept-in-sync inline copy of `readPersistedProjectRoot` in
 * `src/server/config.ts` (the supervisor is a separate `node` runtime
 * that cannot import the TypeScript module without a build step). The
 * base anchor here is `repoRoot` (the KB clone) rather than
 * `process.cwd()`: in the embedded layout a restart runs
 * `cd <project>/kovitoboard && npm start`, so cwd === repoRoot and the
 * two anchors coincide. Spec SSOT: `process-lifecycle.md` v1.5 §3.7
 * stage 3.
 */
function readPersistedProjectRoot(baseDir) {
  const settingPath = resolve(baseDir, '.kovitoboard', 'setting.json')
  if (!existsSync(settingPath)) return null
  let raw
  try {
    raw = readFileSync(settingPath, 'utf-8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw)
    const path = data && data.project && data.project.path
    // `project.path` must be an absolute path. This minimal parser is the
    // literal inline copy of `config.ts:readPersistedProjectRoot` (the
    // "exact-match" supervisor/server contract) and does NOT go through
    // `validateSetting()`, so the absolute-path invariant
    // (`data-persistence.md` §6.1.1) is enforced here. A relative value
    // would be resolved against the launch cwd, retargeting the project
    // root and every derived side effect (PID/log dirs, app symlink, tmux
    // session) at the wrong directory. Reject it fail-loud (return null).
    if (typeof path === 'string' && path.length > 0 && isAbsolute(path)) {
      return resolve(path)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the project root with the same 4-stage priority chain the
 * server uses (`resolveProjectRootWithSource` in `src/server/config.ts`,
 * spec SSOT: `process-lifecycle.md` v1.5 §3.7 / `data-persistence.md`
 * v1.6 §5.3). Aligning the supervisor with the server removes the
 * 3-way resolution drift between supervisor / server / README and
 * honours the README L289 contract ("--project-root may be omitted
 * after onboarding").
 *
 *   1. --project-root CLI argument                 → 'cli-arg'
 *   2. KOVITOBOARD_PROJECT_ROOT env var            → 'env'
 *   3. project.path from <repoRoot>/.kovitoboard/setting.json → 'setting-json'
 *   4. process.cwd() fallback                      → 'cwd-fallback'
 *
 * Unlike the server this never returns null: the cwd-fallback always
 * yields a value. The self-management guard (M-1) below evaluates the
 * resolved path regardless of source.
 */
function resolveProjectRootWithSource() {
  const argRoot = parseStringFlag(process.argv, '--project-root')
  if (argRoot) {
    return { path: resolve(argRoot), source: 'cli-arg' }
  }
  const envRoot = process.env.KOVITOBOARD_PROJECT_ROOT
  if (envRoot && envRoot.trim().length > 0) {
    return { path: resolve(envRoot), source: 'env' }
  }
  const persisted = readPersistedProjectRoot(repoRoot)
  if (persisted) {
    return { path: persisted, source: 'setting-json' }
  }
  // cwd-fallback (spec process-lifecycle.md v1.5 §3.7 stage 4): the
  // embedded model expects --project-root / KOVITOBOARD_PROJECT_ROOT or
  // an onboarded setting.json, so reaching here in production is a
  // misconfiguration. Emit a single WARN (mirroring the server's
  // config.ts cwd-fallback WARN) and continue; the M-1 guard still
  // refuses if the cwd happens to be inside the clone.
  const cwd = process.cwd()
  console.warn(
    `[kb-start] WARN: project root resolved via cwd-fallback (${cwd}). ` +
      `Embedded mode expects an explicit --project-root or ` +
      `KOVITOBOARD_PROJECT_ROOT, or an onboarded ` +
      `.kovitoboard/setting.json. See process-lifecycle.md §3.7.`,
  )
  return { path: cwd, source: 'cwd-fallback' }
}

const { path: projectRoot, source: projectRootSource } =
  resolveProjectRootWithSource()

// ---------------------------------------------------------------------------
// PID file + multi-launch refuse (process-lifecycle.md v1.2 §6 / §10)
//
// The supervisor publishes its pid (and a small metadata blob) at
// `<projectRoot>/.kovitoboard/run/supervisor.pid` so `kb-stop` can
// find it deterministically and so a second `npm start` against the
// same projectRoot bails out instead of silently launching a parallel
// supervisor.
//
// Path anchoring: the 4-stage resolution above always yields a
// projectRoot (the cwd-fallback stage never returns null), and the M-1
// guard refuses any resolution that lands inside the KB clone, so the
// PID file is always anchored under a real target project root. In the
// embedded model (the only supported deployment per
// kovitoboard-master-spec §2.2 / process-lifecycle §1) that root is the
// onboarded project; the cwd-fallback only matters for contributor /
// test usage from outside the clone.
// ---------------------------------------------------------------------------

const PID_FILE_PATH = resolve(
  projectRoot,
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
 * Examine an existing PID file and either bail out (alive supervisor or
 * corrupt PID file), warn + overwrite (stale PID file), or do nothing (no
 * PID file). Spec process-lifecycle §6.4.
 */
function checkExistingSupervisor() {
  const existing = readPidFile()
  if (!existing) return
  if (existing.broken) {
    // Corrupt / unreadable / schema-invalid PID file: fail-loud (ERROR +
    // exit 1) instead of overwriting (process-lifecycle.md v1.8 §6.4,
    // BL-2026-244). A corrupt PID file can hide a still-alive supervisor
    // whose pid we cannot parse, so the multi-launch refuse (§6.4 alive
    // branch) cannot fire — overwriting would open a single-supervisor
    // window where a second supervisor starts against the same
    // projectRoot. We refuse and tell the operator exactly which file to
    // remove. This exits 1, joining the existing refuse series (alive-pid
    // multi-launch §6.4 / tmux pre-flight §6.6.2); no dedicated code is
    // minted because the actionable signal is the message body (the path
    // to delete), not the code.
    //
    // Unlike the stale (dead-pid) branch below, corrupt files are NOT
    // overwritten: stale files record a parseable-but-dead pid (no
    // single-supervisor window), whereas a corrupt file's liveness is
    // unknowable. The atomic temp-file + rename write (`writePidFile`)
    // means a corrupt file only arises from disk corruption / external
    // tampering / an asymmetric crash, so this fail-loud cost is bounded.
    const category =
      existing.broken === 'parse-failed'
        ? 'corrupt (JSON parse failed)'
        : existing.broken === 'read-failed'
          ? 'unreadable (read failed)'
          : 'invalid (schema mismatch)'
    console.error(
      `[kb-start] ERROR: the KovitoBoard supervisor PID file is ${category}.\n` +
        `[kb-start]        Path: ${escapeForLog(PID_FILE_PATH)}\n` +
        `[kb-start]        Refusing to start: a corrupt PID file may hide a still-running\n` +
        `[kb-start]        supervisor, so overwriting it could launch a second supervisor\n` +
        `[kb-start]        against the same project.\n` +
        `[kb-start]        Inspect it, confirm no supervisor is running, then remove it.\n` +
        removalHint(PID_FILE_PATH, '[kb-start]        ') +
        `\n[kb-start]        Then re-run the start command.`,
    )
    process.exit(1)
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
 * Equality-inclusive containment check: returns true when `absPath`
 * equals `scopeRoot` or lives under it. A trailing separator is appended
 * to the root before prefix matching so a sibling like `/foo/barBaz`
 * does not masquerade as being inside `/foo/bar`.
 *
 * Kept-in-sync inline copy of `isWithin` in `src/server/pathResolver.ts`
 * (the supervisor cannot import the TypeScript module). Spec SSOT:
 * `process-lifecycle.md` v1.5 §3.7.2, `data-persistence.md` v1.6 §5.4.
 */
function isWithin(absPath, scopeRoot) {
  const root = scopeRoot.endsWith(pathSep) ? scopeRoot : scopeRoot + pathSep
  return absPath === scopeRoot || absPath.startsWith(root)
}

/**
 * Refuse to start when the *resolved* projectRoot points at the KB clone
 * (`repoRoot`) itself or anything inside it — the M-1 self-management
 * guard (spec `shared-installation-prevention-request.md` v1.3 §M-1 /
 * `process-lifecycle.md` v1.5 §3.7.2).
 *
 * This is a resolved-after evaluation: the check runs once, immediately
 * after the 4-stage resolution, and refuses regardless of the source
 * (cli-arg / env / setting-json / cwd-fallback). A setting.json that
 * records the clone
 * itself (the embedded-onboarding pollution case) is therefore rejected
 * fail-loud rather than silently auto-corrected.
 *
 * Both paths are fully canonicalized with `fs.realpathSync` before the
 * containment check so a symlink alias or non-canonical path that points
 * at the clone physically (but reads as outside lexically) is still
 * caught. Canonicalization failure is treated as fail-loud: we refuse
 * rather than start with an unverifiable path.
 */
function refuseKbCloneSelfManagement(resolvedProjectRoot, source) {
  let canonicalResolved
  let canonicalRepoRoot
  try {
    canonicalResolved = realpathSync(resolvedProjectRoot)
    canonicalRepoRoot = realpathSync(repoRoot)
  } catch (err) {
    console.error(
      `[kb-start] ERROR: cannot verify the project root path.\n` +
        `[kb-start]        Resolved projectRoot: ${resolvedProjectRoot} (source: ${source})\n` +
        `[kb-start]        Canonicalization failed: ${err && err.message}\n` +
        `[kb-start]        The path must exist and be resolvable. ` +
        `Specify a valid --project-root or KOVITOBOARD_PROJECT_ROOT.`,
    )
    process.exit(1)
  }

  if (!isWithin(canonicalResolved, canonicalRepoRoot)) return

  console.error(
    `[kb-start] ERROR: KovitoBoard cannot manage itself as a project.\n` +
      `[kb-start]        Resolved projectRoot points inside the KB clone:\n` +
      `[kb-start]          ${canonicalResolved}\n` +
      `[kb-start]        (clone: ${canonicalRepoRoot}, source: ${source})\n` +
      `[kb-start]        Specify the target project explicitly:\n` +
      `[kb-start]          npm start -- --project-root <path-to-project>\n` +
      `[kb-start]        Or set KOVITOBOARD_PROJECT_ROOT=<path>.\n` +
      `[kb-start]        If a stale .kovitoboard/setting.json records the clone, ` +
      `re-run onboarding after restarting with the correct --project-root.\n` +
      `[kb-start]        See README.md "Starting the server" for the embedded deployment model.`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// kb-start pre-flight: KB-scoped resource conflict detection
// (process-lifecycle.md §6.6, BL-2026-237)
//
// Runs after the PID-file multi-launch refuse (§6.4) and the M-1
// resolved-after evaluation (§3.7.2), before any child is spawned. Only
// KB-scoped conflicts are refused; external / other-project resources
// keep the existing auto-probe behaviour so concurrent KB instances are
// not broken. All judgements anchor on the PID file / projectRoot-derived
// tmux session name / KB-assigned default ports — never a host-wide
// pgrep or port scan (§3.4 safety boundary).
// ---------------------------------------------------------------------------

/**
 * Resolve the tmux session name the same way the server does
 * (`tmux-bridge.ts:resolveTmuxSessionName` / its `sessionName` getter,
 * process-lifecycle.md §8.1 / §8.2 SSOT).
 *
 * `KOVITOBOARD_E2E_TMUX_SESSION` is only honoured when `KB_E2E_MODE === '1'`
 * is set at the same time. A leftover env var without the gate (e.g. a
 * shared shell) is ignored with a WARN and the projectRoot-derived name is
 * used, matching the server gate so the name is never resolved two ways.
 */
function resolveTmuxSessionName() {
  const rawE2eSession = process.env.KOVITOBOARD_E2E_TMUX_SESSION
  const e2eModeEnabled = process.env.KB_E2E_MODE === '1'
  if (rawE2eSession && !e2eModeEnabled) {
    console.warn(
      `[kb-start] WARN: ignoring KOVITOBOARD_E2E_TMUX_SESSION because ` +
        `KB_E2E_MODE is not set; using the project-derived session name.`,
    )
  }
  const e2eSession = e2eModeEnabled ? rawE2eSession : undefined
  if (e2eSession) return e2eSession
  const base = projectRoot.split('/').pop() ?? 'unknown'
  return `kovitoboard-${base}`.replace(/[.:]/g, '-')
}

/**
 * Pre-flight: refuse to start if a KB tmux session for this project
 * already exists (process-lifecycle.md §6.6.2). Complements the PID-file
 * multi-launch refuse (§6.4) with an OR relationship — it catches the
 * case where the PID file is gone / stale but a leftover tmux session
 * still lingers after an abnormal exit.
 *
 * Exact-match `tmux has-session` only (no prefix match, no
 * `tmux ls | grep` host-wide enumeration). The base name is
 * `kovitoboard-<basename(projectRoot)>`, so a different projectRoot with
 * the same basename collides; refusing is the fail-safe side (better than
 * silently double-launching).
 *
 * `tmux has-session` exits 0 when the session exists and 1 when it does
 * not; tmux being absent (ENOENT) means there is no session to conflict
 * with. Both are spec "no conflict, continue" cases (§6.6.2). Any OTHER
 * failure (tmux present but a socket / permission error) means the
 * pre-flight could not actually verify exclusivity — we stay fail-open
 * (best-effort, §6.6 complements the PID-file refuse) but WARN loudly so
 * the operator knows the check did not run.
 */
function checkTmuxSessionConflict(sessionName) {
  try {
    // `=` forces an EXACT target-name match. Plain `-t <name>` accepts a
    // unique prefix, so without `=` an existing `kovitoboard-foo-extra`
    // would make us falsely refuse `kovitoboard-foo` (tmux target
    // resolution, see tmux(1) "exact match" / `=` prefix).
    execFileSync('tmux', ['has-session', '-t', `=${sessionName}`], {
      stdio: 'ignore',
    })
  } catch (err) {
    const code = err && err.code
    const status = err && typeof err.status === 'number' ? err.status : null
    if (code === 'ENOENT') return // tmux not installed → no session, continue
    if (status === 1) return // session does not exist → continue
    // tmux present but the invocation failed for another reason (e.g. a
    // dead server socket or permission error). Continue (fail-open) but
    // make the un-verified pre-flight visible.
    console.warn(
      `[kb-start] WARN: tmux pre-flight could not verify session ` +
        `"${sessionName}" (${(err && err.message) || code || 'unknown error'}); ` +
        `continuing without the tmux conflict check.`,
    )
    return
  }
  // exit 0 → the session exists → refuse.
  console.error(
    `[kb-start] ERROR: a KB tmux session for this project already exists ` +
      `(session=${sessionName}).\n` +
      `[kb-start]        Another KB may be running, or a previous run left ` +
      `it behind.\n` +
      `[kb-start]        Stop it with \`cd ${repoRoot} && npm run kb:stop\`, ` +
      `or inspect it with \`tmux attach -t ${sessionName}\`.`,
  )
  process.exit(1)
}

/**
 * Best-effort: describe the process currently holding `port` as
 * `pid=<N> (<cmd>)` for a WARN message (process-lifecycle.md §6.6.3 /
 * §11.5). Tries `lsof` first, then `ss`. Returns null when neither is
 * available or permission is insufficient — the caller then reports the
 * port number only. Never sends a signal to the owner.
 */
function describePortOwner(port) {
  // lsof: `-t` would give only the pid; we want pid + command, so parse
  // the default output. `-nP` avoids slow DNS / port-name lookups.
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    // -F output: lines like `p<pid>` and `c<command>`.
    let pid = null
    let cmd = null
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1).trim()
      else if (line.startsWith('c')) cmd = line.slice(1).trim()
    }
    if (pid) return `pid=${pid}${cmd ? ` (${cmd})` : ''}`
  } catch {
    // fall through to ss
  }
  try {
    const out = execFileSync('ss', ['-ltnp', `( sport = :${port} )`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // ss -p appends `users:(("<cmd>",pid=<N>,fd=<M>))`.
    const m = out.match(/users:\(\("([^"]+)",pid=(\d+)/)
    if (m) return `pid=${m[2]} (${m[1]})`
  } catch {
    // neither tool available / permitted
  }
  return null
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

// M-1 (resolved-after evaluation) runs immediately after the 4-stage
// projectRoot resolution and BEFORE the detach branch, so a stray
// `cd <kb-clone> && npm start -- --detach` (or a setting.json that
// records the clone itself) does not silently background a
// self-managing supervisor; the refuse covers both foreground and
// detached invocations.
refuseKbCloneSelfManagement(projectRoot, projectRootSource)

// Multi-launch detection runs in the parent here so a misfire (an
// already-running supervisor) is reported in the operator's terminal
// instead of buried in `kb-detach-stderr.log`. The detached child
// re-runs the same check from `launch()` to catch anything that
// changed during the spawn window.
checkExistingSupervisor()

// kb-start pre-flight: KB-scoped tmux session conflict (§6.6.2). Runs in
// the parent (like checkExistingSupervisor) so a refusal lands in the
// operator's terminal rather than the detached stderr log, and covers
// both foreground and detached invocations. The resolved name is reused
// for the PID-file `tmux.sessionName` so the pre-flight and the recorded
// name never diverge (single resolution via resolveTmuxSessionName).
const tmuxSessionName = resolveTmuxSessionName()
checkTmuxSessionConflict(tmuxSessionName)

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
  const logDir = resolve(projectRoot, '.kovitoboard', 'logs')
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
        // §6.6.3: the default port is held by an external / other-project
        // process. We do NOT refuse (auto-probe keeps concurrent KB
        // instances working) and we NEVER signal the owner, but we
        // surface the fallback with the occupier identity so the operator
        // knows we started on an unexpected port (replaces the old silent
        // 5174-style fallback). Owner lookup is best-effort (§11.5).
        const owner = describePortOwner(defaultStart)
        console.warn(
          `[kb-start] WARN: default ${label} port ${defaultStart} is in use` +
            `${owner ? ` by ${owner}` : ''}; falling back to ${candidate}. ` +
            `(Run \`npm run kb:stop\` if this is a stale KB instance.)`,
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
  // projectRoot is always resolved (the 4-stage chain never returns
  // null and the M-1 guard has already rejected any path inside the
  // clone), so there is no "projectRoot unspecified" branch here.
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
    ...scrubNestedDetectionEnv(process.env),
    NODE_ENV: 'development',
    KOVITOBOARD_PROJECT_ROOT: projectRoot,
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
  // Reuse the session name resolved by the pre-flight above
  // (resolveTmuxSessionName, §8.2-gated) so the recorded name matches the
  // name the pre-flight checked and the server derives.
  writePidFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot,
    // 4-value ProjectRootSource enum, kept in sync with server
    // `ProjectRootSource` in src/server/config.ts (enum SSOT) and spec
    // process-lifecycle.md v1.5 §6.2: cli-arg / env / setting-json /
    // cwd-fallback.
    projectRootSource,
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
  console.log(`[kb-start]   Project:  ${projectRoot} (source: ${projectRootSource})`)
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
console.log(`[kb-start] Project root: ${projectRoot} (source: ${projectRootSource})`)

ensureAppSymlink()
launch().catch((err) => {
  console.error('[kb-start] Initial launch failed:', err)
  process.exit(1)
})
