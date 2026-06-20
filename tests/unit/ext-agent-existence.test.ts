/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * R-7 agent-existence resolver (external-client-api.md v1.2 §10.4).
 *
 * Drives the pure `resolveAgentExistence` helper that BOTH the HTTP
 * (`handleExtNew`) and WS (`handleExtWsSessionNew`) ext launch paths use,
 * so the three-value contract — exists / unknown / load-failed
 * (fail-closed) — is pinned for the WS path too (the WS handler ignores +
 * warns on anything other than `'exists'`, taking no registry / launch /
 * tmux side effect).
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveAgentExistence } from '../../src/server/ext-client/agent-existence'

const AGENTS = [{ id: 'agent-real' }, { id: 'kovito-default' }]

describe('resolveAgentExistence (§10.4 R-7)', () => {
  it("returns 'exists' for an agentId present in the definition set", () => {
    expect(resolveAgentExistence('agent-real', () => AGENTS)).toBe('exists')
  })

  it("returns 'unknown' for a well-formed but non-existent agentId", () => {
    expect(resolveAgentExistence('ghost-agent', () => AGENTS)).toBe('unknown')
  })

  it("returns 'load-failed' (fail-closed) when the loader throws", () => {
    const onLoadError = vi.fn()
    const result = resolveAgentExistence(
      'agent-real',
      () => {
        throw new Error('definitions unreadable')
      },
      onLoadError,
    )
    // Fail-closed: never reports 'exists' (which would authorise a spawn)
    // from a definition set that could not be built.
    expect(result).toBe('load-failed')
    expect(onLoadError).toHaveBeenCalledTimes(1)
  })

  it("returns 'unknown' (not 'exists') against an empty definition set", () => {
    expect(resolveAgentExistence('anything', () => [])).toBe('unknown')
  })

  it('does not invoke the loader-error hook on a successful load', () => {
    const onLoadError = vi.fn()
    resolveAgentExistence('agent-real', () => AGENTS, onLoadError)
    expect(onLoadError).not.toHaveBeenCalled()
  })
})
