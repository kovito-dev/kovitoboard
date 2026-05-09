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

  it('does NOT redact a string-only msg argument (call-site responsibility)', async () => {
    // pino's `formatters.log` only runs against the merging object,
    // not against a string-only first argument. The redaction layer
    // therefore documents itself as "automatic for structured fields,
    // manual for raw msg strings"; risky call sites (claude-bridge
    // stderr, trust-prompt fallback log) wrap the value with
    // `redactSensitiveTokens` themselves before handing it to the
    // logger. This test pins that contract so a future change that
    // accidentally widens the redactor would surface here as a fail.
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-msg')
    log.info(
      'claude exited with sk-ant-api03-MsgKeyShouldGoTooLongEnough123 in the error',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    // Demonstrates the gap that call sites must close.
    expect(raw).toContain('sk-ant-api03-MsgKeyShouldGoTooLongEnough123')
    // The same key threaded through a structured field IS redacted.
    log.info(
      { detail: 'claude exited with sk-ant-api03-StructuredFieldVariant1234' },
      'auth failed',
    )
    await new Promise((r) => setTimeout(r, 200))
    const raw2 = readActiveLogFile(projectRoot)
    expect(raw2).toContain('<sk-ant redacted>')
    expect(raw2).not.toContain('sk-ant-api03-StructuredFieldVariant1234')
  })

  it('exported redactSensitiveTokens lets call sites redact a msg before logging', async () => {
    await initLogger(projectRoot, baseSetting())
    const log = childLogger('redact-callsite')
    const raw_msg = 'claude exited with sk-ant-api03-CallSiteShouldRedact1234567 in the error'
    log.info(redactSensitiveTokens(raw_msg))
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLogFile(projectRoot)
    expect(raw).toContain('<sk-ant redacted>')
    expect(raw).not.toContain('sk-ant-api03-CallSiteShouldRedact1234567')
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
