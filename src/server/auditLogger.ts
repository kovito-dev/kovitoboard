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
 * Spec-mandated capture decision reasons (v0.2.0 / spec v1.6
 * §6.10.5). The endpoint records exactly one of these for every
 * `/api/app/capture/*` request — both the 200 accept path and the
 * 403 reject paths.
 *
 * v1.6 added the `capture-token-*` family for the per-recipe-page
 * launch-scoped capture token mechanism
 * (`recipe-system.md` v1.6 §6.10.6 / `http-api-contract.md` v1.4
 * §10.6.7). `unresolved-appid` is retained for v1.3.1 backward
 * compatibility but the v1.4+ runtime no longer routes through it
 * because `req.body.appId` is ignored end-to-end (I-CR4).
 *
 * @see recipe-system.md v1.6 §6.10.5
 * @see http-api-contract.md v1.4 §10.6.6
 */
export type CaptureAuditReason =
  | 'approved'
  | 'not-approved'
  | 'not-declared'
  | 'capture-token-missing'
  | 'capture-token-invalid'
  | 'capture-token-expired'
  | 'no-matching-manifest'
  | 'no-active-recipe'
  | 'unresolved-appid'

/**
 * Schema for a single capture-call audit entry.
 *
 * Written as JSONL to:
 *   - `app/data/<appId>/_capture-audit.log` when the request
 *     resolved to a known appId.
 *   - `app/_unresolved-capture-audit.log` (global sink) when the
 *     appId could not be resolved (forged or missing on the wire).
 *
 * Both file types share the rotation / directory conventions of
 * {@link writeAuditLog} so the handler-call audit log
 * (`_audit.log`, `AuditLogEntry`) stays untouched while we still
 * record every accept / refuse decision on
 * `/api/app/capture/<kind>`.
 *
 * @see recipe-system.md v1.5 §6.10.5
 * @see http-api-contract.md v1.3.1 §10.6.6
 * @stable v0.2.0
 */
export interface CaptureAuditEntry {
  /** ISO 8601 timestamp */
  timestamp: string
  /**
   * KB-local app identifier. `null` for refuse paths that did not
   * resolve to a manifest (`unresolved-appid` /
   * `no-active-recipe`); those entries land in the global sink so
   * forged / probing requests stay visible.
   */
  appId: string | null
  /**
   * Recipe lineage id (active manifest's `recipeId`). `null` when
   * the request failed before manifest lookup.
   */
  recipeId: string | null
  /**
   * Capture kind that was requested. `null` when the path segment
   * was outside the closed `CaptureKind` enum — the raw value is
   * carried on `rawKind` instead so the audit trail can still
   * surface unknown-literal probes without losing the input.
   */
  kind: CaptureKind | null
  /**
   * Path segment as it arrived on the wire, truncated to a safe
   * length. Always present so unknown-literal probes
   * (`reason: 'not-declared'` with `kind: null`) can be traced
   * back to the offending request.
   */
  rawKind: string
  /**
   * Trust level captured from the active manifest at decision time.
   * `null` when no manifest was resolved.
   */
  trustLevel: TrustLevel | null
  /** Decision the endpoint emitted */
  result: 'success' | 'rejected'
  /**
   * Spec-mandated refusal reason. Always present so log readers
   * can dispatch on the value without parsing free-form text.
   */
  reason: CaptureAuditReason
}

/**
 * Append one entry to the capture-call audit log.
 *
 * On write failure the function records a structured error via the
 * lazy child logger but does not throw — the capture endpoint must
 * still respond to the client.
 *
 * Routing rules (v1.5 §10.6.5):
 *   - `entry.appId === null` → write to the global sink
 *     (`app/_unresolved-capture-audit.log`). Used by
 *     `unresolved-appid` and `no-active-recipe` paths.
 *   - `entry.appId === <string>` → write to the per-app file
 *     (`app/data/<appId>/_capture-audit.log`). Used by every
 *     decision path that successfully resolved a manifest.
 */
export function writeCaptureAuditLog(
  entry: CaptureAuditEntry,
  projectRoot: string,
): void {
  try {
    const logPath = getCaptureAuditLogPath(entry.appId, projectRoot)
    if (entry.appId !== null) {
      ensureDir(join(projectRoot, 'app', 'data', entry.appId))
    } else {
      ensureDir(join(projectRoot, 'app'))
    }

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

function getCaptureAuditLogPath(
  appId: string | null,
  projectRoot: string,
): string {
  if (appId === null) {
    return join(projectRoot, 'app', '_unresolved-capture-audit.log')
  }
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
