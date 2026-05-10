/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Phase 2-A regression tests for `tools/kb-stop.mjs` `--all` mode.
 *
 * Spec SSOT: `process-lifecycle.md` v1.3 §3.6 / §7.4 (in the
 * kovitoboard-dev workspace). The `--all` host-wide sweep used to
 * call `pgrep -f tools/kb-start.mjs` and signal every match, which
 * leaked SIGTERM to unrelated developer processes whose command
 * lines happened to contain that substring (editors, shells reading
 * the script, greps). Phase 2-A switches the discovery to an
 * absolute-path match against `argv[0]` (must be a node binary) and
 * `argv[1]` (must `realpath` to this clone's `tools/kb-start.mjs`).
 *
 * Strategy: spawn long-running decoy subprocesses whose cmdlines
 * contain `tools/kb-start.mjs` as a substring (so legacy `pgrep -f`
 * would have caught them), but whose argv layout disqualifies them
 * under the new absolute-path match. We assert that no kill action
 * is planned for those PIDs in `--dry-run` output.
 *
 * Bash's exec optimization replaces the shell process with the final
 * single command in a `bash -c "cmd"` script, which would erase the
 * decoy substring from argv. We avoid that by using a comment
 * followed by a multi-statement loop, which forces bash to stay the
 * top-level process with the original `-c` argument intact in argv.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_STOP = resolve(REPO_ROOT, 'tools', 'kb-stop.mjs')

let workDir: string
const decoys: ChildProcess[] = []

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-stop-all-mode-test-'))
})

afterEach(() => {
  for (const child of decoys) {
    if (!child.killed && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
  }
  decoys.length = 0
  rmSync(workDir, { recursive: true, force: true })
})

function runKbStop(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [KB_STOP, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      KOVITOBOARD_PROJECT_ROOT: workDir,
      // The test runner may itself be inside a tmux session; clear
      // the variable so the self-suicide guard does not engage on
      // unrelated session names.
      TMUX: '',
      ...extraEnv,
    },
  })
}

/** Wait briefly for a spawned child to surface in the proc table. */
async function settle(ms = 300) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Spawn a long-running bash whose `-c` script contains
 * `tools/kb-start.mjs` as a substring (so `pgrep -f tools/kb-start.mjs`
 * matches it) but whose argv[0] is `bash`, not `node`. Bash will not
 * exec-optimize away because the script body is a multi-statement
 * loop with a leading comment.
 */
function spawnBashDecoy(): ChildProcess {
  const script = '# decoy tools/kb-start.mjs\nwhile true; do sleep 1; done'
  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  decoys.push(child)
  return child
}

/**
 * Spawn a long-running node process whose argv[1] is a script in a
 * fake "other clone" location — argv[0] is `node` (the real check
 * point that legacy substring match would still pass), but the
 * absolute-path of argv[1] does NOT match this clone's
 * `tools/kb-start.mjs`. The script keeps the process alive with a
 * setInterval so vitest's afterEach can clean it up.
 *
 * `relativeArgv1` controls whether argv[1] is passed as the absolute
 * path (default; matches the typical `node /abs/path/script.mjs`
 * invocation) or as the bare relative `tools/kb-start.mjs` with the
 * child's cwd set to the fake clone (matches the embedded-layout
 * default `node tools/kb-start.mjs --project-root ..`). The relative
 * variant exercises the /proc-cwd resolution path the matcher uses
 * to scope the sweep to THIS clone only.
 */
function spawnNodeOtherCloneDecoy(opts: { relativeArgv1?: boolean } = {}): {
  child: ChildProcess
  cloneDir: string
} {
  // Build `<cloneDir>/tools/kb-start.mjs` so the absolute-path match
  // against our clone's `tools/kb-start.mjs` resolves to a different
  // file. Real on-disk file is needed because the matcher realpaths
  // argv[1] before comparing.
  const cloneDir = mkdtempSync(join(tmpdir(), 'kb-stop-decoy-clone-'))
  const decoyTools = join(cloneDir, 'tools')
  mkdirSync(decoyTools, { recursive: true })
  const decoyScript = join(decoyTools, 'kb-start.mjs')
  writeFileSync(
    decoyScript,
    "// decoy clone, never actually starts a supervisor\nsetInterval(() => {}, 1000)\n",
  )
  const useRelative = opts.relativeArgv1 === true
  const child = spawn('node', [useRelative ? 'tools/kb-start.mjs' : decoyScript], {
    detached: true,
    stdio: 'ignore',
    cwd: useRelative ? cloneDir : process.cwd(),
  })
  decoys.push(child)
  return { child, cloneDir }
}

// We intentionally do not assert "Nothing to do" in the cases
// below. vitest runs files in parallel, and an unrelated test in
// another file may legitimately spawn a real `tools/kb-start.mjs`
// inside this clone, which the absolute-path match correctly
// retains as a kill target. The contract this suite pins is "the
// listed decoy must not appear in the planned actions"; whether
// the planner finds zero or non-zero other supervisors is up to
// the rest of the suite at any given moment.
describe('tools/kb-stop.mjs --all — absolute-path match (Phase 2-A)', () => {
  it('skips bash decoys whose script body contains tools/kb-start.mjs', async () => {
    const decoy = spawnBashDecoy()
    expect(decoy.pid).toBeGreaterThan(0)
    await settle()

    const r = runKbStop(['--all', '--dry-run'])
    expect(r.status).toBe(0)
    // Legacy substring match would have planned `SIGTERM →
    // supervisor pid <decoy.pid>`. The new argv[0] check (basename
    // !== 'node') must filter it out.
    expect(r.stdout).not.toContain(`pid ${decoy.pid}`)
  })

  it('skips node decoys whose argv[1] points at a different clone', async () => {
    const { child, cloneDir } = spawnNodeOtherCloneDecoy()
    try {
      expect(child.pid).toBeGreaterThan(0)
      await settle()

      const r = runKbStop(['--all', '--dry-run'])
      expect(r.status).toBe(0)
      // argv[0] passes the basename check (it IS node), but argv[1]
      // resolves to <other-clone>/tools/kb-start.mjs, not our
      // clone's path. The absolute-path match must reject it.
      expect(r.stdout).not.toContain(`pid ${child.pid}`)
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('skips node decoys with a relative argv[1] launched from a different clone (cross-clone fence)', async () => {
    // This case exercises the /proc-cwd resolution path: argv[1] is
    // the bare string `tools/kb-start.mjs`, which the matcher must
    // resolve against /proc/<pid>/cwd (the supervisor's cwd, here
    // the fake clone tempdir) rather than kb-stop's own cwd. If the
    // fence falls back to kb-stop's cwd, this decoy would alias
    // onto THIS clone's expected script path and SIGTERM would
    // leak across clones.
    const { child, cloneDir } = spawnNodeOtherCloneDecoy({ relativeArgv1: true })
    try {
      expect(child.pid).toBeGreaterThan(0)
      await settle()

      const r = runKbStop(['--all', '--dry-run'])
      expect(r.status).toBe(0)
      expect(r.stdout).not.toContain(`pid ${child.pid}`)
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('emits DEBUG diagnostics for skipped candidates when KB_DEBUG=1', async () => {
    const decoy = spawnBashDecoy()
    expect(decoy.pid).toBeGreaterThan(0)
    await settle()

    const r = runKbStop(['--all', '--dry-run'], { KB_DEBUG: '1' })
    expect(r.status).toBe(0)
    // The guard prints a `[kb-stop] DEBUG: skipping pid <pid>` line
    // for each candidate it filters out, so an operator running the
    // host-wide sweep can see why a hit was dropped.
    expect(r.stderr).toMatch(/\[kb-stop\] DEBUG: skipping pid \d+/)
  })

  it('walks past node flags so `node --inspect tools/kb-start.mjs` still matches', async () => {
    // Real KB supervisors are sometimes started under a debug
    // inspector. We need to find the script argument by skipping
    // node's own flags rather than hard-coding argv[1]. The decoy
    // here is launched as `node --enable-source-maps <fakeScript>`
    // pointing at a different clone, so it MUST still be skipped
    // by the realpath equality check (proving the parser found
    // argv[2] correctly — argv[1] would have been the node flag).
    const cloneDir = mkdtempSync(join(tmpdir(), 'kb-stop-decoy-flag-'))
    const decoyTools = join(cloneDir, 'tools')
    mkdirSync(decoyTools, { recursive: true })
    const decoyScript = join(decoyTools, 'kb-start.mjs')
    writeFileSync(
      decoyScript,
      "// decoy with leading node flag\nsetInterval(() => {}, 1000)\n",
    )
    const child = spawn('node', ['--enable-source-maps', decoyScript], {
      detached: true,
      stdio: 'ignore',
    })
    decoys.push(child)
    try {
      expect(child.pid).toBeGreaterThan(0)
      await settle()

      const r = runKbStop(['--all', '--dry-run'], { KB_DEBUG: '1' })
      expect(r.status).toBe(0)
      // Decoy must not appear in the planned actions...
      expect(r.stdout).not.toContain(`pid ${child.pid}`)
      // ...and the DEBUG note must be the realpath-mismatch one,
      // not "no positional script argument" (which would mean the
      // parser failed to walk past --enable-source-maps).
      expect(r.stderr).toMatch(
        new RegExp(`skipping pid ${child.pid}: script arg resolves to`),
      )
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })
})
