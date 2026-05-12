/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Audit Logger — records audit logs for handler invocations.
 *
 * Appends entries in JSONL format to app/data/{recipe-id}/_audit.log.
 * Only SHA-256 hashes of arguments are recorded (raw arguments are never logged).
 *
 * @see recipe-system.md §12-6
 * @see recipe-backend-implementation-plan.md Phase F
 * @stable v0.1.0
 */

import { createHash } from 'crypto'
import { join } from 'path'
import {
  appendFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'fs'
import type { AuditLogEntry } from './handlers/types.js'
import { AUDIT_LOG_LIMITS } from './handlers/types.js'
import { lazyChildLogger } from './logger.js'
import type { CaptureKind, TrustLevel } from './recipe/apiTypes.js'

// `lazyChildLogger` is used so unit tests that import this module
// without booting the full server (and hence without initLogger())
// don't crash at import time. Live emission still routes through the
// real pino logger after initLogger() has run.
const auditLog = lazyChildLogger('audit-logger')

// =========================================
// Public API
// =========================================

/**
 * Write an audit log entry.
 *
 * On write failure, records a structured error via the central logger
 * but does not throw, so as not to interrupt the dispatcher's
 * processing.
 */
export function writeAuditLog(
  entry: AuditLogEntry,
  projectRoot: string,
): void {
  try {
    // Audit logs are keyed by `appId` (= `app/data/<appId>/_audit.log`)
    // so each installed app instance keeps its own log even when
    // two apps share a `recipeId`.
    const logPath = getAuditLogPath(entry.appId, projectRoot)
    ensureDir(join(projectRoot, 'app', 'data', entry.appId))

    // Check for rotation
    rotateIfNeeded(logPath)

    // Append JSONL entry
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(logPath, line, 'utf-8')
  } catch (err) {
    auditLog.error(
      { err, appId: entry.appId, recipeId: entry.recipeId },
      'Failed to write audit log',
    )
  }
}

/**
 * Convert handler invocation arguments to a SHA-256 hash.
 * Raw arguments are never stored in the log.
 */
export function hashArgs(args: unknown): string {
  const canonical = JSON.stringify(args ?? {})
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Helper to construct an AuditLogEntry.
 *
 * `appId` and `recipeId` are accepted as separate parameters: the
 * audit log directory is keyed by `appId` (the KB-local identifier
 * that owns the data root) while `recipeId` records the recipe
 * lineage so two installed apps sharing a recipe stay
 * distinguishable in the audit trail.
 *
 * Phase A scaffolding: callers that only have a `recipeId` today
 * can pass it for both fields; Phase E swaps the dispatcher /
 * caller path to provide a real `appId`.
 */
export function createAuditEntry(params: {
  appId: string
  recipeId: string
  callId: string
  handler: AuditLogEntry['handler']
  args: unknown
  result: 'ok' | 'error'
  errorCode?: AuditLogEntry['errorCode']
  durationMs: number
}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    appId: params.appId,
    recipeId: params.recipeId,
    callId: params.callId,
    handler: params.handler,
    argsHash: hashArgs(params.args),
    result: params.result,
    errorCode: params.errorCode,
    durationMs: params.durationMs,
  }
}

// =========================================
// Capture-call audit log (v0.2.0)
// =========================================

/**
 * Schema for a single capture-call audit entry.
 *
 * Written as JSONL to `app/data/<appId>/_capture-audit.log` so the
 * handler-call audit log (`_audit.log`, `AuditLogEntry`) stays
 * untouched while we still record every accept / refuse decision on
 * `/api/app/capture/<kind>`. The two files share the rotation /
 * directory conventions of {@link writeAuditLog}.
 *
 * @see recipe-system.md v1.4 §6.10.5
 * @see http-api-contract.md v1.3 §10.6.6
 * @stable v0.2.0
 */
export interface CaptureAuditEntry {
  /** ISO 8601 timestamp */
  timestamp: string
  /** KB-local app identifier (same axis as `_audit.log`'s `appId`) */
  appId: string
  /** Recipe lineage id (active manifest's `recipeId`) */
  recipeId: string
  /** Capture kind that was requested */
  kind: CaptureKind
  /**
   * Trust level captured from the active manifest at decision time.
   * Always present even on rejects so the audit trail can surface
   * "grandfather (unknown) recipe attempted capture" without a join
   * back to the manifest store.
   */
  trustLevel: TrustLevel
  /** Decision the endpoint emitted */
  result: 'success' | 'rejected'
  /**
   * Machine-readable refusal reason. Mirrors the `error` field of
   * the 403 response body so log readers can correlate the two
   * without parsing free-form text.
   */
  reason?: 'CaptureNotDeclared' | 'CaptureNotApproved' | 'NoActiveRecipe'
}

/**
 * Append one entry to the capture-call audit log.
 *
 * On write failure the function records a structured error via the
 * lazy child logger but does not throw — the capture endpoint must
 * still respond to the client.
 *
 * Refuse paths that have no resolved `appId` (the `NoActiveRecipe`
 * case) skip the file write entirely so we never have to invent a
 * placeholder directory. The endpoint records those events through
 * the central logger instead.
 */
export function writeCaptureAuditLog(
  entry: CaptureAuditEntry,
  projectRoot: string,
): void {
  try {
    const logPath = getCaptureAuditLogPath(entry.appId, projectRoot)
    ensureDir(join(projectRoot, 'app', 'data', entry.appId))

    rotateIfNeeded(logPath)

    const line = JSON.stringify(entry) + '\n'
    appendFileSync(logPath, line, 'utf-8')
  } catch (err) {
    auditLog.error(
      { err, appId: entry.appId, recipeId: entry.recipeId, kind: entry.kind },
      'Failed to write capture-audit log',
    )
  }
}

function getCaptureAuditLogPath(appId: string, projectRoot: string): string {
  return join(projectRoot, 'app', 'data', appId, '_capture-audit.log')
}

// =========================================
// Internal helpers
// =========================================

function getAuditLogPath(appId: string, projectRoot: string): string {
  return join(projectRoot, 'app', 'data', appId, '_audit.log')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Rotate the log file when its size exceeds the limit.
 *
 * _audit.log -> _audit.log.1 -> _audit.log.2 -> _audit.log.3 (deleted)
 * Reused by both `_audit.log` and `_capture-audit.log` so the two
 * files share generation handling and ceiling.
 */
function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return

  try {
    const stat = statSync(logPath)
    if (stat.size < AUDIT_LOG_LIMITS.MAX_SIZE) return
  } catch {
    return // Ignore stat failures
  }

  // Delete the oldest generation. Failure here is non-fatal — the
  // worst case is one extra rotated file lingering until the next
  // round — but record a warn so chronic rotation breakage shows up.
  const maxGen = AUDIT_LOG_LIMITS.MAX_GENERATIONS
  const oldest = `${logPath}.${maxGen}`
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest)
    } catch (err) {
      auditLog.warn({ err, target: oldest }, 'Failed to delete old audit log')
    }
  }

  // Generation shift: .2 -> .3, .1 -> .2, current -> .1
  for (let i = maxGen - 1; i >= 1; i--) {
    const from = `${logPath}.${i}`
    const to = `${logPath}.${i + 1}`
    if (existsSync(from)) {
      try {
        renameSync(from, to)
      } catch (err) {
        auditLog.warn({ err, from, to }, 'Audit log rotation rename failed')
      }
    }
  }

  // current -> .1
  try {
    renameSync(logPath, `${logPath}.1`)
  } catch (err) {
    auditLog.warn({ err, logPath }, 'Initial audit log rotation failed')
  }
}
