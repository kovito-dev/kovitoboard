/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampRetention, resolveLogConfig } from '../../src/server/log-config'
import type { KovitoboardSetting } from '../../src/shared/setting-types'

const baseSetting = (overrides: Partial<KovitoboardSetting> = {}): KovitoboardSetting => ({
  version: '1.1',
  user: { displayName: 'tester', avatar: null },
  project: { name: 'p', description: 'd', path: '/tmp/p' },
  locale: 'ja',
  onboarding: { completedAt: null, wizardVersion: '0.1.0' },
  ...overrides,
})

describe('log-config / clampRetention', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the default 7 for undefined / null / empty string without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(clampRetention(undefined)).toBe(7)
    expect(clampRetention(null)).toBe(7)
    expect(clampRetention('')).toBe(7)
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the input value when it is in range (numeric or string)', () => {
    expect(clampRetention(1)).toBe(1)
    expect(clampRetention(7)).toBe(7)
    expect(clampRetention(14)).toBe(14)
    expect(clampRetention(365)).toBe(365)
    expect(clampRetention('14')).toBe(14)
    // floors fractions
    expect(clampRetention(7.9)).toBe(7)
  })

  it('clamps out-of-range values to the default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(clampRetention(0)).toBe(7)
    expect(clampRetention(366)).toBe(7)
    expect(clampRetention(-1)).toBe(7)
    expect(clampRetention('foo')).toBe(7)
    expect(clampRetention(NaN)).toBe(7)
    // 5 explicit invalid inputs -> 5 warnings
    expect(warn).toHaveBeenCalledTimes(5)
  })
})

describe('log-config / resolveLogConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns defaults when setting and env are empty', () => {
    expect(resolveLogConfig(null, {})).toEqual({
      level: 'info',
      retentionDays: 7,
    })
  })

  it('reads retentionDays from setting.logging when env is unset', () => {
    const setting = baseSetting({ logging: { retentionDays: 14 } })
    expect(resolveLogConfig(setting, {})).toEqual({
      level: 'info',
      retentionDays: 14,
    })
  })

  it('env KOVITOBOARD_LOG_RETENTION_DAYS overrides setting', () => {
    const setting = baseSetting({ logging: { retentionDays: 14 } })
    expect(
      resolveLogConfig(setting, { KOVITOBOARD_LOG_RETENTION_DAYS: '30' }),
    ).toEqual({ level: 'info', retentionDays: 30 })
  })

  it('KOVITOBOARD_DEBUG=1 sets level to debug', () => {
    expect(resolveLogConfig(null, { KOVITOBOARD_DEBUG: '1' })).toEqual({
      level: 'debug',
      retentionDays: 7,
    })
  })

  it('KOVITOBOARD_DEBUG values other than "1" leave level at info', () => {
    expect(resolveLogConfig(null, { KOVITOBOARD_DEBUG: 'true' }).level).toBe('info')
    expect(resolveLogConfig(null, { KOVITOBOARD_DEBUG: '0' }).level).toBe('info')
    expect(resolveLogConfig(null, { KOVITOBOARD_DEBUG: '' }).level).toBe('info')
  })

  it('out-of-range env value falls back to default with warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setting = baseSetting({ logging: { retentionDays: 14 } })
    const cfg = resolveLogConfig(setting, { KOVITOBOARD_LOG_RETENTION_DAYS: '9999' })
    expect(cfg.retentionDays).toBe(7)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('out-of-range setting value falls back to default with warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setting = baseSetting({ logging: { retentionDays: -5 } })
    const cfg = resolveLogConfig(setting, {})
    expect(cfg.retentionDays).toBe(7)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
