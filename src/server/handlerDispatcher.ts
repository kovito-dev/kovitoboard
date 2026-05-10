/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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

import { serverLogger } from './logger'
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
  /**
   * KB-local app identifier — the `appId` of the installed app
   * whose `recipes-installed/<appId>/manifest.json` declares the
   * call. This is the dispatcher's lookup key, distinct from the
   * recipe author's immutable `recipeId` (which is captured on the
   * manifest itself for lineage tracking). Spec: DEC-024 D-1, §13.
   */
  appId: string
  callId: string
  input: Record<string, unknown>
}

// =========================================
// Per-appId serialization mutex
// =========================================
//
// Critical region: from `manifestStore.get(appId)` through the awaited
// `handlerDef.execute()` call below. Without this lock the dispatcher
// can take a snapshot of the manifest (and the on-disk app state it
// implies) and then yield to the event loop while a parallel
// `manifestStore.delete(appId)` + `rm -rf app/<appId>/` runs from a
// removal flow, leaving the handler writing into a directory that no
// longer exists or whose manifest has been revoked.
//
// External callers that mutate per-app on-disk state — recipe install,
// `manifestStore.delete`-driven cleanup, future agent-driven removal
// hooks — should `await acquireAppLock(appId)` themselves before
// touching that state and release once the mutation is complete.
// Different appIds are independent: lock keys are the appId string,
// so unrelated apps continue to run in parallel.

interface AppLockEntry {
  /** Promise that resolves once the current holder calls `release`. */
  held: Promise<void>
  /** Release callback bound to the holder. */
  release: () => void
}

const appLocks = new Map<string, AppLockEntry>()

/**
 * Maximum time `acquireAppLock` will wait for the current holder to
 * release before giving up. A stuck handler (hung subprocess, blocked
 * fs op) would otherwise let dispatch requests for the same appId
 * pile up unboundedly behind it; the timeout caps that head-of-line
 * blocking risk and surfaces the stall as a `LockWaitTimeout` error
 * the caller can map to a 5xx-equivalent handler error.
 *
 * 30 seconds is generous for any in-process handler — Category A
 * handlers are fs / kv operations that complete in milliseconds, and
 * the only awaitable subprocess work (Claude CLI handover) lives on
 * a different code path. A real hang at this layer is therefore
 * pathological and should fail loud rather than queue forever.
 */
const APP_LOCK_WAIT_TIMEOUT_MS = 30_000

/**
 * Error thrown by `acquireAppLock` when waiting for the current
 * holder exceeds `APP_LOCK_WAIT_TIMEOUT_MS`. The caller catches this
 * to emit an `Internal` handler error rather than retrying forever.
 */
export class AppLockWaitTimeoutError extends Error {
  constructor(appId: string, timeoutMs: number) {
    super(`acquireAppLock("${appId}") timed out after ${timeoutMs}ms`)
    this.name = 'AppLockWaitTimeoutError'
  }
}

/**
 * Acquire the per-appId dispatch lock. Resolves once any in-flight
 * dispatch for the same `appId` has finished and returns a release
 * function the caller MUST call (in a `finally`) to let the next
 * waiter proceed.
 *
 * Implementation: each appId maps to an entry holding a
 * `Promise<void>` (the currently-held lock) and its resolver. New
 * acquirers race that promise against a wait-timeout deadline and
 * throw `AppLockWaitTimeoutError` when the deadline is reached so
 * a hung handler cannot pile up the queue forever. The map entry is
 * cleared by the release callback so an idle appId does not keep an
 * entry alive.
 */
export async function acquireAppLock(appId: string): Promise<() => void> {
  const deadline = Date.now() + APP_LOCK_WAIT_TIMEOUT_MS
  // Loop because two waiters can observe `existing` simultaneously,
  // and only one of them will become the next holder — the other has
  // to wait again on whatever entry now occupies the slot.
  while (appLocks.has(appId)) {
    const existing = appLocks.get(appId)
    if (!existing) break
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new AppLockWaitTimeoutError(appId, APP_LOCK_WAIT_TIMEOUT_MS)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        existing.held,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppLockWaitTimeoutError(appId, APP_LOCK_WAIT_TIMEOUT_MS)),
            remainingMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = () => {
      // Only clear the map slot if it still points at *this* entry —
      // an out-of-order release (released twice, or after a lock
      // ownership bug elsewhere) must not wipe a successor's entry.
      if (appLocks.get(appId)?.held === held) {
        appLocks.delete(appId)
      }
      resolve()
    }
  })
  appLocks.set(appId, { held, release })
  return release
}

/**
 * Drop all per-appId lock state. For testing only.
 *
 * Walks every parked entry and resolves its `held` promise via the
 * stored `release` callback so any awaiter that is still parked on
 * `existing.held` returns immediately, then clears the map. Without
 * the explicit resolve step a test that forgot to call its release
 * function would leave its sibling waiters stuck on the previous
 * promise indefinitely.
 */
export function resetAppLocks(): void {
  for (const entry of appLocks.values()) {
    entry.release()
  }
  appLocks.clear()
}

// =========================================
// Rate limiter (token bucket, per appId+callId)
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
  appId: string,
  callId: string,
  handlerName: CategoryAHandlerName,
): boolean {
  const key = `${appId}:${callId}`
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
 * Acquires the per-appId mutex first so the manifest snapshot read by
 * `dispatchInner` cannot be torn out from under the handler by a
 * concurrent removal / reinstall flow that mutates `app/<appId>/`,
 * `app/data/<appId>/`, or the manifest cache.
 *
 * @see recipe-system.md §12-5-2 steps 1-8
 */
export async function dispatch(
  request: DispatchRequest,
  manifestStore: RecipeManifestStore,
  projectRoot: string,
  kovitoboardRoot?: string,
): Promise<HandlerResponse<unknown>> {
  let release: (() => void) | undefined
  try {
    release = await acquireAppLock(request.appId)
  } catch (err) {
    // A hung handler holding the per-appId lock would otherwise let
    // queued dispatches stack up; surface the stall as a clean error
    // so the caller can fail-fast rather than retry forever.
    if (err instanceof AppLockWaitTimeoutError) {
      serverLogger.warn({ err, appId: request.appId }, '[dispatcher] app lock wait timed out')
      return handlerError(
        'Internal',
        `Dispatch timed out waiting for the per-app mutex on "${request.appId}"`,
      )
    }
    throw err
  }
  try {
    return await dispatchInner(request, manifestStore, projectRoot, kovitoboardRoot)
  } finally {
    release()
  }
}

async function dispatchInner(
  request: DispatchRequest,
  manifestStore: RecipeManifestStore,
  projectRoot: string,
  kovitoboardRoot?: string,
): Promise<HandlerResponse<unknown>> {
  const { appId, callId, input } = request

  // 1. Load manifest by appId. The manifest's own `recipeId` field
  //    is the recipe author's lineage id (used in the audit log
  //    and the handler context); `appId` is the KB-local key that
  //    this dispatcher routes by. (DEC-024 D-1.)
  const manifest = manifestStore.get(appId)
  if (!manifest) {
    return handlerError('HandlerNotDeclared', `No manifest found for app "${appId}"`)
  }

  // 2. Look up api.calls[id=callId]
  const callDecl = manifest.api.calls.find((c) => c.id === callId)
  if (!callDecl) {
    return handlerError('HandlerNotDeclared', `Call "${callId}" is not declared in app "${appId}"`)
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
  // Captured from validatePathForScope on the path-bound branch so it
  // can be threaded onto HandlerContext below. Stays undefined for
  // scope-only handlers, matching HandlerContext.resolvedPath's
  // optional contract.
  let resolvedPath: string | undefined

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
      appId,
      projectRoot,
      kovitoboardRoot,
    )
    if (!pathValidation.ok) {
      return handlerError(
        pathValidation.failedCode!,
        `Path "${pathArg}" is not allowed: ${pathValidation.failedCode}`,
      )
    }
    // The validator returns the physical path that passed scope and
    // exclusion checks; missing here would mean the validator
    // contract is broken, so refuse with Internal rather than fall
    // back to projectRoot+input.path (which is exactly the
    // re-resolution pattern this change removes).
    if (!pathValidation.resolvedPath) {
      return handlerError(
        'Internal',
        `Scope validator returned ok without a resolved path for "${pathArg}"`,
      )
    }
    resolvedPath = pathValidation.resolvedPath
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
  if (!checkRateLimit(appId, callId, handlerName)) {
    return handlerError('RateLimited', `Rate limit exceeded for "${callId}"`)
  }

  // 8. Execute handler + audit log.
  //
  // The handler context carries both ids: `appId` is the KB-local
  // identifier (drives `app/data/<appId>/` paths), `recipeId` is
  // the recipe author's lineage id captured on the manifest. The
  // audit log records both so an entry can be attributed to a
  // specific app instance (multiple apps may share a recipeId).
  // `resolvedPath` is set above only on the path-bound branch so
  // the handler can read/write the same physical path that scope
  // validation cleared, without re-deriving it.
  const recipeId = manifest.recipeId
  const startTime = Date.now()
  try {
    const result = await handlerDef.execute(expandedArgs, {
      projectRoot,
      appId,
      recipeId,
      approvedScopes,
      resolvedPath,
    })
    const durationMs = Date.now() - startTime

    // Audit log (success / handler-level error)
    writeAuditLog(
      createAuditEntry({
        appId,
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
    serverLogger.error({ err }, `[dispatcher] Handler "${handlerName}" threw`)

    // Audit log (exception)
    writeAuditLog(
      createAuditEntry({
        appId,
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
