/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for `globalThis.kbContext.logger(...)` (DEC-017 v1.3 P6-1).
 *
 * Verifies that:
 *  - `setupKbContext()` installs the contract on globalThis.
 *  - The returned logger tags records with `app.<component>` (the
 *    `app.` prefix is added by the platform; user passes only the
 *    component name).
 *  - Invalid component names are rejected at first call.
 *  - The contract surface remains the four pino-shaped methods.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetKbContextForTests,
  _resetLoggerForTests,
  initLogger,
  setupKbContext,
  type KbContext,
} from '../../src/server/logger'
import type { KovitoboardSetting } from '../../src/shared/setting-types'

const baseSetting = (): KovitoboardSetting => ({
  version: '1.1',
  user: { displayName: 'tester', avatar: null },
  project: { name: 'p', description: 'd', path: '/tmp/p' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
})

function readActiveLog(projectRoot: string): string {
  const dir = join(projectRoot, '.kovitoboard', 'logs')
  const entries = readdirSync(dir).filter(
    (f) => f.startsWith('server.') && f.endsWith('.log'),
  )
  entries.sort()
  return readFileSync(join(dir, entries[entries.length - 1]), 'utf-8')
}

describe('kbContext / installation', () => {
  beforeEach(() => {
    _resetKbContextForTests()
  })

  afterEach(() => {
    _resetKbContextForTests()
  })

  it('attaches a kbContext object to globalThis with a logger() method', () => {
    setupKbContext()
    const ctx = (globalThis as { kbContext?: KbContext }).kbContext
    expect(ctx).toBeDefined()
    expect(typeof ctx!.logger).toBe('function')
  })

  it('replaces an existing context idempotently (no throw on second call)', () => {
    setupKbContext()
    expect(() => setupKbContext()).not.toThrow()
  })
})

describe('kbContext.logger / validation', () => {
  beforeEach(() => {
    _resetKbContextForTests()
    setupKbContext()
  })

  afterEach(() => {
    _resetKbContextForTests()
  })

  it('rejects an empty component name', () => {
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    expect(() => ctx.logger('')).toThrow(/invalid component name/)
  })

  it('rejects a component name longer than 64 chars', () => {
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    expect(() => ctx.logger('x'.repeat(65))).toThrow(/invalid component name/)
  })

  it('rejects a non-string component', () => {
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    // @ts-expect-error — exercising the runtime guard
    expect(() => ctx.logger(123)).toThrow(/invalid component name/)
  })

  it('accepts a 64-char component name (boundary, validation only)', () => {
    // initLogger() is intentionally not called in this describe block,
    // so childLogger() will throw with a "Root logger not initialized"
    // message. The point of this case is to confirm the validation
    // guard does NOT short-circuit on a 64-char component (the only
    // thrown error must be the post-validation initialization one).
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    expect(() => ctx.logger('a'.repeat(64))).toThrow(/Root logger not initialized/)
    expect(() => ctx.logger('a'.repeat(64))).not.toThrow(/invalid component name/)
  })
})

describe('kbContext.logger / log emission', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-kbctx-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
    _resetKbContextForTests()
    await initLogger(projectRoot, baseSetting())
    setupKbContext()
  })

  afterEach(() => {
    _resetKbContextForTests()
    _resetLoggerForTests()
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('emits records tagged with component "app.<name>"', async () => {
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    const log = ctx.logger('research-reports')
    log.info({ jobId: 'j-1' }, 'started')
    await new Promise((r) => setTimeout(r, 200))

    const raw = readActiveLog(projectRoot)
    const lines = raw.split('\n').filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    expect(last.component).toBe('app.research-reports')
    expect(last.level).toBe('info')
    expect(last.msg).toBe('started')
    expect(last.jobId).toBe('j-1')
  })

  it('exposes debug / info / warn / error', () => {
    const ctx = (globalThis as { kbContext: KbContext }).kbContext
    const log = ctx.logger('demo')
    expect(typeof log.debug).toBe('function')
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
  })
})
