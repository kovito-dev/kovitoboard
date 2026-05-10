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

export type PreflightCheckId = 'PF-1' | 'PF-2' | 'PF-3'

export interface PreflightFailure {
  id: PreflightCheckId
  message: string
  hint: string
}

export type PreflightResult =
  | { ok: true; failures: [] }
  | { ok: false; failures: PreflightFailure[] }

/**
 * Dependencies injected for tests. The defaults wire up the real
 * runtime values (`process.version`, `process.env`, real `spawnSync`).
 *
 * `spawn` returns the raw spawnSync result so tests can simulate
 * spawn errors (`error` set), non-zero exits (`status !== 0`), and
 * malformed stdout in one place.
 */
export interface PreflightDeps {
  spawn: (command: string, args: string[]) => SpawnSyncReturns<string>
  nodeVersion: string
  env: NodeJS.ProcessEnv
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
  env: process.env,
}

function fail(
  id: PreflightCheckId,
  message: string,
): PreflightFailure {
  return { id, message, hint: HINTS[id] }
}

function checkTmux(deps: PreflightDeps): PreflightFailure | null {
  const result = deps.spawn('tmux', ['-V'])
  if (result.error || result.status !== 0) {
    return fail('PF-1', 'tmux not found')
  }
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
  if (result.error || result.status !== 0) {
    return fail('PF-3', 'claude CLI not found or unresponsive')
  }
  // Per spec §6.9.5: the version string itself is not validated here
  // (that is the job of version-management.md). Reaching exit 0 is
  // sufficient evidence that the binary exists and responds.
  return null
}

/**
 * Run all preflight checks. Pure function — does not log or exit.
 * Callers compose the result with `enforcePreflight` (or perform
 * their own handling) to produce the side-effects.
 */
export function runPreflightChecks(
  deps: PreflightDeps = defaultDeps,
): PreflightResult {
  const failures: PreflightFailure[] = []
  const f1 = checkTmux(deps)
  if (f1) failures.push(f1)
  const f2 = checkNode(deps)
  if (f2) failures.push(f2)
  const f3 = checkClaude(deps)
  if (f3) failures.push(f3)
  if (failures.length === 0) {
    return { ok: true, failures: [] }
  }
  return { ok: false, failures }
}

/**
 * Enforce the preflight result. On success, returns immediately.
 * On failure:
 *   - If `KOVITOBOARD_SKIP_PREFLIGHT=1`, log warnings and return.
 *   - Otherwise, log each failure + hint and call `process.exit(1)`.
 *
 * The supervisor (kb-start.mjs) detects the non-zero child exit and
 * tears down (supervisor-startup.md §6.9.3 step 3).
 */
export function enforcePreflight(
  result: PreflightResult,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (result.ok) return
  const skip = env.KOVITOBOARD_SKIP_PREFLIGHT === '1'
  if (skip) {
    for (const failure of result.failures) {
      // prettier-ignore
      console.warn(`[kb-preflight] WARN: KOVITOBOARD_SKIP_PREFLIGHT=1, skipping (${failure.id}: ${failure.message})`) // hygiene-allow: console-bootstrap
    }
    return
  }
  for (const failure of result.failures) {
    // prettier-ignore
    console.error(`[kb-preflight] FAIL ${failure.id}: ${failure.message}`) // hygiene-allow: console-bootstrap
    // prettier-ignore
    console.error(`[kb-preflight] HINT: ${failure.hint}`) // hygiene-allow: console-bootstrap
  }
  process.exit(1)
}
