/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Helpers for the supervisor's detached startup path.
 *
 * Split out from `kb-start.mjs` so the decision logic (which has no
 * side effects and no `child_process` usage) can be unit tested without
 * importing the full supervisor module — `kb-start.mjs` runs its main
 * launch sequence on import.
 *
 * Public API:
 *
 * - `decideDetach(args, env)` — pure decision: should this invocation
 *   re-exec itself in the background?
 * - `buildDetachedSpawnArgs(argv, env)` — pure shape: given the parent's
 *   `process.argv` and `process.env`, produce the `(childArgs, childEnv)`
 *   pair to feed `spawn()`.
 *
 * The supervisor caller does the actual `spawn()` + `unref()` + parent
 * exit; those side-effectful pieces are not encapsulated here.
 */

const DETACH_FLAG = '--detach'
const ENV_REQUEST = 'KOVITOBOARD_DETACH'
const ENV_ALREADY_DETACHED = 'KOVITOBOARD_DETACHED'

/**
 * Decide whether the current process should re-exec itself in the
 * background and exit.
 *
 * Inputs:
 *
 * @param {readonly string[]} args - argv after the node + script entries
 *   (typically `process.argv.slice(2)`).
 * @param {Readonly<Record<string, string | undefined>>} env - the
 *   environment to consult (typically `process.env`).
 *
 * Returns `true` when:
 *
 * - the user passed `--detach`, OR
 * - the user set `KOVITOBOARD_DETACH=1`,
 *
 * AND the special internal marker `KOVITOBOARD_DETACHED=1` is not
 * already set (which means we are the re-exec'd child and should run
 * the normal foreground path).
 *
 * The marker breaks the recursion that would otherwise happen when the
 * parent's full env (including `KOVITOBOARD_DETACH=1`) is inherited by
 * the child. See `buildDetachedSpawnArgs()` for how the child env is
 * shaped.
 */
export function decideDetach(args, env) {
  if (env[ENV_ALREADY_DETACHED] === '1') return false
  const flagged = args.includes(DETACH_FLAG)
  const envRequested = env[ENV_REQUEST] === '1'
  return flagged || envRequested
}

/**
 * Build the `(childArgs, childEnv)` pair for a detached re-exec.
 *
 * - `childArgs` is `argv.slice(1)` with all `--detach` occurrences
 *   stripped, so the child does not loop on the same flag.
 * - `childEnv` clones the parent env, removes `KOVITOBOARD_DETACH` (so
 *   the env-var path also does not loop), and sets
 *   `KOVITOBOARD_DETACHED=1` so the child takes the foreground branch
 *   in `decideDetach()`.
 *
 * @param {readonly string[]} argv - the parent's full argv array
 *   (typically `process.argv`). Index 0 is the node binary, index 1 is
 *   the script path, indices 2+ are user args.
 * @param {Readonly<Record<string, string | undefined>>} env - the
 *   parent environment (typically `process.env`).
 *
 * @returns {{ childArgs: string[], childEnv: Record<string, string> }}
 */
export function buildDetachedSpawnArgs(argv, env) {
  const childArgs = argv.slice(1).filter((a) => a !== DETACH_FLAG)
  /** @type {Record<string, string>} */
  const childEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === ENV_REQUEST) continue
    if (value === undefined) continue
    childEnv[key] = value
  }
  childEnv[ENV_ALREADY_DETACHED] = '1'
  return { childArgs, childEnv }
}
