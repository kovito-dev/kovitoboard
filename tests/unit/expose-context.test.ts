/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the β-method exposeContext store (DEC-020 / EU8 Phase 5).
 *
 * The store enforces three contracts that matter for app authors:
 *   - 100 KB serialized cap with previous-payload preservation
 *   - Replace-not-merge semantics
 *   - JSON-serializable + plain-object validation
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  setExposedContext,
  getExposedContext,
  clearExposedContext,
  MAX_PAYLOAD_BYTES,
} from '../../src/renderer/lib/exposeContext'

describe('exposeContext', () => {
  beforeEach(() => {
    clearExposedContext()
  })

  it('starts with no payload', () => {
    expect(getExposedContext()).toBeNull()
  })

  it('accepts a plain object and serializes it', () => {
    const ok = setExposedContext({ a: 1, b: 'two' })
    expect(ok).toBe(true)
    const cur = getExposedContext()
    expect(cur).not.toBeNull()
    expect(cur?.payload).toEqual({ a: 1, b: 'two' })
    expect(cur?.serialized).toBe('{"a":1,"b":"two"}')
  })

  it('replaces (not merges) on subsequent calls', () => {
    setExposedContext({ a: 1 })
    setExposedContext({ b: 2 })
    expect(getExposedContext()?.payload).toEqual({ b: 2 })
  })

  it('rejects arrays and primitives', () => {
    // @ts-expect-error — runtime guard
    expect(setExposedContext([1, 2, 3])).toBe(false)
    // @ts-expect-error — runtime guard
    expect(setExposedContext('a string')).toBe(false)
    // @ts-expect-error — runtime guard
    expect(setExposedContext(null)).toBe(false)
    expect(getExposedContext()).toBeNull()
  })

  it('rejects payloads that exceed the 100 KB cap, preserving the previous value', () => {
    setExposedContext({ kept: 'previous' })
    const huge = { x: 'a'.repeat(MAX_PAYLOAD_BYTES + 1_000) }
    expect(setExposedContext(huge)).toBe(false)
    expect(getExposedContext()?.payload).toEqual({ kept: 'previous' })
  })

  it('rejects payloads with circular references, preserving the previous value', () => {
    setExposedContext({ kept: 'previous' })
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(setExposedContext(cyclic)).toBe(false)
    expect(getExposedContext()?.payload).toEqual({ kept: 'previous' })
  })

  it('exposes the spec-mandated 100 KB cap constant', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(100_000)
  })
})
