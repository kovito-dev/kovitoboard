/**
 * Handler Dispatcher — callId → handler 解決 → scope 検証 → 実行.
 *
 * FE からの kb-call リクエストを受けて、manifest から呼び出し宣言を取得し、
 * scope 検証 → テンプレート展開 → handler 実行 → レスポンス返却 を行う。
 *
 * dispatcher 経由以外の handler 呼び出し経路を作らない。
 * @see recipe-system.md §12-5-2 (実行時 dispatcher フロー)
 * @see recipe-backend-implementation-plan.md §8-2 原則 2
 * @stable v0.1.0
 */

import type {
  HandlerResponse,
  HandlerErrorCode,
  CategoryAHandlerName,
  Scope,
} from './handlers/types.js'
import { handlerError, HANDLER_REQUIRED_SCOPES } from './handlers/types.js'
import type { RecipeManifest, HandlerCallDeclaration } from './recipe/apiTypes.js'
import type { RecipeManifestStore } from './recipeManifestStore.js'
import { getHandler } from './handlers/registry.js'
import {
  validatePathForScope,
  validateScopeOnly,
} from './scopeValidator.js'
import { writeAuditLog, createAuditEntry } from './auditLogger.js'

// =========================================
// Dispatch request / response
// =========================================

export interface DispatchRequest {
  recipeId: string
  callId: string
  input: Record<string, unknown>
}

// =========================================
// Rate limiter (token bucket, per recipeId+callId)
// =========================================

interface BucketEntry {
  tokens: number
  lastRefill: number
}

const rateBuckets = new Map<string, BucketEntry>()

/** デフォルトのレート制限: 60 calls / min (notify は個別に 10/min) */
const DEFAULT_RATE = { tokensPerMin: 60 }
const NOTIFY_RATE = { tokensPerMin: 10 }

function checkRateLimit(
  recipeId: string,
  callId: string,
  handlerName: CategoryAHandlerName,
): boolean {
  const key = `${recipeId}:${callId}`
  const limit = handlerName === 'notify' ? NOTIFY_RATE : DEFAULT_RATE
  const now = Date.now()

  let bucket = rateBuckets.get(key)
  if (!bucket) {
    bucket = { tokens: limit.tokensPerMin, lastRefill: now }
    rateBuckets.set(key, bucket)
  }

  // Token refill
  const elapsed = now - bucket.lastRefill
  const refill = (elapsed / 60_000) * limit.tokensPerMin
  bucket.tokens = Math.min(limit.tokensPerMin, bucket.tokens + refill)
  bucket.lastRefill = now

  if (bucket.tokens < 1) {
    return false // rate limited
  }

  bucket.tokens -= 1
  return true
}

// =========================================
// Template expansion
// =========================================

/**
 * テンプレート引数を展開する.
 *
 * 文字列中の `${input.xxx}` を input オブジェクトの値で置換する。
 * ネストしたオブジェクト内も再帰的に展開する。
 *
 * @returns 展開後の引数オブジェクト
 * @throws Error if input.xxx is undefined
 */
export function expandTemplate(
  args: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!args) return { ...input }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(args)) {
    result[key] = expandValue(value, input)
  }

  return result
}

function expandValue(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return expandString(value, input)
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandValue(v, input))
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = expandValue(v, input)
    }
    return result
  }
  return value // number, boolean, null
}

function expandString(template: string, input: Record<string, unknown>): unknown {
  // 完全一致パターン: "${input.xxx}" のみ → 型を保持して返す
  const fullMatch = template.match(/^\$\{input\.([a-zA-Z0-9_.]+)\}$/)
  if (fullMatch) {
    const key = fullMatch[1]
    const value = getNestedValue(input, key)
    if (value === undefined) {
      throw new TemplateExpansionError(`Template variable "input.${key}" is undefined`)
    }
    return value
  }

  // 部分置換パターン: "prefix/${input.xxx}/suffix" → 文字列として結合
  return template.replace(/\$\{input\.([a-zA-Z0-9_.]+)\}/g, (_match, key: string) => {
    const value = getNestedValue(input, key)
    if (value === undefined) {
      throw new TemplateExpansionError(`Template variable "input.${key}" is undefined`)
    }
    return String(value)
  })
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export class TemplateExpansionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateExpansionError'
  }
}

// =========================================
// Dispatcher
// =========================================

/** handler がパス引数を取るかを判定 */
const HANDLERS_WITH_PATH: Set<CategoryAHandlerName> = new Set([
  'list-files',
  'read-file',
  'write-file',
])

/**
 * handler 呼び出しを dispatch する.
 *
 * @see recipe-system.md §12-5-2 の 1〜8 ステップに対応
 */
export async function dispatch(
  request: DispatchRequest,
  manifestStore: RecipeManifestStore,
  projectRoot: string,
  kovitoboardRoot?: string,
): Promise<HandlerResponse<unknown>> {
  const { recipeId, callId, input } = request

  // 1. manifest ロード
  const manifest = manifestStore.get(recipeId)
  if (!manifest) {
    return handlerError('HandlerNotDeclared', `No manifest found for recipe "${recipeId}"`)
  }

  // 2. api.calls[id=callId] 検索
  const callDecl = manifest.api.calls.find((c) => c.id === callId)
  if (!callDecl) {
    return handlerError('HandlerNotDeclared', `Call "${callId}" is not declared in recipe "${recipeId}"`)
  }

  // 3. handler registry から実装を取得
  const handlerName = callDecl.handler
  const handlerDef = getHandler(handlerName)
  if (!handlerDef) {
    return handlerError('Internal', `Handler "${handlerName}" is not registered`)
  }

  // 4. args テンプレート展開
  let expandedArgs: Record<string, unknown>
  try {
    expandedArgs = expandTemplate(callDecl.args, input)
  } catch (err) {
    if (err instanceof TemplateExpansionError) {
      return handlerError('InvalidArgs', err.message)
    }
    throw err
  }

  // 5. scope 検証
  const requiredScopes = HANDLER_REQUIRED_SCOPES[handlerName]
  const approvedScopes = manifest.approvedScopes

  if (HANDLERS_WITH_PATH.has(handlerName)) {
    // パス引数を持つ handler: パス × scope の交差検証
    const pathArg = expandedArgs.path
    if (typeof pathArg !== 'string') {
      return handlerError('InvalidArgs', '"path" argument must be a string')
    }
    const pathValidation = validatePathForScope(
      pathArg,
      approvedScopes,
      requiredScopes,
      recipeId,
      projectRoot,
      kovitoboardRoot,
    )
    if (!pathValidation.ok) {
      return handlerError(
        pathValidation.failedCode!,
        `Path "${pathArg}" is not allowed: ${pathValidation.failedCode}`,
      )
    }
  } else {
    // パス引数なし handler: scope のみ検証
    const scopeValidation = validateScopeOnly(approvedScopes, requiredScopes)
    if (!scopeValidation.ok) {
      return handlerError(
        scopeValidation.failedCode!,
        `Scope violation: handler "${handlerName}" requires one of [${requiredScopes.join(', ')}]`,
      )
    }
  }

  // 6. 引数バリデーション
  const validationError = handlerDef.validate(expandedArgs)
  if (validationError) {
    return handlerError('InvalidArgs', validationError)
  }

  // 7. レート制限チェック
  if (!checkRateLimit(recipeId, callId, handlerName)) {
    return handlerError('RateLimited', `Rate limit exceeded for "${callId}"`)
  }

  // 8. handler 実行 + 監査ログ
  const startTime = Date.now()
  try {
    const result = await handlerDef.execute(expandedArgs, {
      projectRoot,
      recipeId,
      approvedScopes,
    })
    const durationMs = Date.now() - startTime

    // 監査ログ（成功 / handler 内エラー）
    writeAuditLog(
      createAuditEntry({
        recipeId,
        callId,
        handler: handlerName,
        args: expandedArgs,
        result: result.ok ? 'ok' : 'error',
        errorCode: result.ok ? undefined : result.error.code as HandlerErrorCode,
        durationMs,
      }),
      projectRoot,
    )

    return result
  } catch (err) {
    const durationMs = Date.now() - startTime
    console.error(`[dispatcher] Handler "${handlerName}" threw:`, err)

    // 監査ログ（例外）
    writeAuditLog(
      createAuditEntry({
        recipeId,
        callId,
        handler: handlerName,
        args: expandedArgs,
        result: 'error',
        errorCode: 'Internal',
        durationMs,
      }),
      projectRoot,
    )

    return handlerError('Internal', `Handler execution failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * テスト用: レートリミッタをリセットする.
 */
export function resetRateLimiter(): void {
  rateBuckets.clear()
}
