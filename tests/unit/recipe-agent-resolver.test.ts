/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the recipe-agent-resolver service.
 *
 * The resolver is the gate that `/api/recipes/install` and
 * `/api/recipes/apply` go through to obtain an interactive
 * `claude --agent <id>` tmux window. These tests pin its policy
 * (reuse running > preferred > kovito-concierge > first registered)
 * and the three failure modes the API surfaces back to the user.
 *
 * The tmux/agent-reader integrations are stubbed at module scope so
 * the suite runs without tmux or a project on disk; the resolver is
 * the only unit under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Stubs -----------------------------------------------------------

// `agent-reader` is only imported for `loadAgentDefinitions`. We mock
// the whole module so each test can dictate which agents "exist".
const loadAgentDefinitionsMock = vi.fn<() => Array<{ id: string }>>()
vi.mock('../../src/server/agent-reader', () => ({
  loadAgentDefinitions: () => loadAgentDefinitionsMock(),
}))

// Helper for building a `TmuxBridge` shaped object with just the
// methods the resolver actually calls.
type TmuxLike = {
  getAgentWindowMap: ReturnType<typeof vi.fn>
  startAgent: ReturnType<typeof vi.fn>
  waitForAgentReady: ReturnType<typeof vi.fn>
}

function makeTmux(overrides: Partial<TmuxLike> = {}): TmuxLike {
  return {
    getAgentWindowMap: vi.fn(() => ({})),
    startAgent: vi.fn(async () => ({ success: true })),
    waitForAgentReady: vi.fn(async () => true),
    ...overrides,
  }
}

beforeEach(() => {
  loadAgentDefinitionsMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveAgentWindowForRecipe', () => {
  it('reuses an already-running window when the preferred agent is up', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    const tmux = makeTmux({
      getAgentWindowMap: vi.fn(() => ({
        'kovito-concierge': 'kovito-concierge',
        'agent-b': 'agent-b',
      })),
    })

    const result = await resolveAgentWindowForRecipe(
      // fs / config are unused by the running-window path; pass `null`
      // through `unknown` since the resolver does not look at them
      // when an agent window already exists.
      null as unknown as Parameters<typeof resolveAgentWindowForRecipe>[0],
      null as unknown as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
      { preferredAgentId: 'agent-b' },
    )

    expect(result).toEqual({
      kind: 'ready',
      windowName: 'agent-b',
      agentId: 'agent-b',
      started: false,
    })
    expect(tmux.startAgent).not.toHaveBeenCalled()
    expect(tmux.waitForAgentReady).not.toHaveBeenCalled()
    expect(loadAgentDefinitionsMock).not.toHaveBeenCalled()
  })

  it('falls through to the first running window when no preference is given', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    const tmux = makeTmux({
      getAgentWindowMap: vi.fn(() => ({ 'agent-x': 'agent-x' })),
    })

    const result = await resolveAgentWindowForRecipe(
      null as unknown as Parameters<typeof resolveAgentWindowForRecipe>[0],
      null as unknown as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.agentId).toBe('agent-x')
      expect(result.started).toBe(false)
    }
  })

  it('auto-launches kovito-concierge when nothing is running', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([
      { id: 'researcher' },
      { id: 'kovito-concierge' },
      { id: 'designer' },
    ])
    const tmux = makeTmux()

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result).toEqual({
      kind: 'ready',
      windowName: 'kovito-concierge',
      agentId: 'kovito-concierge',
      started: true,
    })
    expect(tmux.startAgent).toHaveBeenCalledWith('kovito-concierge')
    expect(tmux.waitForAgentReady).toHaveBeenCalledWith(
      'kovito-concierge',
      30_000,
    )
  })

  it('falls back to the first registered agent when concierge is missing', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([
      { id: 'researcher' },
      { id: 'designer' },
    ])
    const tmux = makeTmux()

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.agentId).toBe('researcher')
    }
    expect(tmux.startAgent).toHaveBeenCalledWith('researcher')
  })

  it('honors preferredAgentId for auto-launch when the agent is defined', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([
      { id: 'kovito-concierge' },
      { id: 'analyst' },
    ])
    const tmux = makeTmux()

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
      { preferredAgentId: 'analyst' },
    )

    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.agentId).toBe('analyst')
    }
    expect(tmux.startAgent).toHaveBeenCalledWith('analyst')
  })

  it('returns no-agents when the project has no agent definitions', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([])
    const tmux = makeTmux()

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result).toEqual({ kind: 'no-agents' })
    expect(tmux.startAgent).not.toHaveBeenCalled()
  })

  it('returns startup-failed when tmuxBridge.startAgent reports failure', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([{ id: 'kovito-concierge' }])
    const tmux = makeTmux({
      startAgent: vi.fn(async () => ({
        success: false,
        error: 'tmux: command not found',
      })),
    })

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result).toEqual({
      kind: 'startup-failed',
      agentId: 'kovito-concierge',
      error: 'tmux: command not found',
    })
    expect(tmux.waitForAgentReady).not.toHaveBeenCalled()
  })

  it('returns startup-failed when startAgent throws synchronously', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([{ id: 'kovito-concierge' }])
    const tmux = makeTmux({
      startAgent: vi.fn(async () => {
        throw new Error('boom')
      }),
    })

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
    )

    expect(result).toEqual({
      kind: 'startup-failed',
      agentId: 'kovito-concierge',
      error: 'boom',
    })
  })

  it('returns startup-timeout when waitForAgentReady never resolves true', async () => {
    const { resolveAgentWindowForRecipe } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    loadAgentDefinitionsMock.mockReturnValue([{ id: 'kovito-concierge' }])
    const tmux = makeTmux({
      waitForAgentReady: vi.fn(async () => false),
    })

    const result = await resolveAgentWindowForRecipe(
      {} as Parameters<typeof resolveAgentWindowForRecipe>[0],
      {} as Parameters<typeof resolveAgentWindowForRecipe>[1],
      tmux as unknown as Parameters<typeof resolveAgentWindowForRecipe>[2],
      { startupTimeoutMs: 1_500 },
    )

    expect(result).toEqual({ kind: 'startup-timeout', agentId: 'kovito-concierge' })
    expect(tmux.waitForAgentReady).toHaveBeenCalledWith('kovito-concierge', 1_500)
  })
})

describe('pickAgentForLaunch', () => {
  it('respects a defined preferredAgentId', async () => {
    const { pickAgentForLaunch } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    expect(
      pickAgentForLaunch(
        [{ id: 'kovito-concierge' }, { id: 'analyst' }],
        'analyst',
      ),
    ).toBe('analyst')
  })

  it('falls back to kovito-concierge when the preference is unknown', async () => {
    const { pickAgentForLaunch } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    expect(
      pickAgentForLaunch(
        [{ id: 'kovito-concierge' }, { id: 'analyst' }],
        'ghost-agent',
      ),
    ).toBe('kovito-concierge')
  })

  it('falls back to the first agent when neither preference nor concierge is present', async () => {
    const { pickAgentForLaunch } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    expect(pickAgentForLaunch([{ id: 'analyst' }, { id: 'designer' }])).toBe(
      'analyst',
    )
  })
})

describe('buildAgentResolutionError', () => {
  it('maps no-agents to 409 with a creation hint', async () => {
    const { buildAgentResolutionError } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    const out = buildAgentResolutionError({ kind: 'no-agents' })
    expect(out.status).toBe(409)
    expect(out.error).toMatch(/no agents/i)
    expect(out.error).toMatch(/create an agent/i)
  })

  it('maps startup-failed to 500 with the agent id and underlying error', async () => {
    const { buildAgentResolutionError } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    const out = buildAgentResolutionError({
      kind: 'startup-failed',
      agentId: 'kovito-concierge',
      error: 'tmux: command not found',
    })
    expect(out.status).toBe(500)
    expect(out.error).toContain('kovito-concierge')
    expect(out.error).toContain('tmux: command not found')
  })

  it('maps startup-timeout to 503 with a folder-trust retry hint', async () => {
    const { buildAgentResolutionError } = await import(
      '../../src/server/services/recipe-agent-resolver'
    )
    const out = buildAgentResolutionError({
      kind: 'startup-timeout',
      agentId: 'kovito-concierge',
    })
    expect(out.status).toBe(503)
    expect(out.error).toMatch(/folder-trust/i)
    expect(out.error).toMatch(/try again/i)
  })
})
