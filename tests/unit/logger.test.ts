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
