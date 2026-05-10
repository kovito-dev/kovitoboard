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
  // Test runner (the bare boolean toggles; --test-shard / --test-name-pattern
  // / --test-reporter etc. take values and live in NODE_VALUE_FLAGS).
  '--test',
  '--test-only',
  // Watch (the bare toggle; --watch-path takes a value)
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
        if (debug) {
          console.error(
            `[kb-stop] DEBUG: skipping pid ${pid}: relative entry script ${scriptArg} ` +
              `and supervisor cwd is not available via /proc; refusing to resolve ` +
              `against kb-stop's cwd to avoid cross-clone collateral kill`,
          )
        }
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
