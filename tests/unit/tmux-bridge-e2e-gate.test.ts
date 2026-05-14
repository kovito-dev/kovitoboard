/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * `TmuxBridge.sessionName` E2E-env gating (supplementary review §S6).
 *
 * The bridge previously honoured `KOVITOBOARD_E2E_TMUX_SESSION`
 * without checking the canonical `KB_E2E_MODE === '1'` flag, so a
 * stray env entry in a production launcher could redirect the
 * KovitoBoard tmux session to an attacker-controlled name. These
 * tests pin the double-gate contract:
 *
 *   - both env vars set     → override honoured
 *   - only the value set    → override ignored + warn-level log
 *   - only the flag set     → override ignored (no warn — no value
 *                             to refuse)
 *   - neither set           → production fallback (no warn)
 *
 * The `resolveProjectRoot` import is mocked at the source so the
 * test can confirm the production-fallback path without standing up
 * a real `FileAccessLayer`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PRODUCTION_SESSION = 'kovitoboard-test-project'

// `vi.mock` factories are hoisted above the surrounding imports, so
// any helper they reference must be defined inside the factory
// closure. We rebuild the structured-logger surface with a fresh set
// of mock functions and recover them after import via
// `vi.mocked(...)`.
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

// `resolveTmuxSessionName` prepends `kovitoboard-` to the basename
// of `resolveProjectRoot`, so the mocked project root's basename is
// what we get after sanitisation. We pick a basename that contains
// no dots / colons so the sanitiser is a no-op for our fixture.
vi.mock('../../src/server/config', () => ({
  resolveProjectRoot: () => '/tmp/test-project',
}))

import { TmuxBridge } from '../../src/server/tmux-bridge'
import { tmuxLogger } from '../../src/server/logger'

const tmuxLoggerStub = vi.mocked(tmuxLogger) as unknown as {
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

function makeFs(): import('../../src/server/fs-layer').FileAccessLayer {
  // Only the type is needed for construction; none of the methods
  // are touched by `sessionName` because `resolveProjectRoot` is
  // mocked above to return a deterministic string.
  return {} as unknown as import('../../src/server/fs-layer').FileAccessLayer
}

let originalKBE2EMode: string | undefined
let originalE2ETmuxSession: string | undefined

beforeEach(() => {
  originalKBE2EMode = process.env.KB_E2E_MODE
  originalE2ETmuxSession = process.env.KOVITOBOARD_E2E_TMUX_SESSION
  delete process.env.KB_E2E_MODE
  delete process.env.KOVITOBOARD_E2E_TMUX_SESSION
  tmuxLoggerStub.warn.mockClear()
})

afterEach(() => {
  if (originalKBE2EMode === undefined) {
    delete process.env.KB_E2E_MODE
  } else {
    process.env.KB_E2E_MODE = originalKBE2EMode
  }
  if (originalE2ETmuxSession === undefined) {
    delete process.env.KOVITOBOARD_E2E_TMUX_SESSION
  } else {
    process.env.KOVITOBOARD_E2E_TMUX_SESSION = originalE2ETmuxSession
  }
})

describe('TmuxBridge.sessionName — E2E env gating', () => {
  it('falls back to the production session name when neither env is set', () => {
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(tmuxLoggerStub.warn).not.toHaveBeenCalled()
  })

  it('honours KOVITOBOARD_E2E_TMUX_SESSION when KB_E2E_MODE === "1"', () => {
    process.env.KB_E2E_MODE = '1'
    process.env.KOVITOBOARD_E2E_TMUX_SESSION = 'fake-e2e-session'
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.sessionName).toBe('fake-e2e-session')
    expect(tmuxLoggerStub.warn).not.toHaveBeenCalled()
  })

  it('IGNORES KOVITOBOARD_E2E_TMUX_SESSION when KB_E2E_MODE is unset (§S6 mitigation)', () => {
    // The hostile launch scenario: an attacker injects the env var
    // but cannot also flip `KB_E2E_MODE`. The override must be
    // refused and a warn-level log entry emitted so the
    // misconfiguration surfaces loudly.
    process.env.KOVITOBOARD_E2E_TMUX_SESSION = 'attacker-session'
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(tmuxLoggerStub.warn).toHaveBeenCalledTimes(1)
    expect(tmuxLoggerStub.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        envName: 'KOVITOBOARD_E2E_TMUX_SESSION',
        gateEnv: 'KB_E2E_MODE',
      }),
      expect.stringContaining('KB_E2E_MODE is not set'),
    )
  })

  it('IGNORES KOVITOBOARD_E2E_TMUX_SESSION when KB_E2E_MODE has a value other than "1"', () => {
    // The gate is strict equality to the literal "1" — a stray
    // `KB_E2E_MODE=true` / `KB_E2E_MODE=0` / `KB_E2E_MODE=yes` etc
    // must NOT count as enabling the E2E mode.
    for (const value of ['0', 'true', 'yes', 'on', '']) {
      process.env.KB_E2E_MODE = value
      process.env.KOVITOBOARD_E2E_TMUX_SESSION = 'attacker-session'
      // Each iteration uses a fresh bridge to bypass the lazy cache.
      const bridge = new TmuxBridge(makeFs())
      expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    }
    // The warn fires once per ignored override (5 iterations →
    // 5 warn entries).
    expect(tmuxLoggerStub.warn).toHaveBeenCalledTimes(5)
  })

  it('does NOT warn when KB_E2E_MODE is set but KOVITOBOARD_E2E_TMUX_SESSION is unset', () => {
    // No value to refuse → no misconfiguration to surface.
    process.env.KB_E2E_MODE = '1'
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(tmuxLoggerStub.warn).not.toHaveBeenCalled()
  })

  it('does NOT warn when KOVITOBOARD_E2E_TMUX_SESSION is empty string', () => {
    // Empty string is falsy — there is nothing to refuse, so the
    // helper silently falls back to the production session.
    process.env.KOVITOBOARD_E2E_TMUX_SESSION = ''
    const bridge = new TmuxBridge(makeFs())
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(tmuxLoggerStub.warn).not.toHaveBeenCalled()
  })

  it('memoises sessionName across calls (no double warn on repeated access)', () => {
    process.env.KOVITOBOARD_E2E_TMUX_SESSION = 'attacker-session'
    const bridge = new TmuxBridge(makeFs())
    // First access — log + production fallback.
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    // Subsequent accesses must not re-evaluate the env / re-fire
    // the warn line; otherwise a misconfigured server could spam
    // the log.
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(bridge.sessionName).toBe(PRODUCTION_SESSION)
    expect(tmuxLoggerStub.warn).toHaveBeenCalledTimes(1)
  })
})
