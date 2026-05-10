/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnSyncReturns } from 'node:child_process'

import {
  enforcePreflight,
  runPreflightChecks,
  type PreflightDeps,
  type PreflightFailure,
} from '../../src/server/preflight'

// --- Helpers --------------------------------------------------------

function spawnOk(stdout: string): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: ['', stdout, ''],
    stdout,
    stderr: '',
    status: 0,
    signal: null,
  } as SpawnSyncReturns<string>
}

function spawnExit(status: number, stderr = ''): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: ['', '', stderr],
    stdout: '',
    stderr,
    status,
    signal: null,
  } as SpawnSyncReturns<string>
}

function spawnError(
  message: string,
  code: string = 'ENOENT',
): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: Object.assign(new Error(message), { code }),
  } as unknown as SpawnSyncReturns<string>
}

function spawnSignal(signal: NodeJS.Signals): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null,
    signal,
  } as SpawnSyncReturns<string>
}

interface FakeSpawnTable {
  tmux?: SpawnSyncReturns<string>
  claude?: SpawnSyncReturns<string>
}

function buildDeps(
  overrides: Partial<PreflightDeps> & { spawnTable?: FakeSpawnTable } = {},
): PreflightDeps {
  // Merge against happy-path defaults so callers only need to set the
  // entries they care about (a test that simulates a tmux failure
  // should still see `claude --version` succeed).
  const table: FakeSpawnTable = {
    tmux: spawnOk('tmux 3.4\n'),
    claude: spawnOk('claude 1.2.3\n'),
    ...overrides.spawnTable,
  }
  const spawn: PreflightDeps['spawn'] = (command) => {
    if (command === 'tmux' && table.tmux) return table.tmux
    if (command === 'claude' && table.claude) return table.claude
    return spawnError(`unexpected spawn(${command})`)
  }
  return {
    spawn: overrides.spawn ?? spawn,
    nodeVersion: overrides.nodeVersion ?? 'v20.10.0',
  }
}

// --- runPreflightChecks --------------------------------------------

describe('runPreflightChecks', () => {
  it('returns ok when all three checks pass', () => {
    const result = runPreflightChecks(buildDeps())
    expect(result).toEqual({ ok: true, failures: [] })
  })

  // PF-1 tmux

  it('PF-1: passes for tmux 3.4 exactly', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.4\n') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-1: passes for tmux 3.5a (alpha suffix)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.5a\n') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-1: passes for tmux 3.10 (two-digit minor)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.10\n') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-1: passes for tmux 4.0', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 4.0\n') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-1: fails for tmux 3.3 (below minimum minor)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.3\n') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toContain('3.4+ required')
    expect(failure?.message).toContain('detected: 3.3')
  })

  it('PF-1: fails for tmux 2.9 (below major)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 2.9\n') } }),
    )
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.id).toBe('PF-1')
  })

  it('PF-1: fails when stdout is unparseable', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('garbage output\n') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toContain('unparseable')
  })

  it('PF-1: fails when tmux is not found (spawn ENOENT)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnError('ENOENT') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toBe('tmux not found on PATH')
  })

  it('PF-1: differentiates non-ENOENT spawn errors from "not found"', () => {
    const result = runPreflightChecks(
      buildDeps({
        spawnTable: { tmux: spawnError('permission denied', 'EACCES') },
      }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toMatch(/^tmux -V launch failed:/)
    expect(failure?.message).toContain('permission denied')
  })

  it('PF-1: fails when tmux exits non-zero (no stderr)', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnExit(1) } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toBe('tmux -V exited 1')
  })

  it('PF-1: includes stderr tail when tmux exits non-zero with output', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnExit(2, 'cannot connect to socket') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toBe('tmux -V exited 2: cannot connect to socket')
  })

  it('PF-1: surfaces the signal name when tmux is killed', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnSignal('SIGKILL') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-1')
    expect(failure?.message).toBe('tmux -V terminated by signal SIGKILL')
  })

  it('PF-1 hint mentions install / upgrade guidance', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnError('ENOENT') } }),
    )
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.hint).toContain('tmux 3.4+')
  })

  // PF-2 Node

  it('PF-2: passes for v20.10.0', () => {
    const result = runPreflightChecks(buildDeps({ nodeVersion: 'v20.10.0' }))
    expect(result.ok).toBe(true)
  })

  it('PF-2: passes for v22.0.0', () => {
    const result = runPreflightChecks(buildDeps({ nodeVersion: 'v22.0.0' }))
    expect(result.ok).toBe(true)
  })

  it('PF-2: fails for v18.20.0', () => {
    const result = runPreflightChecks(buildDeps({ nodeVersion: 'v18.20.0' }))
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-2')
    expect(failure?.message).toContain('Node.js 20+ required')
    expect(failure?.message).toContain('v18.20.0')
  })

  it('PF-2: fails when version string is unparseable', () => {
    const result = runPreflightChecks(buildDeps({ nodeVersion: 'garbage' }))
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-2')
    expect(failure?.message).toContain('unparseable')
  })

  // PF-3 Claude

  it('PF-3: passes when claude --version exits 0', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.4\n'), claude: spawnOk('claude 1.0.0\n') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-3: passes even when claude prints no version (exit 0 only)', () => {
    // Per spec §6.9.5: version-string parsing is out of scope. exit 0
    // is sufficient evidence the binary responded.
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.4\n'), claude: spawnOk('') } }),
    )
    expect(result.ok).toBe(true)
  })

  it('PF-3: fails when claude is not found', () => {
    const result = runPreflightChecks(
      buildDeps({ spawnTable: { tmux: spawnOk('tmux 3.4\n'), claude: spawnError('ENOENT') } }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-3')
    expect(failure?.message).toBe('claude not found on PATH')
  })

  it('PF-3: fails when claude exits non-zero with stderr', () => {
    const result = runPreflightChecks(
      buildDeps({
        spawnTable: {
          tmux: spawnOk('tmux 3.4\n'),
          claude: spawnExit(127, 'login required'),
        },
      }),
    )
    expect(result.ok).toBe(false)
    const failure = result.failures.find((f) => f.id === 'PF-3')
    expect(failure?.message).toBe('claude --version exited 127: login required')
  })

  // Aggregation

  it('aggregates failures from multiple checks', () => {
    const result = runPreflightChecks(
      buildDeps({
        spawnTable: {
          tmux: spawnOk('tmux 3.0\n'),
          claude: spawnError('ENOENT'),
        },
        nodeVersion: 'v18.0.0',
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.id).sort()).toEqual([
      'PF-1',
      'PF-2',
      'PF-3',
    ])
  })

  it('preserves the natural check order (PF-1, PF-2, PF-3)', () => {
    const result = runPreflightChecks(
      buildDeps({
        spawnTable: {
          tmux: spawnError('ENOENT'),
          claude: spawnError('ENOENT'),
        },
        nodeVersion: 'v18.0.0',
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.id)).toEqual(['PF-1', 'PF-2', 'PF-3'])
  })
})

// --- enforcePreflight ----------------------------------------------

describe('enforcePreflight', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? ''})`)
      }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    exitSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('returns silently when result.ok is true', () => {
    enforcePreflight({ ok: true, failures: [] })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('exits 1 with FAIL + HINT logs when failures are present', () => {
    const failure: PreflightFailure = {
      id: 'PF-1',
      message: 'tmux 3.4+ required (detected: 3.2)',
      hint: 'Install / upgrade tmux 3.4+. ...',
    }
    expect(() =>
      enforcePreflight({ ok: false, failures: [failure] }, { PATH: '/usr/bin' }),
    ).toThrow(/process\.exit\(1\)/)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[kb-preflight] FAIL PF-1: tmux 3.4+ required (detected: 3.2)',
    )
    expect(errorSpy).toHaveBeenCalledWith(
      '[kb-preflight] HINT: Install / upgrade tmux 3.4+. ...',
    )
  })

  it('logs warn-only and continues when KOVITOBOARD_SKIP_PREFLIGHT=1', () => {
    const failure: PreflightFailure = {
      id: 'PF-3',
      message: 'claude CLI not found or unresponsive',
      hint: 'Install Claude Code: ...',
    }
    enforcePreflight(
      { ok: false, failures: [failure] },
      { KOVITOBOARD_SKIP_PREFLIGHT: '1' },
    )
    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[kb-preflight] WARN: KOVITOBOARD_SKIP_PREFLIGHT=1, skipping (PF-3: claude CLI not found or unresponsive)',
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('does not skip when KOVITOBOARD_SKIP_PREFLIGHT is set to a non-"1" value', () => {
    const failure: PreflightFailure = {
      id: 'PF-2',
      message: 'Node.js 20+ required (detected: v18.0.0)',
      hint: 'Upgrade to Node.js 20+. ...',
    }
    expect(() =>
      enforcePreflight(
        { ok: false, failures: [failure] },
        { KOVITOBOARD_SKIP_PREFLIGHT: 'true' },
      ),
    ).toThrow(/process\.exit\(1\)/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('logs every failure even when several are present', () => {
    const failures: PreflightFailure[] = [
      { id: 'PF-1', message: 'tmux not found', hint: 'tmux hint' },
      { id: 'PF-3', message: 'claude not found', hint: 'claude hint' },
    ]
    expect(() => enforcePreflight({ ok: false, failures }, {})).toThrow(
      /process\.exit\(1\)/,
    )
    expect(errorSpy.mock.calls.flat()).toContain(
      '[kb-preflight] FAIL PF-1: tmux not found',
    )
    expect(errorSpy.mock.calls.flat()).toContain(
      '[kb-preflight] FAIL PF-3: claude not found',
    )
  })
})
