/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * `TmuxBridge.hasEverHadSession()` process-lifetime latch.
 *
 * The latch backs the admin-status startup suppression: it flips to
 * `true` the first time this KB process observes its own tmux session
 * alive (or creates one) and never resets. The admin-status route uses
 * it to avoid reporting `degraded` before the KB-owned tmux session has
 * been spawned, when any active sessions are external (terminal-launched)
 * Claude processes the bridge does not own.
 *
 * Every KB-owned alive-observation / creation path must set the latch:
 *   - `hasSession()` returning true (existing-session observation)
 *   - `ensureSession()` creating a fresh session
 *   - `startAgent()` succeeding (KB-owned agent window)
 *   - `startJobWindow()` succeeding (KB-owned job window)
 *
 * `child_process.execFileSync` is mocked so the tmux outcomes are
 * controlled deterministically without a real tmux server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/server/logger', () => {
  const make = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })
  return {
    tmuxLogger: make(),
    apiLogger: make(),
    wsLogger: make(),
    recipeLogger: make(),
    serverLogger: make(),
    sessionLogger: make(),
    trustLogger: make(),
    adminLogger: make(),
    menuWatcherLog: make(),
    childLogger: () => make(),
    lazyChildLogger: () => make(),
    initLogger: vi.fn(),
    flushAndExit: vi.fn(),
    setupKbContext: vi.fn(),
  }
})

vi.mock('../../src/server/config', () => ({
  resolveProjectRoot: () => '/tmp/test-project',
}))

// `cwd-precheck` / `cwdValidator` are only reached by the cwd-gated
// entrypoints when a `cwd` is passed; the tests below pass no `cwd`, so
// the gate is bypassed and these are never invoked. They are still
// mocked to keep the import graph free of fs-layer dependencies.
vi.mock('../../src/server/cwd-precheck', () => ({
  ensureWorkRootMetadata: () => ({ additionalWorkRoots: [], workRootsMetadata: {} }),
}))

import { execFileSync } from 'child_process'
import { TmuxBridge } from '../../src/server/tmux-bridge'
import type { FileAccessLayer } from '../../src/server/fs-layer'

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}))

const execMock = vi.mocked(execFileSync)

function makeFs(): FileAccessLayer {
  return {} as unknown as FileAccessLayer
}

/**
 * Route mocked `tmux` calls by their first argument (the subcommand).
 * `has-session` resolves via `hasSessionAlive`; every other subcommand
 * (new-session / new-window / list-windows / show-environment /
 * set-environment) succeeds with empty output unless `failNewWindow` is
 * set.
 */
function installTmux(opts: {
  hasSessionAlive: boolean
  failNewWindow?: boolean
}): void {
  execMock.mockImplementation((_cmd: unknown, args?: unknown) => {
    const argv = (args as string[]) ?? []
    const sub = argv[0]
    if (sub === 'has-session') {
      if (opts.hasSessionAlive) return Buffer.from('')
      throw new Error('no session')
    }
    if (sub === 'new-window' && opts.failNewWindow) {
      throw new Error('new-window failed')
    }
    // list-windows must yield no windows so the "already exists" guard
    // does not short-circuit the creation paths.
    return Buffer.from('')
  })
}

beforeEach(() => {
  execMock.mockReset()
})

describe('TmuxBridge.hasEverHadSession() latch', () => {
  it('starts false on a fresh bridge', () => {
    installTmux({ hasSessionAlive: false })
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.hasEverHadSession()).toBe(false)
  })

  it('stays false while the session is never observed alive', () => {
    installTmux({ hasSessionAlive: false })
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.hasSession()).toBe(false)
    expect(bridge.hasEverHadSession()).toBe(false)
  })

  it('latches when hasSession() observes the session alive, and persists', () => {
    const bridge = new TmuxBridge(makeFs())
    installTmux({ hasSessionAlive: true })
    expect(bridge.hasSession()).toBe(true)
    expect(bridge.hasEverHadSession()).toBe(true)
    // Session subsequently disappears — the latch must not reset.
    installTmux({ hasSessionAlive: false })
    expect(bridge.hasSession()).toBe(false)
    expect(bridge.hasEverHadSession()).toBe(true)
  })

  it('latches when ensureSession() creates a fresh session', () => {
    installTmux({ hasSessionAlive: false })
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.hasEverHadSession()).toBe(false)
    bridge.ensureSession() // has-session fails -> new-session created
    expect(bridge.hasEverHadSession()).toBe(true)
  })

  it('latches when startAgent() succeeds', async () => {
    installTmux({ hasSessionAlive: false })
    const bridge = new TmuxBridge(makeFs())
    const res = await bridge.startAgent('agent-1')
    expect(res.success).toBe(true)
    expect(bridge.hasEverHadSession()).toBe(true)
  })

  it('latches when startJobWindow() succeeds (KB-owned job path)', () => {
    installTmux({ hasSessionAlive: false })
    const bridge = new TmuxBridge(makeFs())
    const res = bridge.startJobWindow('job-1')
    expect(res.success).toBe(true)
    expect(bridge.hasEverHadSession()).toBe(true)
  })

  it('latches via ensureSession() even when the new-window step fails', () => {
    // startJobWindow runs ensureSession() (which creates + latches)
    // before new-window. A new-window failure still leaves the latch set
    // because a KB-owned session was created.
    installTmux({ hasSessionAlive: false, failNewWindow: true })
    const bridge = new TmuxBridge(makeFs())
    const res = bridge.startJobWindow('job-2')
    expect(res.success).toBe(false)
    expect(bridge.hasEverHadSession()).toBe(true)
  })
})
