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

// =========================================
// Public API
// =========================================

/**
 * Write an audit log entry.
 *
 * On write failure, logs a warning via console.error but does not throw,
 * so as not to interrupt the dispatcher's processing.
 */
export function writeAuditLog(
  entry: AuditLogEntry,
  projectRoot: string,
): void {
  try {
    const logPath = getAuditLogPath(entry.recipeId, projectRoot)
    ensureDir(join(projectRoot, 'app', 'data', entry.recipeId))

    // Check for rotation
    rotateIfNeeded(logPath)

    // Append JSONL entry
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(logPath, line, 'utf-8')
  } catch (err) {
    console.error(`[audit-logger] Failed to write audit log for recipe "${entry.recipeId}":`, err)
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
 */
export function createAuditEntry(params: {
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
// Internal helpers
// =========================================

function getAuditLogPath(recipeId: string, projectRoot: string): string {
  return join(projectRoot, 'app', 'data', recipeId, '_audit.log')
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
 */
function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return

  try {
    const stat = statSync(logPath)
    if (stat.size < AUDIT_LOG_LIMITS.MAX_SIZE) return
  } catch {
    return // Ignore stat failures
  }

  // Delete the oldest generation
  const maxGen = AUDIT_LOG_LIMITS.MAX_GENERATIONS
  const oldest = `${logPath}.${maxGen}`
  if (existsSync(oldest)) {
    try { unlinkSync(oldest) } catch { /* ignore */ }
  }

  // Generation shift: .2 -> .3, .1 -> .2, current -> .1
  for (let i = maxGen - 1; i >= 1; i--) {
    const from = `${logPath}.${i}`
    const to = `${logPath}.${i + 1}`
    if (existsSync(from)) {
      try { renameSync(from, to) } catch { /* ignore */ }
    }
  }

  // current → .1
  try { renameSync(logPath, `${logPath}.1`) } catch { /* ignore */ }
}
