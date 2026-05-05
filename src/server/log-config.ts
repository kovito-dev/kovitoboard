/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Logger configuration resolver (DEC-017).
 *
 * Resolves the effective logging configuration for KovitoBoard from:
 *
 * 1. Environment variables (highest priority)
 *    - KOVITOBOARD_DEBUG=1                    -> level: 'debug'
 *    - KOVITOBOARD_LOG_RETENTION_DAYS=<n>     -> retentionDays
 * 2. .kovitoboard/setting.json `logging.retentionDays`
 * 3. Defaults (level: 'info', retentionDays: 7)
 *
 * Out-of-range retention values (non-numeric, < 1, > 365) are clamped
 * to the default 7 with a `console.warn` (the logger is not yet
 * initialized at this point, so console.warn is intentional).
 *
 * This module deliberately does not import the logger to avoid a
 * circular dependency.
 */
import type { KovitoboardSetting } from '../shared/setting-types'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogConfig {
  level: LogLevel
  retentionDays: number
}

const DEFAULT_RETENTION_DAYS = 7
const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 365

/**
 * Clamp a retention-day value into the allowed range. Returns the
 * default (7) for any non-finite, non-positive, or out-of-range value.
 *
 * Emits a console.warn when an explicit but invalid value is supplied
 * so misconfigured environments are visible at startup.
 */
export function clampRetention(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_RETENTION_DAYS
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (
    !Number.isFinite(n) ||
    n < MIN_RETENTION_DAYS ||
    n > MAX_RETENTION_DAYS
  ) {
    // Logger is not yet initialized at config-resolution time; using
    // console.warn here is intentional (DEC-017 §5.2).
    console.warn(
      `[log-config] Invalid retentionDays value "${String(value)}", falling back to default ${DEFAULT_RETENTION_DAYS}`,
    )
    return DEFAULT_RETENTION_DAYS
  }
  return Math.floor(n)
}

/**
 * Resolve the effective LogConfig from env + setting.json + defaults.
 *
 * The setting argument is supplied by the caller (typically read via
 * setting-manager.readSetting()) so this module stays free of fs
 * concerns and is trivially unit-testable.
 */
export function resolveLogConfig(
  setting: KovitoboardSetting | null,
  env: NodeJS.ProcessEnv = process.env,
): LogConfig {
  const debug = env.KOVITOBOARD_DEBUG === '1'
  const envRetention = env.KOVITOBOARD_LOG_RETENTION_DAYS

  let retention: number
  if (envRetention !== undefined && envRetention !== '') {
    retention = clampRetention(envRetention)
  } else if (setting?.logging?.retentionDays !== undefined) {
    retention = clampRetention(setting.logging.retentionDays)
  } else {
    retention = DEFAULT_RETENTION_DAYS
  }

  return {
    level: debug ? 'debug' : 'info',
    retentionDays: retention,
  }
}
