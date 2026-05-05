/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Server-side `client_log` handler validation suite.
 *
 * `handleClientLog` is not exported from `src/server/index.ts`
 * (it lives inside the WS message handler). To exercise it without
 * spinning up the full HTTP server, we replicate the validation +
 * truncation logic in this test against the same constants and
 * verify the contract directly via `childLogger`.
 *
 * If the server-side handler is later refactored into a separately
 * exported function, this suite should be migrated to import it
 * directly. The shape is structured so that migration is mechanical:
 * just replace `localHandleClientLog` below with the imported version.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetLoggerForTests,
  childLogger,
  initLogger,
} from '../../src/server/logger'
import type { KovitoboardSetting } from '../../src/shared/setting-types'
import type { ClientLogPayload } from '../../src/shared/ws-events'

const baseSetting = (): KovitoboardSetting => ({
  version: '1.1',
  user: { displayName: 'tester', avatar: null },
  project: { name: 'p', description: 'd', path: '/tmp/p' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
})

/**
 * Local copy of the server-side handler — keep in sync with
 * `handleClientLog` in src/server/index.ts.
 */
const CLIENT_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const CLIENT_LOG_COMPONENT_MAX = 64
const CLIENT_LOG_MSG_MAX = 4096
const CLIENT_LOG_DATA_MAX_BYTES = 4096

function localHandleClientLog(payload: ClientLogPayload | undefined): void {
  if (!payload || typeof payload !== 'object') return
  const { level, component, msg } = payload
  let { data } = payload
  if (typeof level !== 'string' || !CLIENT_LOG_LEVELS.has(level)) return
  if (
    typeof component !== 'string' ||
    component.length === 0 ||
    component.length > CLIENT_LOG_COMPONENT_MAX
  ) return
  if (typeof msg !== 'string' || msg.length > CLIENT_LOG_MSG_MAX) return
  if (data !== undefined && data !== null) {
    if (typeof data !== 'object') return
    try {
      const json = JSON.stringify(data)
      if (json.length > CLIENT_LOG_DATA_MAX_BYTES) {
        childLogger('ws').warn(
          { sourceComponent: component, originalSize: json.length },
          'client_log payload truncated (>4KB)',
        )
        data = {
          _truncated: true,
          _original_size: json.length,
          _excerpt: json.slice(0, CLIENT_LOG_DATA_MAX_BYTES - 96) + '...[truncated]',
        }
      }
    } catch {
      data = { _serializeFailed: true }
    }
  }
  const cl = childLogger(`client.${component}`)
  ;(cl as unknown as Record<string, (obj: unknown, msg?: string) => void>)[level](
    data ?? {},
    msg,
  )
}

function readActiveLog(projectRoot: string): string {
  const dir = join(projectRoot, '.kovitoboard', 'logs')
  const entries = readdirSync(dir).filter(
    (f) => f.startsWith('server.') && f.endsWith('.log'),
  )
  entries.sort()
  return readFileSync(join(dir, entries[entries.length - 1]), 'utf-8')
}

describe('client_log handler / happy path', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-clientlog-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
    await initLogger(projectRoot, baseSetting())
  })

  afterEach(() => {
    _resetLoggerForTests()
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  it('writes a client.<component> record at the requested level', async () => {
    localHandleClientLog({
      level: 'warn',
      component: 'useIPC',
      msg: 'load failed',
      data: { code: 500 },
    })
    await new Promise((r) => setTimeout(r, 200))

    const raw = readActiveLog(projectRoot)
    const lines = raw.split('\n').filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    expect(last.level).toBe('warn')
    expect(last.component).toBe('client.useIPC')
    expect(last.msg).toBe('load failed')
    expect(last.code).toBe(500)
  })

  it('omits the data fields when payload.data is absent', async () => {
    localHandleClientLog({ level: 'info', component: 'x', msg: 'plain' })
    await new Promise((r) => setTimeout(r, 200))
    const raw = readActiveLog(projectRoot)
    const last = JSON.parse(raw.trim().split('\n').pop()!) as Record<string, unknown>
    expect(last.msg).toBe('plain')
    expect(last.component).toBe('client.x')
  })
})

describe('client_log handler / validation drops malformed records', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-clientlog-bad-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
    await initLogger(projectRoot, baseSetting())
    // Seed a known-good entry so we can detect "no record was written"
    localHandleClientLog({ level: 'info', component: 'baseline', msg: 'init' })
    await new Promise((r) => setTimeout(r, 200))
  })

  afterEach(() => {
    _resetLoggerForTests()
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  function lineCount(): number {
    const raw = readActiveLog(projectRoot)
    return raw.split('\n').filter(Boolean).length
  }

  it('drops payload with an unknown level', async () => {
    const before = lineCount()
    // @ts-expect-error — intentionally invalid level
    localHandleClientLog({ level: 'bogus', component: 'x', msg: 'y' })
    await new Promise((r) => setTimeout(r, 100))
    expect(lineCount()).toBe(before)
  })

  it('drops payload with an empty component', async () => {
    const before = lineCount()
    localHandleClientLog({ level: 'info', component: '', msg: 'y' })
    await new Promise((r) => setTimeout(r, 100))
    expect(lineCount()).toBe(before)
  })

  it('drops payload with an over-long component', async () => {
    const before = lineCount()
    localHandleClientLog({
      level: 'info',
      component: 'x'.repeat(CLIENT_LOG_COMPONENT_MAX + 1),
      msg: 'y',
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(lineCount()).toBe(before)
  })

  it('drops payload with an over-long msg', async () => {
    const before = lineCount()
    localHandleClientLog({
      level: 'info',
      component: 'x',
      msg: 'y'.repeat(CLIENT_LOG_MSG_MAX + 1),
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(lineCount()).toBe(before)
  })

  it('drops payload with non-object data', async () => {
    const before = lineCount()
    // @ts-expect-error — intentionally invalid data type
    localHandleClientLog({ level: 'info', component: 'x', msg: 'y', data: 'string' })
    await new Promise((r) => setTimeout(r, 100))
    expect(lineCount()).toBe(before)
  })
})

describe('client_log handler / payload size guard', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'kb-clientlog-size-'))
    mkdirSync(join(projectRoot, '.kovitoboard', 'logs'), { recursive: true })
    _resetLoggerForTests()
    await initLogger(projectRoot, baseSetting())
  })

  afterEach(() => {
    _resetLoggerForTests()
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('truncates data when the JSON exceeds 4KB and emits a warn record', async () => {
    const big = { blob: 'a'.repeat(5000) }
    localHandleClientLog({ level: 'info', component: 'big', msg: 'incoming', data: big })
    await new Promise((r) => setTimeout(r, 200))

    const raw = readActiveLog(projectRoot)
    const lines = raw.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)

    // First line: the warn record about truncation, second: the client log
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    const warnRec = records.find(
      (r) =>
        r.level === 'warn' &&
        typeof r.msg === 'string' &&
        r.msg.includes('truncated'),
    )
    expect(warnRec).toBeTruthy()

    const clientRec = records.find((r) => r.component === 'client.big')
    expect(clientRec).toBeTruthy()
    expect(clientRec!._truncated).toBe(true)
    expect(typeof clientRec!._excerpt).toBe('string')
    expect((clientRec!._excerpt as string).endsWith('...[truncated]')).toBe(true)
  })
})
