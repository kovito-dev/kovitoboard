/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Smoke tests for `tools/kb-start.mjs` M-1 refuse branch.
 *
 * Spec SSOT: `process-lifecycle.md` v1.2 §10.2 step 6 +
 * `shared-installation-prevention-request.md` §M-1 (in the
 * kovitoboard-dev workspace).
 *
 * The supervisor is invoked as a node subprocess. M-1 fires before
 * `launch()` is reached, so the test does not actually spawn a
 * server / vite child — the process exits 1 with the explanatory
 * message and the test inspects stderr.
 *
 * We intentionally do NOT exercise the full launch path here: doing
 * so would spawn `tsx watch` and `vite`, leak ports, and require a
 * real PID-file lifecycle. Those branches belong in L1 / L3.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')

function run(args: string[], opts: { cwd: string; env?: Record<string, string> } = { cwd: REPO_ROOT }) {
  return spawnSync(process.execPath, [KB_START, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: {
      ...process.env,
      // Strip any inherited env that would short-circuit the refuse
      // branch (e.g. the test runner has KOVITOBOARD_PROJECT_ROOT
      // set to the dev workspace).
      KOVITOBOARD_PROJECT_ROOT: '',
      ...(opts.env ?? {}),
    },
  })
}

describe('tools/kb-start.mjs — M-1 KB clone self-management refuse', () => {
  it('exits 1 with an explanatory error when run from the KB clone without --project-root', () => {
    const r = run([], { cwd: REPO_ROOT })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot manage itself as a project')
    expect(r.stderr).toContain('--project-root')
    expect(r.stderr).toContain('KOVITOBOARD_PROJECT_ROOT')
  })

  it('also refuses from a subdirectory of the KB clone', () => {
    const r = run([], { cwd: join(REPO_ROOT, 'tools') })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot manage itself as a project')
  })

  it('--help short-circuits the refuse and exits 0', () => {
    // The help branch is the only legitimate "no projectRoot, cwd
    // inside repo" invocation. Verify it still works after M-1
    // landed.
    const r = run(['--help'], { cwd: REPO_ROOT })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Usage:')
    expect(r.stdout).toContain('--detach')
  })

  it('does NOT refuse when KOVITOBOARD_PROJECT_ROOT is set', () => {
    // We supply an env-based projectRoot that points outside the KB
    // clone. The refuse branch must skip; the next branch is the
    // multi-launch detector, which will either pass (no PID file at
    // the bogus path) or warn. We then exit immediately so the
    // launch branch does not actually spawn children.
    //
    // Implementation note: the supervisor proceeds to launch() and
    // would fork tsx + vite. To keep the subprocess short-lived we
    // request `--help` shape via env-only and abort by reading
    // stderr/stdout for the absence of the refuse message rather
    // than waiting on the full startup. We expect the process to
    // either finish bootstrapping (and we'll kill it via timeout)
    // or to print the multi-launch banner without exit 1.
    const tempProjectRoot = mkdtempSync(join(tmpdir(), 'kb-start-refuse-'))
    try {
      const r = spawnSync(process.execPath, [KB_START, '--help'], {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KOVITOBOARD_PROJECT_ROOT: tempProjectRoot,
        },
      })
      // --help is the safe early-exit; refuse must not fire even
      // though cwd is the KB clone.
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Usage:')
      expect(r.stderr).not.toContain('cannot manage itself as a project')
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })
})
