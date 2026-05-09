/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-launch token + Origin allowlist middleware tests.
 *
 * Pins the boundary behaviours of `createTokenAndOriginGuard` and
 * `createWsClientVerifier` so a future refactor cannot accidentally
 * relax the auth surface. The threat model is documented at the top
 * of `src/server/middleware/auth.ts` — we test the same shape of
 * input the real Express stack and `ws` library deliver.
 */
import { describe, it, expect } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import type { IncomingMessage } from 'http'
import {
  createTokenAndOriginGuard,
  createWsClientVerifier,
  resolveLaunchTokenOrThrow,
  __testing,
} from '../../src/server/middleware/auth'

const SAMPLE_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

interface ResponseRecorder {
  statusCode: number | null
  jsonBody: unknown
  res: Response
}

function makeReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

function makeRes(): ResponseRecorder {
  const recorder: ResponseRecorder = {
    statusCode: null,
    jsonBody: null,
    res: {} as Response,
  }
  recorder.res = {
    status(code: number) {
      recorder.statusCode = code
      return recorder.res
    },
    json(body: unknown) {
      recorder.jsonBody = body
      return recorder.res
    },
  } as unknown as Response
  return recorder
}

function makeNext(): { called: boolean; fn: NextFunction } {
  const state = { called: false } as { called: boolean; fn: NextFunction }
  state.fn = () => {
    state.called = true
  }
  return state
}

describe('createTokenAndOriginGuard', () => {
  const guard = createTokenAndOriginGuard(SAMPLE_TOKEN)

  it('accepts a request with the matching token and a loopback Origin', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': SAMPLE_TOKEN,
        origin: 'http://127.0.0.1:5173',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(true)
    expect(recorder.statusCode).toBeNull()
  })

  it('accepts a request with the matching token and no Origin (curl / server-to-server)', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(makeReq({ 'x-kovitoboard-token': SAMPLE_TOKEN }), recorder.res, next.fn)
    expect(next.called).toBe(true)
    expect(recorder.statusCode).toBeNull()
  })

  it('accepts http://localhost:<port>', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': SAMPLE_TOKEN,
        origin: 'http://localhost:3001',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(true)
  })

  it('rejects a request whose Origin is not on the loopback allowlist', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': SAMPLE_TOKEN,
        origin: 'http://attacker.example:8080',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(403)
  })

  it('rejects a request that omits the token header', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(makeReq({ origin: 'http://127.0.0.1:5173' }), recorder.res, next.fn)
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(401)
  })

  it('rejects a request whose token differs from the expected value', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': 'wrong-token-but-same-length-32xx',
        origin: 'http://127.0.0.1:5173',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(401)
  })

  it('rejects a token whose length differs from the expected length', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': 'short',
        origin: 'http://127.0.0.1:5173',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(401)
  })

  it('rejects an https Origin even if the host matches', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': SAMPLE_TOKEN,
        origin: 'https://localhost:5173',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(403)
  })

  it('rejects http://localhost without a port', () => {
    const recorder = makeRes()
    const next = makeNext()
    guard(
      makeReq({
        'x-kovitoboard-token': SAMPLE_TOKEN,
        origin: 'http://localhost',
      }),
      recorder.res,
      next.fn,
    )
    expect(next.called).toBe(false)
    expect(recorder.statusCode).toBe(403)
  })
})

describe('createWsClientVerifier', () => {
  const verify = createWsClientVerifier(SAMPLE_TOKEN)

  function makeUpgradeInfo(url: string, origin = 'http://127.0.0.1:5173') {
    return {
      origin,
      req: { url } as IncomingMessage,
      secure: false,
    }
  }

  it('accepts an upgrade carrying the token in the query string', () => {
    let result: { ok: boolean; code?: number; message?: string } | null = null
    verify(makeUpgradeInfo(`/api/ws?token=${SAMPLE_TOKEN}`), (ok, code, message) => {
      result = { ok, code, message }
    })
    expect(result).toEqual({ ok: true, code: undefined, message: undefined })
  })

  it('rejects an upgrade missing the token', () => {
    let result: { ok: boolean; code?: number; message?: string } | null = null
    verify(makeUpgradeInfo('/api/ws'), (ok, code, message) => {
      result = { ok, code, message }
    })
    expect(result?.ok).toBe(false)
    expect(result?.code).toBe(401)
  })

  it('rejects an upgrade whose token differs', () => {
    let result: { ok: boolean; code?: number; message?: string } | null = null
    verify(
      makeUpgradeInfo(`/api/ws?token=wrong-token-but-same-length-32xx`),
      (ok, code) => {
        result = { ok, code }
      },
    )
    expect(result?.ok).toBe(false)
    expect(result?.code).toBe(401)
  })

  it('rejects an upgrade from a non-allowlisted Origin', () => {
    let result: { ok: boolean; code?: number; message?: string } | null = null
    verify(
      makeUpgradeInfo(`/api/ws?token=${SAMPLE_TOKEN}`, 'http://attacker.example:8080'),
      (ok, code) => {
        result = { ok, code }
      },
    )
    expect(result?.ok).toBe(false)
    expect(result?.code).toBe(403)
  })

  it('accepts an upgrade with an empty Origin (programmatic test client)', () => {
    let result: { ok: boolean; code?: number; message?: string } | null = null
    verify(
      makeUpgradeInfo(`/api/ws?token=${SAMPLE_TOKEN}`, ''),
      (ok, code) => {
        result = { ok, code }
      },
    )
    expect(result?.ok).toBe(true)
  })
})

describe('resolveLaunchTokenOrThrow', () => {
  it('returns the token when KB_LAUNCH_TOKEN is set', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    process.env.KB_LAUNCH_TOKEN = SAMPLE_TOKEN
    try {
      expect(resolveLaunchTokenOrThrow()).toBe(SAMPLE_TOKEN)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN is missing', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    delete process.env.KB_LAUNCH_TOKEN
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/KB_LAUNCH_TOKEN/)
    } finally {
      if (before !== undefined) process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN is empty', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    process.env.KB_LAUNCH_TOKEN = ''
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/KB_LAUNCH_TOKEN/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN is shorter than 32 hex chars', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    process.env.KB_LAUNCH_TOKEN = 'abc123'
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/32-character lowercase hex/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN is longer than 32 hex chars', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    process.env.KB_LAUNCH_TOKEN = SAMPLE_TOKEN + '0'
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/32-character lowercase hex/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN contains non-hex characters', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    // 32 chars but with one non-hex character — would let HTML through
    // the meta-tag substitution if accepted.
    process.env.KB_LAUNCH_TOKEN = '0123456789abcdef0123456789abcdeg'
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/32-character lowercase hex/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN contains uppercase hex (non-canonical)', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    process.env.KB_LAUNCH_TOKEN = SAMPLE_TOKEN.toUpperCase()
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/32-character lowercase hex/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })

  it('throws when KB_LAUNCH_TOKEN contains an HTML metacharacter', () => {
    const before = process.env.KB_LAUNCH_TOKEN
    // The whole point of the format check is to keep this kind of
    // value out of the meta-tag substitution site.
    process.env.KB_LAUNCH_TOKEN = '"><script>alert(1)</script><meta '
    try {
      expect(() => resolveLaunchTokenOrThrow()).toThrow(/32-character lowercase hex/)
    } finally {
      if (before === undefined) delete process.env.KB_LAUNCH_TOKEN
      else process.env.KB_LAUNCH_TOKEN = before
    }
  })
})

describe('__testing exports', () => {
  it('exposes the constants used by the production middleware', () => {
    expect(__testing.TOKEN_HEADER).toBe('x-kovitoboard-token')
    expect(__testing.TOKEN_QUERY_KEY).toBe('token')
    expect(__testing.ALLOWED_ORIGIN_RE.test('http://127.0.0.1:5173')).toBe(true)
    expect(__testing.ALLOWED_ORIGIN_RE.test('http://attacker.example:80')).toBe(false)
  })
})
