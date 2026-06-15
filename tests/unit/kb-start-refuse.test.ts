/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Smoke tests for `tools/kb-start.mjs` projectRoot resolution + M-1
 * self-management refuse branch.
 *
 * Spec SSOT: `process-lifecycle.md` v1.5 §3.7 / §3.7.2 +
 * `shared-installation-prevention-request.md` v1.3 §M-1 (in the
 * kovitoboard-dev workspace).
 *
 * The supervisor resolves projectRoot with the same 4-stage chain as
 * the server (cli-arg → env → setting-json → cwd-fallback) and then
 * evaluates M-1 against the *resolved* path: if the resolved path is
 * the KB clone (`repoRoot`) itself or anything inside it, the
 * supervisor refuses regardless of the source. The check fully
 * canonicalizes both paths with `realpathSync` so symlink aliases that
 * point at the clone are caught.
 *
 * M-1 fires before `launch()` is reached, so these tests do not spawn a
 * server / vite child — the process exits 1 with the explanatory
 * message and the test inspects stderr. Cases that must NOT refuse use
 * `--help` (which short-circuits before resolution) to avoid forking
 * the full launch path; the full launch path belongs in L1.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const KB_START = resolve(REPO_ROOT, 'tools', 'kb-start.mjs')

function run(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  return spawnSync(process.execPath, [KB_START, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      // Strip any inherited env that would short-circuit resolution
      // (e.g. the test runner has KOVITOBOARD_PROJECT_ROOT set to the
      // dev workspace).
      KOVITOBOARD_PROJECT_ROOT: '',
      ...(opts.env ?? {}),
    },
  })
}

// NOTE on setting-json coverage: the supervisor reads
// `<repoRoot>/.kovitoboard/setting.json` where repoRoot is derived from
// kb-start.mjs's own location, so the setting-json resolution stage
// cannot be exercised here without writing into the real clone (which
// would race / pollute the working tree). The setting-json rescue
// (resolved → external project, must NOT refuse) and the polluted
// setting-json reject (resolved → clone, must refuse) are covered by L1
// with a staged fake-clone harness; see the tester observation points.

describe('tools/kb-start.mjs — M-1 KB clone self-management refuse (resolved-after)', () => {
  // The cwd-fallback → clone case (no source, cwd inside clone) is not
  // unit-tested here because the setting-json stage reads the real
  // clone's (gitignored) `.kovitoboard/setting.json`, which may exist
  // locally and override the cwd-fallback — making the test
  // environment-dependent. The resolved-after M-1 logic is identical
  // regardless of source, so the cli-arg / env cases below exercise the
  // same containment check deterministically; cwd-fallback → clone is
  // covered by L1 with a clean staged clone.

  it('refuses when --project-root explicitly targets the KB clone (source: cli-arg)', () => {
    // Explicit sources are refused too (resolved-after evaluation):
    // the resolved path equals the clone, so M-1 fires regardless of
    // source.
    const r = run(['--project-root', REPO_ROOT])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot manage itself as a project')
    expect(r.stderr).toContain('source: cli-arg')
  })

  it('refuses when KOVITOBOARD_PROJECT_ROOT explicitly targets the KB clone (source: env)', () => {
    const r = run([], { env: { KOVITOBOARD_PROJECT_ROOT: REPO_ROOT } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot manage itself as a project')
    expect(r.stderr).toContain('source: env')
  })

  it('refuses a symlink alias that points at the KB clone (canonicalized)', () => {
    // A symlink whose realpath is the clone must be caught by the
    // full-path canonicalize before the containment check.
    const tmp = mkdtempSync(join(tmpdir(), 'kb-start-symlink-'))
    const alias = join(tmp, 'clone-alias')
    try {
      symlinkSync(REPO_ROOT, alias, 'dir')
      const r = run(['--project-root', alias])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('cannot manage itself as a project')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('fails loud when the resolved projectRoot does not exist (canonicalize failure)', () => {
    const bogus = join(tmpdir(), `kb-start-nonexistent-${Date.now()}`)
    const r = run(['--project-root', bogus])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot verify the project root path')
  })

  it('--help short-circuits before resolution and exits 0', () => {
    const r = run(['--help'], { cwd: REPO_ROOT })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Usage:')
    expect(r.stdout).toContain('--detach')
  })

  it('--help short-circuits even when KOVITOBOARD_PROJECT_ROOT is set', () => {
    // --help exits before resolution / M-1, so an external env value
    // never reaches the refuse branch. This guards the early-exit
    // ordering; the positive "external env starts successfully" path
    // (which forks the launch tree) belongs in L1.
    const tempProjectRoot = mkdtempSync(join(tmpdir(), 'kb-start-ext-'))
    try {
      const r = spawnSync(process.execPath, [KB_START, '--help'], {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KOVITOBOARD_PROJECT_ROOT: tempProjectRoot,
        },
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Usage:')
      expect(r.stderr).not.toContain('cannot manage itself as a project')
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })
})
