/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * preflight — startup preflight checks (PF-1 / PF-2 / PF-3).
 *
 * Runs at server startup sequence step 7 (supervisor-startup.md
 * v1.2 §5.3 / §6.9 SSOT) to fail-fast when one of the three runtime
 * prerequisites is missing:
 *
 *   PF-1: tmux 3.4+ on PATH
 *   PF-2: Node.js 20.x or newer
 *   PF-3: `claude` CLI on PATH
 *
 * Module is split into two parts:
 *   - `runPreflightChecks(deps?)` is pure and returns the aggregated
 *     result. Tests inject deps to simulate spawn / version values.
 *   - `enforcePreflight(result, env?)` performs the side-effects
 *     (bootstrap logging + `process.exit(1)`) that the live startup
 *     sequence needs. Tests verify these via spy/mocks.
 *
 * The escape hatch `KOVITOBOARD_SKIP_PREFLIGHT=1` short-circuits
 * `enforcePreflight` to a warn-only path so CI / E2E test harnesses
 * can run without the production prerequisites available. The
 * variable is documented for ops/test use only and is not advertised
 * to end-users (see supervisor-startup.md §6.9.4).
 *
 * Bootstrap logging uses `console.error` / `console.warn` because the
 * pino pipeline has not been initialised yet (initLogger runs at
 * step 8). Each call carries the `// hygiene-allow: console-bootstrap`
 * tag required by tools/check-release-hygiene.mjs (§9.9 SSOT).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { writeSync } from 'node:fs'

// stderr file descriptor.
const STDERR_FD = 2

/**
 * Synchronous stderr write that bypasses libuv buffering. Used for
 * the FAIL/HINT lines in `enforcePreflight` so the diagnostics
 * survive the immediately-following `process.exit(1)` even when
 * stderr is attached to a pipe (supervisor, CI, systemd). The
 * fall-back to `console.error` only fires if `writeSync` itself
 * throws — a degenerate case where the operator already has bigger
 * problems than buffered output.
 *
 * Exported only so unit tests can swap in a captured-output sink via
 * `setBootstrapStderrForTesting`. Production callers should not
 * import it directly.
 */
let bootstrapStderrImpl: (line: string) => void = (line) => {
  try {
    writeSync(STDERR_FD, `${line}\n`)
  } catch {
    // prettier-ignore
    console.error(line) // hygiene-allow: console-bootstrap
  }
}

function bootstrapStderr(line: string): void {
  bootstrapStderrImpl(line)
}

/**
 * Test-only: replace the synchronous stderr writer with a spy.
 * Pass `null` to restore the real writeSync-backed implementation.
 */
export function setBootstrapStderrForTesting(
  override: ((line: string) => void) | null,
): void {
  bootstrapStderrImpl = override ?? defaultBootstrapStderr
}

const defaultBootstrapStderr = bootstrapStderrImpl

export type PreflightCheckId = 'PF-1' | 'PF-2' | 'PF-3'

export interface PreflightFailure {
  id: PreflightCheckId
  message: string
  hint: string
}

export type PreflightResult =
  | { ok: true; failures: []; skippedReason?: string }
  | { ok: false; failures: PreflightFailure[] }

/**
 * Dependencies injected for tests. The defaults wire up the real
 * runtime values (`process.version`, real `spawnSync`).
 *
 * `spawn` returns the raw spawnSync result so tests can simulate
 * spawn errors (`error` set), non-zero exits (`status !== 0`), and
 * malformed stdout in one place.
 *
 * Note: `enforcePreflight` takes its own `env` argument so it can
 * read `KOVITOBOARD_SKIP_PREFLIGHT`. The check phase has no env
 * dependencies of its own.
 */
export interface PreflightDeps {
  spawn: (command: string, args: string[]) => SpawnSyncReturns<string>
  nodeVersion: string
}

const HINTS: Record<PreflightCheckId, string> = {
  'PF-1':
    'Install / upgrade tmux 3.4+. macOS: brew install tmux. Ubuntu/Debian: apt install tmux=3.4-1build1.',
  'PF-2': 'Upgrade to Node.js 20+. Use nvm: nvm install 20 && nvm use 20.',
  'PF-3':
    'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup. Then restart KB.',
}

// Subprocess timeout for `tmux -V` and `claude --version`. Both are
// expected to return within tens of milliseconds; the cap prevents
// startup from hanging if the binary is wedged.
const SPAWN_TIMEOUT_MS = 5000

// Env var that tells the check phase to short-circuit before any
// subprocess is spawned. Documented in supervisor-startup.md
// §6.9.4 for CI / E2E / debug use; production startup never sets
// it. Keeping the gate inside `runPreflightChecks` (rather than at
// the index.ts call site) keeps the contract — "set the env var,
// no preflight subprocess runs" — discoverable from this module.
const SKIP_ENV_VAR = 'KOVITOBOARD_SKIP_PREFLIGHT'

function defaultSpawn(
  command: string,
  args: string[],
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const defaultDeps: PreflightDeps = {
  spawn: defaultSpawn,
  nodeVersion: process.version,
}

function fail(
  id: PreflightCheckId,
  message: string,
): PreflightFailure {
  return { id, message, hint: HINTS[id] }
}

function classifySpawnFailure(
  id: PreflightCheckId,
  command: string,
  args: string[],
  result: SpawnSyncReturns<string>,
): PreflightFailure | null {
  // Distinguish ENOENT (binary missing) from signal / non-zero exit
  // so operators get an accurate hint instead of a generic
  // "not found" message that would mis-direct triage.
  const display = `${command} ${args.join(' ')}`
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return fail(id, `${command} not found on PATH`)
    }
    return fail(id, `${display} launch failed: ${result.error.message}`)
  }
  if (result.signal) {
    return fail(id, `${display} terminated by signal ${result.signal}`)
  }
  if (result.status !== 0) {
    // Bootstrap output runs before the redaction-aware logger pipeline
    // (see enforcePreflight). Subprocess stderr can carry local paths,
    // account identifiers, or wrapper-script diagnostics, so we only
    // surface command + exit status and let operators inspect the
    // binary directly when more detail is needed.
    return fail(id, `${display} exited ${result.status}`)
  }
  return null
}

function checkTmux(deps: PreflightDeps): PreflightFailure | null {
  const result = deps.spawn('tmux', ['-V'])
  const failure = classifySpawnFailure('PF-1', 'tmux', ['-V'], result)
  if (failure) return failure
  const stdout = (result.stdout ?? '').toString().trim()
  const match = /^tmux ([0-9]+)\.([0-9]+)/.exec(stdout)
  if (!match) {
    return fail('PF-1', `tmux version unparseable: ${stdout}`)
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 3 || (major === 3 && minor < 4)) {
    return fail('PF-1', `tmux 3.4+ required (detected: ${major}.${minor})`)
  }
  return null
}

function checkNode(deps: PreflightDeps): PreflightFailure | null {
  const match = /^v(\d+)\./.exec(deps.nodeVersion)
  if (!match) {
    return fail('PF-2', `Node version unparseable: ${deps.nodeVersion}`)
  }
  const major = Number(match[1])
  if (major < 20) {
    return fail('PF-2', `Node.js 20+ required (detected: ${deps.nodeVersion})`)
  }
  return null
}

function checkClaude(deps: PreflightDeps): PreflightFailure | null {
  const result = deps.spawn('claude', ['--version'])
  const failure = classifySpawnFailure('PF-3', 'claude', ['--version'], result)
  if (failure) return failure
  // Per spec §6.9.5: the version string itself is not validated here
  // (that is the job of version-management.md). Reaching exit 0 is
  // sufficient evidence that the binary exists and responds.
  return null
}

/**
 * Run all preflight checks. Pure function — does not log or exit.
 * Callers compose the result with `enforcePreflight` (or perform
 * their own handling) to produce the side-effects.
 *
 * Asymmetric handling of the skip env hatch:
 *   - PF-2 (Node 20+) is always evaluated. The rest of the server
 *     uses Node-20-only APIs, so a stale or leaked
 *     `KOVITOBOARD_SKIP_PREFLIGHT=1` env var must not let an
 *     unsupported runtime through. This mirrors the hard
 *     enforcement in playwright.config.l1.ts.
 *   - PF-1 (tmux) and PF-3 (`claude`) are skippable. They are
 *     external host dependencies that some CI / E2E / debug paths
 *     legitimately lack; the spawn timeout there is pure friction.
 *
 * When `KOVITOBOARD_SKIP_PREFLIGHT=1` is set and PF-2 passes,
 * returns immediately with
 * `{ ok: true, failures: [], skippedReason }` and no subprocess
 * is spawned for PF-1 / PF-3.
 */
export function runPreflightChecks(
  deps: PreflightDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  const failures: PreflightFailure[] = []
  // Always evaluate the Node floor so the env hatch cannot bypass it.
  const f2 = checkNode(deps)
  if (f2) failures.push(f2)

  if (env[SKIP_ENV_VAR] === '1') {
    if (failures.length > 0) {
      // PF-2 failed. The env hatch cannot rescue the runtime; surface
      // the failure so enforcePreflight exits with the standard hint.
      return { ok: false, failures }
    }
    return {
      ok: true,
      failures: [],
      skippedReason: `${SKIP_ENV_VAR}=1`,
    }
  }
  const f1 = checkTmux(deps)
  if (f1) failures.push(f1)
  const f3 = checkClaude(deps)
  if (f3) failures.push(f3)
  if (failures.length === 0) {
    return { ok: true, failures: [] }
  }
  // Sort failures back into the natural PF-1, PF-2, PF-3 order so
  // tests and operators see a consistent layout regardless of the
  // unconditional-first ordering above.
  failures.sort((a, b) => a.id.localeCompare(b.id))
  return { ok: false, failures }
}

/**
 * ASCII rule used as the top, middle, and bottom of the FAIL banner.
 * Plain `=` is intentional: the banner is the last thing the user
 * sees before the supervisor tears down, and we want the box to
 * render unambiguously over SSH / piped stderr / log forwarders that
 * may not pass U+2550 (`═`) cleanly. Width 60 fits comfortably inside
 * an 80-column terminal alongside the leading shell prompt.
 */
const FAIL_BANNER_RULE = '='.repeat(60)

/**
 * Emit the failure banner. The FAIL / HINT lines stay flush-left so
 * they keep their machine-readable shape:
 * `/^\[kb-preflight\] (FAIL PF-\d+|HINT):/` — operators and CI shell
 * scripts already grep for this prefix per logging-baseline.md v1.3
 * §9.9 + supervisor-startup.md v1.3 §6.9.3-6. The rules and header
 * line wrap the block so the diagnostic is visually unmissable next
 * to the rest of the boot output without breaking that contract.
 */
function emitFailBanner(failures: PreflightFailure[]): void {
  bootstrapStderr(FAIL_BANNER_RULE)
  bootstrapStderr('[!] KovitoBoard Preflight Check FAILED [!]')
  bootstrapStderr(FAIL_BANNER_RULE)
  for (const failure of failures) {
    bootstrapStderr(`[kb-preflight] FAIL ${failure.id}: ${failure.message}`)
    bootstrapStderr(`[kb-preflight] HINT: ${failure.hint}`)
  }
  bootstrapStderr(FAIL_BANNER_RULE)
}

/**
 * Enforce the preflight result. On success, returns immediately;
 * if the result was skipped via the env escape hatch, emits a
 * single warn line so operators can still see the bypass in
 * bootstrap output. On failure, logs each failure + hint inside a
 * visually-bracketed banner and calls `process.exit(1)`.
 *
 * The supervisor (kb-start.mjs) detects the non-zero child exit and
 * tears down (supervisor-startup.md §6.9.3 step 3).
 */
export function enforcePreflight(result: PreflightResult): void {
  if (result.ok) {
    if (result.skippedReason) {
      bootstrapStderr(
        `[kb-preflight] WARN: ${result.skippedReason}, skipping startup preflight checks`,
      )
    }
    return
  }
  emitFailBanner(result.failures)
  process.exit(1)
}
