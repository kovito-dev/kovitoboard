/**
 * Handler Dispatcher — resolves callId to handler, validates scope, and executes.
 *
 * Receives kb-call requests from the FE, retrieves call declarations from the manifest,
 * then performs scope validation -> template expansion -> handler execution -> response.
 *
 * No handler invocation path should exist outside of this dispatcher.
 * @see recipe-system.md §12-5-2 (runtime dispatcher flow)
 * @see recipe-backend-implementation-plan.md §8-2 principle 2
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

/** Default rate limit: 60 calls/min (notify is individually limited to 10/min) */
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
 * Expand template arguments.
 *
 * Replaces `${input.xxx}` in strings with values from the input object.
 * Recursively expands nested objects.
 *
 * @returns The expanded arguments object
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
  // Exact match pattern: "${input.xxx}" only -> return with type preserved
  const fullMatch = template.match(/^\$\{input\.([a-zA-Z0-9_.]+)\}$/)
  if (fullMatch) {
    const key = fullMatch[1]
    const value = getNestedValue(input, key)
    if (value === undefined) {
      throw new TemplateExpansionError(`Template variable "input.${key}" is undefined`)
    }
    return value
  }

  // Partial replacement pattern: "prefix/${input.xxx}/suffix" -> concatenate as string
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

/** Determine whether a handler takes a path argument */
const HANDLERS_WITH_PATH: Set<CategoryAHandlerName> = new Set([
  'list-files',
  'read-file',
  'write-file',
])

/**
 * Dispatch a handler invocation.
 *
 * @see recipe-system.md §12-5-2 steps 1-8
 */
export async function dispatch(
  request: DispatchRequest,
  manifestStore: RecipeManifestStore,
  projectRoot: string,
  kovitoboardRoot?: string,
): Promise<HandlerResponse<unknown>> {
  const { recipeId, callId, input } = request

  // 1. Load manifest
  const manifest = manifestStore.get(recipeId)
  if (!manifest) {
    return handlerError('HandlerNotDeclared', `No manifest found for recipe "${recipeId}"`)
  }

  // 2. Look up api.calls[id=callId]
  const callDecl = manifest.api.calls.find((c) => c.id === callId)
  if (!callDecl) {
    return handlerError('HandlerNotDeclared', `Call "${callId}" is not declared in recipe "${recipeId}"`)
  }

  // 3. Get implementation from handler registry
  const handlerName = callDecl.handler
  const handlerDef = getHandler(handlerName)
  if (!handlerDef) {
    return handlerError('Internal', `Handler "${handlerName}" is not registered`)
  }

  // 4. Expand args template
  let expandedArgs: Record<string, unknown>
  try {
    expandedArgs = expandTemplate(callDecl.args, input)
  } catch (err) {
    if (err instanceof TemplateExpansionError) {
      return handlerError('InvalidArgs', err.message)
    }
    throw err
  }

  // 5. Scope validation
  const requiredScopes = HANDLER_REQUIRED_SCOPES[handlerName]
  const approvedScopes = manifest.approvedScopes

  if (HANDLERS_WITH_PATH.has(handlerName)) {
    // Handler with path argument: cross-validate path x scope
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
    // Handler without path argument: validate scope only
    const scopeValidation = validateScopeOnly(approvedScopes, requiredScopes)
    if (!scopeValidation.ok) {
      return handlerError(
        scopeValidation.failedCode!,
        `Scope violation: handler "${handlerName}" requires one of [${requiredScopes.join(', ')}]`,
      )
    }
  }

  // 6. Argument validation
  const validationError = handlerDef.validate(expandedArgs)
  if (validationError) {
    return handlerError('InvalidArgs', validationError)
  }

  // 7. Rate limit check
  if (!checkRateLimit(recipeId, callId, handlerName)) {
    return handlerError('RateLimited', `Rate limit exceeded for "${callId}"`)
  }

  // 8. Execute handler + audit log
  const startTime = Date.now()
  try {
    const result = await handlerDef.execute(expandedArgs, {
      projectRoot,
      recipeId,
      approvedScopes,
    })
    const durationMs = Date.now() - startTime

    // Audit log (success / handler-level error)
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

    // Audit log (exception)
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
 * Reset the rate limiter. For testing only.
 */
export function resetRateLimiter(): void {
  rateBuckets.clear()
}
