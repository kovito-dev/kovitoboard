/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * `TmuxBridge.getWindowPanePid()` — external-client sidecar-correlation
 * PID latch (external-client-api.md §7.3.2.1 (S-4) / §9.4, BL-2026-285).
 *
 * Runs `tmux list-panes -t <session>:<window> -F '#{pane_pid}'` and
 * resolves the single pane PID. Fail-closed (returns null) on 0 panes,
 * 2+ panes (ambiguous), a non-positive-integer PID, an invalid window
 * name, or a tmux call failure — so the correlation skips the stamp
 * (under-delivery), never over-delivers.
 *
 * `child_process.execFileSync` is mocked for determinism.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('../../src/server/logger', () => {
  const make = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })
  return {
    tmuxLogger: make(),
    apiLogger: make(),
    wsLogger: make(),
    serverLogger: make(),
    sessionLogger: make(),
    childLogger: () => make(),
    lazyChildLogger: () => make(),
  }
})

import { TmuxBridge } from '../../src/server/tmux-bridge'
import { execFileSync } from 'child_process'
import type { FileAccessLayer } from '../../src/server/fs-layer'

vi.mock('child_process', () => ({ execFileSync: vi.fn() }))
const execMock = vi.mocked(execFileSync)

function makeFs(): FileAccessLayer {
  return {} as unknown as FileAccessLayer
}

const ORIG_E2E_MODE = process.env.KB_E2E_MODE
const ORIG_E2E_SESSION = process.env.KOVITOBOARD_E2E_TMUX_SESSION

beforeEach(() => {
  execMock.mockReset()
  // Pin a deterministic session name without touching fs.
  process.env.KB_E2E_MODE = '1'
  process.env.KOVITOBOARD_E2E_TMUX_SESSION = 'kb-test'
})

afterAll(() => {
  if (ORIG_E2E_MODE === undefined) delete process.env.KB_E2E_MODE
  else process.env.KB_E2E_MODE = ORIG_E2E_MODE
  if (ORIG_E2E_SESSION === undefined) delete process.env.KOVITOBOARD_E2E_TMUX_SESSION
  else process.env.KOVITOBOARD_E2E_TMUX_SESSION = ORIG_E2E_SESSION
})

describe('TmuxBridge.getWindowPanePid (S-4)', () => {
  it('returns the single pane PID for a one-pane window with the right tmux target', () => {
    execMock.mockReturnValue('243405\n')
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('kb-pdm')).toBe(243405)
    // Assert the tmux invocation OUTSIDE the mock (assertions thrown
    // inside the impl would be swallowed by the bridge's try/catch).
    const [cmd, argv] = execMock.mock.calls[0]
    expect(cmd).toBe('tmux')
    expect(argv).toEqual(['list-panes', '-t', 'kb-test:kb-pdm', '-F', '#{pane_pid}'])
  })

  it('fail-closed (null) when the window has no panes', () => {
    execMock.mockReturnValue('')
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('kb-pdm')).toBeNull()
  })

  it('fail-closed (null) when the window has more than one pane (ambiguous)', () => {
    execMock.mockReturnValue('111\n222\n')
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('kb-pdm')).toBeNull()
  })

  it('fail-closed (null) when the PID is not a positive integer', () => {
    execMock.mockReturnValue('not-a-pid\n')
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('kb-pdm')).toBeNull()
  })

  it('fail-closed (null) when the tmux call throws', () => {
    execMock.mockImplementation(() => {
      throw new Error('no server')
    })
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('kb-pdm')).toBeNull()
  })

  it('fail-closed (null) for an invalid window name without invoking tmux', () => {
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.getWindowPanePid('bad name; rm -rf')).toBeNull()
    expect(execMock).not.toHaveBeenCalled()
  })
})
