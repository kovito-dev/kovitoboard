/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the `verifyInternalAuth` middleware
 * (v0.2.0 / spec v1.7 §6.10.6.9).
 *
 * Covers:
 *   - Missing header → 401 MissingInternalAuth.
 *   - Wrong-length header → 401 InvalidInternalAuth (no allocation
 *     amplification — the impl uses `timingSafeEqual` on Buffers of
 *     identical length only).
 *   - Equal-length mismatched header → 401 InvalidInternalAuth.
 *   - Correct header → next() called, no response written.
 *   - `resolveInternalTokenOrThrow` rejects empty / malformed env vars.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInternalAuthGuard,
  resolveInternalTokenOrThrow,
  __testing,
} from '../../src/server/middleware/internal-auth'
import type { Request, Response } from 'express'

const VALID_TOKEN = 'a'.repeat(32)

function buildReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

function buildRes(): {
  res: Response
  state: { status: number | null; body: unknown }
} {
  const state: { status: number | null; body: unknown } = {
    status: null,
    body: null,
  }
  const res = {
    status(code: number) {
      state.status = code
      return this
    },
    json(body: unknown) {
      state.body = body
      return this
    },
  } as unknown as Response
  return { res, state }
}

describe('createInternalAuthGuard', () => {
  it('passes when the header equals the expected token', () => {
    const guard = createInternalAuthGuard(VALID_TOKEN)
    const req = buildReq({ [__testing.INTERNAL_AUTH_HEADER]: VALID_TOKEN })
    const { res, state } = buildRes()
    const next = vi.fn()
    guard(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(state.status).toBeNull()
  })

  it('rejects with 401 MissingInternalAuth when the header is absent', () => {
    const guard = createInternalAuthGuard(VALID_TOKEN)
    const req = buildReq({})
    const { res, state } = buildRes()
    const next = vi.fn()
    guard(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(state.status).toBe(401)
    expect((state.body as Record<string, unknown>).error).toBe('MissingInternalAuth')
  })

  it('rejects with 401 InvalidInternalAuth on a length mismatch', () => {
    const guard = createInternalAuthGuard(VALID_TOKEN)
    const req = buildReq({ [__testing.INTERNAL_AUTH_HEADER]: 'too-short' })
    const { res, state } = buildRes()
    const next = vi.fn()
    guard(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(state.status).toBe(401)
    expect((state.body as Record<string, unknown>).error).toBe('InvalidInternalAuth')
  })

  it('rejects with 401 InvalidInternalAuth on an equal-length mismatched value', () => {
    const guard = createInternalAuthGuard(VALID_TOKEN)
    const req = buildReq({ [__testing.INTERNAL_AUTH_HEADER]: 'b'.repeat(32) })
    const { res, state } = buildRes()
    const next = vi.fn()
    guard(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(state.status).toBe(401)
    expect((state.body as Record<string, unknown>).error).toBe('InvalidInternalAuth')
  })

  it('handles array-valued headers by taking the first element', () => {
    const guard = createInternalAuthGuard(VALID_TOKEN)
    // Express does not normally surface header arrays; this guards
    // against future framework changes that might.
    const req = {
      headers: { [__testing.INTERNAL_AUTH_HEADER]: [VALID_TOKEN, 'extra'] },
    } as unknown as Request
    const { res, state } = buildRes()
    const next = vi.fn()
    guard(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(state.status).toBeNull()
  })
})

describe('resolveInternalTokenOrThrow', () => {
  const originalToken = process.env.KB_INTERNAL_TOKEN

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.KB_INTERNAL_TOKEN
    } else {
      process.env.KB_INTERNAL_TOKEN = originalToken
    }
  })

  it('returns the env value when it matches the 32-char hex shape', () => {
    process.env.KB_INTERNAL_TOKEN = VALID_TOKEN
    expect(resolveInternalTokenOrThrow()).toBe(VALID_TOKEN)
  })

  it('throws on missing env var', () => {
    delete process.env.KB_INTERNAL_TOKEN
    expect(() => resolveInternalTokenOrThrow()).toThrow(/KB_INTERNAL_TOKEN is missing/)
  })

  it('throws on malformed env var', () => {
    process.env.KB_INTERNAL_TOKEN = 'NOT_HEX'
    expect(() => resolveInternalTokenOrThrow()).toThrow(/32-character lowercase hex/)
  })
})
