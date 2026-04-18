/**
 * Audit Logger — handler 呼び出しの監査ログ記録.
 *
 * app/data/{recipe-id}/_audit.log に JSONL 形式で追記する。
 * 引数は SHA-256 ハッシュのみ記録（生の引数はログしない）。
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
 * 監査ログエントリを記録する.
 *
 * 書き込み失敗時は console.error で警告し、例外は投げない。
 * dispatcher 側の処理を中断させないため。
 */
export function writeAuditLog(
  entry: AuditLogEntry,
  projectRoot: string,
): void {
  try {
    const logPath = getAuditLogPath(entry.recipeId, projectRoot)
    ensureDir(join(projectRoot, 'app', 'data', entry.recipeId))

    // ローテーション確認
    rotateIfNeeded(logPath)

    // JSONL 追記
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(logPath, line, 'utf-8')
  } catch (err) {
    console.error(`[audit-logger] Failed to write audit log for recipe "${entry.recipeId}":`, err)
  }
}

/**
 * handler 呼び出しの引数を SHA-256 ハッシュに変換する.
 * 生の引数はログに残さない。
 */
export function hashArgs(args: unknown): string {
  const canonical = JSON.stringify(args ?? {})
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * AuditLogEntry を組み立てるヘルパ.
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
 * ファイルサイズが上限を超えた場合にローテーションする.
 *
 * _audit.log → _audit.log.1 → _audit.log.2 → _audit.log.3（削除）
 */
function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return

  try {
    const stat = statSync(logPath)
    if (stat.size < AUDIT_LOG_LIMITS.MAX_SIZE) return
  } catch {
    return // stat 失敗は無視
  }

  // 最古の世代を削除
  const maxGen = AUDIT_LOG_LIMITS.MAX_GENERATIONS
  const oldest = `${logPath}.${maxGen}`
  if (existsSync(oldest)) {
    try { unlinkSync(oldest) } catch { /* ignore */ }
  }

  // 世代シフト: .2 → .3, .1 → .2, current → .1
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
