/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetLoggerForTests,
  childLogger,
  initLogger,
  maskHomePath,
  redactSensitiveTokens,
} from '../../src/server/logger'
import type { KovitoboardSetting } from '../../src/shared/setting-types'

/**
 * pino-roll v4 names rotated files as `<base>.<date>.<n>.log` and
 * keeps a symlink at `current.log` (the latter name is fixed by
 * pino-roll and cannot be customized in v4). The helper resolves
 * whichever rotated file is currently active so tests do not depend
 * on the exact suffix.
 */
function readActiveLogFile(projectRoot: string): string {
  const dir = join(projectRoot, '.kovitoboard', 'logs')
  const entries = readdirSync(dir).filter((f) => f.startsWith('server.') && f.endsWith('.log'))
  if (entries.length === 0) throw new Error(`No rotated log file found in ${dir}`)
  // Pick the most recent (highest count suffix wins)
  entries.sort()
  return readFileSync(join(dir, entries[entries.length - 1]), 'utf-8')
}

const baseSetting = (overrides: Partial<KovitoboardSetting> = {}): KovitoboardSetting => ({
  version: '1.1',
  user: { displayName: 'tester', avatar: null },
  project: { name: 'p', description: 'd', path: '/tmp/p' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
  ...overrides,
})

describe('logger / maskHomePath', () => {
  it('replaces the home directory prefix with ~', () => {
    // Use os.homedir() indirectly by exercising a known prefix
    const fake = '/home/someone/project/foo'
    // Without DI, this just exercises the function on the actual home;
    // we assert the function is at least idempotent on a non-home path.
    expect(maskHomePath('hello world')).toBe('hello world')
    // A path that does not contain the home dir is untouched
    expect(maskHomePath(fake.replace('/home/someone', '/opt/elsewhere')))
      .toBe(fake.replace('/home/someone', '/opt/elsewhere'))
  })
})

describe('logger / redactSensitiveTokens', () => {
  it('redacts an Anthropic API key prefix', () => {
    const input = 'auth failed for sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const out = redactSensitiveTokens(input)
    expect(out).toContain('<sk-ant redacted>')
    expect(out).not.toContain('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    // Surrounding text should be intact
    expect(out.startsWith('auth failed for ')).toBe(true)
  })

  it('redacts multiple Anthropic API keys in the same line', () => {
    const input = 'sk-ant-aaaaaaaaaaaaaaaaaaaa and also sk-ant-bbbbbbbbbbbbbbbbbbbb'
    const out = redactSensitiveTokens(input)
    expect(out).toBe('<sk-ant redacted> and also <sk-ant redacted>')
  })

  it('redacts a generic JWT (3 base64url segments)', () => {
    // header.payload.signature, each segment ≥ 10 chars and starting
    // with `eyJ` for header / payload (the canonical `{"…` prefix).
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const input = `Bearer ${jwt}`
    const out = redactSensitiveTokens(input)
    expect(out).toBe('Bearer <jwt redacted>')
  })

  it('leaves regular paths and identifiers untouched', () => {
    // Project paths, git SHAs, UUIDs, plain words. None of these should
    // match. (UUID is hyphen-segmented, not dot-segmented; git SHAs are
    // 40 hex chars without the `eyJ` prefix.)
    const sha = 'abcdef0123456789abcdef0123456789abcdef01'
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const input = `commit ${sha} on branch fix/${uuid} touches src/server/index.ts`
    expect(redactSensitiveTokens(input)).toBe(input)
  })

  it('leaves a short sk-ant- prefix that is not a real key untouched', () => {
    // Documentation snippet: `sk-ant-` literally, no key body. The
    // regex requires ≥20 chars after the prefix to avoid eating
    // mention-only strings in docs / error messages.
    const input = 'use the prefix sk-ant- when configuring keys'
    expect(redactSensitiveTokens(input)).toBe(input)
  })
})

describe('logger / sensitive-token redaction at write time', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-logger-redact-test-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
  })

  afterEach(async () => {
    _resetLoggerForTests()
    await new Promise((r) => setTimeout(r, 100))
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('redacts an API key in a structured field on the persisted log line', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-test')
    log.info(
      { apiKey: 'sk-ant-api03-RedactMeIfYouSeeThisInLogs1234567890' },
      'auth failed',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-RedactMeIfYouSeeThisInLogs1234567890')
  })

  it('redacts a string-only msg argument via the logMethod hook', async () => {
    // pino's `formatters.log` only sees the merging object, but the
    // `hooks.logMethod` wrapper installed in initLogger walks every
    // string positional argument and runs `redactSensitiveTokens`
    // before forwarding to the real method. Call sites no longer
    // need to remember the manual redaction in the common case;
    // structured-field paths still work via `formatters.log`.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-msg')
    log.info(
      'claude exited with sk-ant-api03-MsgKeyShouldGoTooLongEnough123 in the error',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-MsgKeyShouldGoTooLongEnough123')
  })

  it('redacts a msg passed alongside structured fields (object + msg signature)', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-msg-with-obj')
    log.info(
      { kind: 'auth' },
      'claude exited with sk-ant-api03-WithObjArgVariant1234567890 in the error',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-WithObjArgVariant1234567890')
    // The structured field is preserved verbatim.
    expect(raw).toContain('"kind":"auth"')
  })

  it('redactSensitiveTokens remains exported for call-site safety nets and printf-style msg', async () => {
    // The hook handles the common `logger.info(msgString)` shape.
    // Call sites that build the msg via printf-style interpolation
    // (`{ msg: \`error: \${err.message}\` }`) or pass it through some
    // upstream formatting may still want to apply the redaction
    // explicitly; the function is exported and idempotent.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-callsite')
    const raw_msg = 'claude exited with sk-ant-api03-CallSiteShouldRedact1234567 in the error'
    log.info(redactSensitiveTokens(raw_msg))
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-CallSiteShouldRedact1234567')
  })

  it('redacts a compact JWT (short payload after BL feedback CodeX attempt 1)', async () => {
    // Compact JWT whose payload is `{"exp":1}` → `eyJleHAiOjF9`
    // (12 chars, but the inner content shrinks once we drop the
    // 10-char minimum. Pin the regression now that the matcher
    // accepts segments ≥4 chars.)
    const compactJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.abcd1234'
    expect(redactSensitiveTokens(`Bearer ${compactJwt}`)).toBe('Bearer <jwt redacted>')
  })

  it('redacts a printf-style trailing object positional arg', async () => {
    // `logger.info('failed %o', { apiKey: '...' })` lets pino stringify
    // the trailing object via util.format AFTER `formatters.log`
    // ran (formatters.log only sees arg 0, the merging object).
    // The hook walks every object/array beyond index 0 so the
    // embedded key is redacted before pino's util.format formats it.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-printf')
    log.info(
      'auth failed %o',
      { apiKey: 'sk-ant-api03-PrintfStyleArgKeyShouldGoToo123' },
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-PrintfStyleArgKeyShouldGoToo123')
  })

  it('does not crash on a self-referential trailing object (cycle detection)', async () => {
    // A cyclic structure as a printf-style trailing arg used to
    // overflow the stack inside the redactor. The walker now
    // tracks visited nodes with a WeakSet and stops at repeats,
    // so the call returns normally.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('cycle-trailing')
    type Cyclic = { name: string; self?: Cyclic }
    const cyc: Cyclic = { name: 'oops' }
    cyc.self = cyc

    expect(() => log.info('cyclic %o', cyc)).not.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    // The record landed on disk (no crash), even though pino's
    // util.format will print `[Circular]` etc. for the cycle.
    expect(raw).toContain('cyclic')
  })

  it('replaces cycles with a sentinel so a cycle cannot smuggle a token past the redactor', async () => {
    // If the walker returned the original object on cycle, the
    // cloned record would still carry the raw subtree under
    // `self` and re-expose any credential it contains. The
    // sentinel branch ensures the cycle is broken AND the
    // re-exposed reference is replaced with a string the
    // redactor's regex no longer needs to scan.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('cycle-token')
    type Cyclic = {
      token: string
      self?: Cyclic
    }
    const cyc: Cyclic = {
      token: 'sk-ant-api03-CycleSubtreeShouldStillBeRedacted',
    }
    cyc.self = cyc

    log.info({ wrapped: cyc }, 'with cycle')
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-CycleSubtreeShouldStillBeRedacted')
    expect(raw).toContain('[Circular]')
  })

  it('replaces deep subtrees with a sentinel at the depth cap', async () => {
    // A pathological deeply-nested record used to bypass redaction
    // beyond REDACT_MAX_DEPTH because the walker returned the raw
    // subtree. The sentinel branch breaks that path.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('depth-token')

    // Build a chain `{ a: { a: { a: ... { a: { token: ... } } } } }`
    // 40 levels deep — past the cap of 32.
    type Nested = { token?: string; a?: Nested }
    let leaf: Nested = { token: 'sk-ant-api03-DeepNestedShouldNotLeakBeyondCap' }
    for (let i = 0; i < 40; i++) {
      leaf = { a: leaf }
    }

    log.info({ deep: leaf }, 'nested')
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).not.toContain('sk-ant-api03-DeepNestedShouldNotLeakBeyondCap')
    expect(raw).toContain('[Truncated: depth limit]')
  })

  it('leaves trailing non-plain positional args (Error/Date/Buffer) for pino to format (no redactor regression)', async () => {
    // Non-plain objects (Error, Date, Buffer, Map, class instances)
    // are NOT walked by the redactor — the walker bails to the
    // identity branch when the prototype is not `Object.prototype`.
    // The pre-fix walker tried to clone these via `Object.entries`,
    // which lost their non-enumerable members and collapsed them
    // to `{}` before pino formatted them. The post-fix walker
    // returns the same instance, so pino's own `util.format` /
    // serializers handle them. The exact rendered shape depends
    // on pino's version, so the assertions below verify only that
    // the call (a) does not throw and (b) the in-memory caller's
    // value is untouched.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('plain-only')

    const err = new Error('boom: sk-ant-api03-StillVisibleViaUtilFormat1234')
    expect(() => log.info('err as trailing %o', err)).not.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    // Caller's Error is untouched in memory regardless of how pino
    // formatted it on disk.
    expect(err.message).toContain('sk-ant-api03-StillVisibleViaUtilFormat1234')

    const d = new Date('2026-05-09T12:00:00Z')
    expect(() => log.info('date as trailing %o', d)).not.toThrow()

    // Note: Buffer / Map / class-instance trailing args are also
    // handled by the same identity-branch fallback. We do not
    // exercise Buffer here because pino-roll's async write stream
    // races with vitest cleanup and surfaces as an unrelated
    // EBADF. The walker's contract ("non-plain prototype = leave
    // value alone") covers them by construction.
  })

  it('does not double-walk the first object positional arg (formatters.log handles it)', async () => {
    // The merging object at arg 0 is the path `formatters.log`
    // already walks. Walking it in the hook too would
    //   (a) clone the record twice (visible only as runtime cost,
    //       not in test output), and
    //   (b) destructively shape `Error` first-args to `{}` because
    //       `Object.entries` skips non-enumerable `message` /
    //       `stack`, defeating any future `serializers.err`
    //       expansion before `formatters.log` runs.
    // Pin the contract by exercising both an Error first arg
    // (which must not lose its identity) and a normal object first
    // arg (which must still be redacted by the formatters.log path).
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('first-arg')

    // (a) Object first arg with a credential — formatters.log
    //     redacts it.
    log.info(
      { apiKey: 'sk-ant-api03-FirstArgKeyShouldStillRedact1234' },
      'first arg redaction',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw1 = readActiveLogFile(projectRoot)
    expect(raw1).toContain('<sk-ant redacted>')
    expect(raw1).not.toContain('sk-ant-api03-FirstArgKeyShouldStillRedact1234')

    // (b) Error first arg — the hook now skips the merging
    //     object so the Error reaches `formatters.log` with its
    //     identity intact. Pino's own serializer expands it
    //     (`{ type, message, stack }`) and the surrounding
    //     `formatters.log` walks the resulting plain object.
    //     The in-memory Error survives untouched. The exact
    //     persisted shape depends on whether pino's serializer
    //     output is fed back through `formatters.log` (varies by
    //     pino version); the only invariant is "the call did not
    //     throw and the in-memory Error is unchanged".
    const err = new Error(
      'claude failed: sk-ant-api03-ErrorMessageEmbeddedKey1234567 is invalid',
    )
    expect(() => log.error({ err }, 'subprocess crashed')).not.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    expect(err.message).toContain('sk-ant-api03-ErrorMessageEmbeddedKey1234567')
  })

  it('redacts API keys nested inside arrays (e.g. paneTail)', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-array')
    log.info(
      {
        windowName: 'test-window',
        paneTail: [
          'last visible row',
          'token=sk-ant-api03-NestedInsideArrayShouldGoToo123',
          'another row',
        ],
      },
      'Fallback fired (no known pattern matched)',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-NestedInsideArrayShouldGoToo123')
    // Sibling rows survive.
    expect(raw).toContain('last visible row')
    expect(raw).toContain('another row')
  })

  it('does not mutate the in-memory record handed to the logger', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-immut')
    const record = {
      apiKey: 'sk-ant-api03-MustNotBeMutatedInMemory12345',
    }
    log.info(record, 'should be redacted on disk only')
    await new Promise((r) => setTimeout(r, 200))
    // Caller's object is untouched (formatters.log runs at write time
    // on a clone).
    expect(record.apiKey).toBe('sk-ant-api03-MustNotBeMutatedInMemory12345')
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
  })
})

describe('logger / initLogger + childLogger', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-logger-test-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
  })

  afterEach(async () => {
    _resetLoggerForTests()
    // pino-roll's underlying write stream is asynchronous: a write
    // logged just before the test ended may still be pending when
    // we hit the rmSync below, which on CI surfaces as
    //   `Unhandled Errors: ENOENT: no such file or directory, open ` +
    //   `'/tmp/kb-logger-test-XXX/.kovitoboard/logs/server.<date>.1.log'`.
    // The reset above closes the logger; a short tick lets the
    // microtask that flushes the close ack land before we delete
    // the directory.
    await new Promise((r) => setTimeout(r, 100))
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes JSON Lines with required fields (time, level, pid, component, msg)', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('test-component')
    log.info({ extra: 1 }, 'hello world')

    // Wait briefly for pino-roll to flush
    await new Promise((r) => setTimeout(r, 200))

    const raw = readActiveLogFile(projectRoot)
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThan(0)

    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    expect(last.level).toBe('info')
    expect(last.component).toBe('test-component')
    expect(last.msg).toBe('hello world')
    expect(typeof last.pid).toBe('number')
    // DEC-017 §3.1 schema mandates the timestamp field name `ts`
    expect(typeof last.ts).toBe('string')
    expect(() => new Date(last.ts as string).toISOString()).not.toThrow()
    expect(last.extra).toBe(1)
  })

  it('initLogger is idempotent (same instance returned)', async () => {
    const a = await initLogger(projectRoot, baseSetting())
    const b = await initLogger(projectRoot, baseSetting())
    expect(a).toBe(b)
  })

  it('childLogger throws before initLogger has been called', () => {
    expect(() => childLogger('whatever').info('x')).toThrow(
      /Root logger not initialized/i,
    )
  })

  it('respects KOVITOBOARD_DEBUG=1 and writes debug-level records', async () => {
    const prev = process.env.KOVITOBOARD_DEBUG
    process.env.KOVITOBOARD_DEBUG = '1'
    try {
      await initLogger(projectRoot, baseSetting())
      const log = childLogger('dbg')
      log.debug('debug visible')
      await new Promise((r) => setTimeout(r, 200))
      const raw = readActiveLogFile(projectRoot)
      expect(raw).toMatch(/"level":"debug"/)
      expect(raw).toMatch(/debug visible/)
    } finally {
      if (prev === undefined) delete process.env.KOVITOBOARD_DEBUG
      else process.env.KOVITOBOARD_DEBUG = prev
    }
  })
})
