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
      // ...and the DEBUG note must be the realpath-mismatch one
      // ("entry script resolves to..."), not the runtime-rejection
      // one (which would mean the walker aborted on the leading
      // node flag).
      expect(r.stderr).toMatch(
        new RegExp(
          `skipping pid ${child.pid}: entry script resolves to`,
        ),
      )
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('skips `node -e "..." <abs-tools/kb-start.mjs>` (eval-mode rejection, no entry script)', async () => {
    // CodeX-flagged false positive: when Node runs in eval mode
    // (-e / --eval), any subsequent argv is *data* for the eval'd
    // code, not the entry script. A naive "scan all argv tokens
    // for kb-start.mjs realpath" matcher would still match the
    // data argument and SIGTERM an unrelated Node process.
    //
    // The walker must recognize -e as a no-script mode and skip
    // the candidate up front. We pass THIS clone's absolute
    // kb-start.mjs as the data argument because (a) it puts the
    // realpath-equal token into argv to defeat the substring
    // fence, and (b) eval mode never loads it as a script, so
    // the test process stays inert.
    const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')
    const decoy = spawn(
      'node',
      ['-e', 'setInterval(() => {}, 1000)', KB_START],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    decoys.push(decoy)
    expect(decoy.pid).toBeGreaterThan(0)
    await settle()

    const r = runKbStop(['--all', '--dry-run'], { KB_DEBUG: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain(`pid ${decoy.pid}`)
    expect(r.stderr).toMatch(
      new RegExp(
        `skipping pid ${decoy.pid}: no entry script \\(eval mode`,
      ),
    )
  })

  it('skips `node other-script.js <abs-tools/kb-start.mjs>` (data-arg false positive defense)', async () => {
    // Companion to the eval-mode case: even outside eval mode,
    // a script that takes kb-start.mjs's path as a data argument
    // must not be matched. The walker treats argv[1] (other.js)
    // as the entry script; argv[2] (kb-start.mjs path) is then
    // a script argument, NOT something the matcher inspects.
    const cloneDir = mkdtempSync(join(tmpdir(), 'kb-stop-decoy-dataarg-'))
    const otherScript = join(cloneDir, 'other.js')
    writeFileSync(otherScript, 'setInterval(() => {}, 1000)\n')
    const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')

    const decoy = spawn('node', [otherScript, KB_START], {
      detached: true,
      stdio: 'ignore',
    })
    decoys.push(decoy)
    try {
      expect(decoy.pid).toBeGreaterThan(0)
      await settle()

      const r = runKbStop(['--all', '--dry-run'], { KB_DEBUG: '1' })
      expect(r.status).toBe(0)
      // Decoy is NOT a supervisor — argv[1] is other.js, not
      // kb-start.mjs — so it must be skipped at the realpath
      // mismatch check.
      expect(r.stdout).not.toContain(`pid ${decoy.pid}`)
      expect(r.stderr).toMatch(
        new RegExp(
          `skipping pid ${decoy.pid}: entry script resolves to`,
        ),
      )
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('matches `node --require <preload> tools/kb-start.mjs` (value-flag operand handling)', async () => {
    // CodeX-flagged regression scenario: Node's `--require <mod>`
    // consumes its operand, so a naive "first non-flag positional"
    // parser would mistakenly treat the preload module as the
    // script and skip the real supervisor. The scanner here checks
    // every non-flag token against the expected realpath, which
    // correctly accepts the supervisor at argv[3].
    //
    // We can't easily simulate THIS clone's tools/kb-start.mjs
    // running as the entry script (that would actually start a KB
    // server), so we test the symmetric case: a node decoy whose
    // entry script lives in a fake other clone, with a junk
    // `--require` operand. The decoy MUST be skipped by realpath
    // mismatch (proving the parser scanned past `--require`'s
    // operand and reached the entry script), not skipped by
    // "no argv token resolves to..." (which would mean the
    // scanner failed to read the supervisor's argv at all).
    const cloneDir = mkdtempSync(join(tmpdir(), 'kb-stop-decoy-require-'))
    const decoyTools = join(cloneDir, 'tools')
    mkdirSync(decoyTools, { recursive: true })
    const decoyScript = join(decoyTools, 'kb-start.mjs')
    writeFileSync(
      decoyScript,
      "// decoy with --require flag\nsetInterval(() => {}, 1000)\n",
    )
    const preload = join(cloneDir, 'preload.cjs')
    writeFileSync(preload, '// no-op preload module')

    const child = spawn('node', ['--require', preload, decoyScript], {
      detached: true,
      stdio: 'ignore',
    })
    decoys.push(child)
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
})
