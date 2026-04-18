/**
 * Recipe API section type definitions (宣言的 handler モデル).
 *
 * recipe.yaml の api: セクション、インストール manifest、
 * dispatcher で使う呼び出し宣言の型を定義する。
 *
 * @see recipe-system.md §12-4 (install approval)
 * @see recipe-system.md §12-5 (dispatcher flow)
 * @stable v0.1.0
 */

import type { CategoryAHandlerName, Scope } from '../handlers/types.js'
import { HANDLER_REQUIRED_SCOPES } from '../handlers/types.js'

// =========================================
// recipe.yaml api: section
// =========================================

/**
 * recipe.yaml api.calls[] の 1 エントリ.
 * FE からは callId で呼び出し、dispatcher が handler にルーティングする。
 *
 * @example
 * ```yaml
 * api:
 *   calls:
 *     - id: list-intel-reports
 *       handler: list-files
 *       args:
 *         path: intel/
 *     - id: read-intel-report
 *       handler: read-file
 *       args:
 *         path: "${input.path}"
 * ```
 *
 * @see recipe-system.md §12-5-1
 */
export interface HandlerCallDeclaration {
  /** 一意な呼び出し ID（FE: window.kb.call(id, input)） */
  id: string
  /** 呼び出す handler 名 */
  handler: CategoryAHandlerName
  /**
   * 静的 / テンプレート引数.
   * `${input.xxx}` は実行時に FE から渡された input で解決される。
   */
  args?: Record<string, unknown>
}

/**
 * recipe.yaml の api: セクション全体.
 *
 * @example
 * ```yaml
 * api:
 *   scopes:
 *     - project-read
 *     - own-data
 *   calls:
 *     - id: list-intel-reports
 *       handler: list-files
 *       args:
 *         path: intel/
 * ```
 *
 * @see recipe-system.md §12-2, §12-3
 */
export interface ApiSection {
  /** このレシピが要求する scope */
  scopes: Scope[]
  /** handler 呼び出し宣言 */
  calls: HandlerCallDeclaration[]
}

// =========================================
// Install manifest
// =========================================

/**
 * インストール済みレシピの manifest.
 * 保存先: .kovitoboard/recipes-installed/{recipe-id}/manifest.json
 *
 * @see recipe-system.md §12-5-1
 */
export interface RecipeManifest {
  /** レシピ ID */
  recipeId: string
  /** レシピバージョン */
  version: string
  /** レシピコンテンツの SHA-256 ハッシュ */
  hash: string
  /** インストール日時（ISO 8601） */
  installedAt: string
  /** ユーザーが承認した scope（api.scopes と同一、v0.1.0 は一括承認のため） */
  approvedScopes: Scope[]
  /** レシピの API 宣言（recipe.yaml から転記） */
  api: ApiSection
}

// =========================================
// Dispatcher types
// =========================================

/**
 * FE → BE への handler 呼び出しリクエスト.
 * WebSocket の kb-call メッセージペイロードとして送信される。
 * @see recipe-system.md §12-5-2
 */
export interface KbCallRequest {
  /** リクエスト ID（FE が採番、レスポンスとの照合に使用） */
  requestId: string
  /** レシピ ID */
  recipeId: string
  /** 呼び出し ID（api.calls[].id） */
  callId: string
  /** FE から渡される入力値 */
  input: Record<string, unknown>
}

/**
 * BE → FE への handler 呼び出しレスポンス.
 * WebSocket の kb-call-response メッセージペイロードとして返却される。
 * @see recipe-system.md §12-5-2
 */
export interface KbCallResponse {
  /** リクエスト ID（KbCallRequest.requestId と一致） */
  requestId: string
  /** handler の実行結果 */
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
}

// =========================================
// Validation helpers
// =========================================

/** 有効な scope 名かを判定するタイプガード */
const VALID_SCOPES = new Set<string>([
  'project-read',
  'project-write',
  'agents-read',
  'skills-read',
  'claude-md-read',
  'kb-data-read',
  'own-data',
])

export function isValidScope(value: unknown): value is Scope {
  return typeof value === 'string' && VALID_SCOPES.has(value)
}

/** 有効な Category A handler 名かを判定するタイプガード */
const VALID_HANDLER_NAMES = new Set<string>([
  'list-files',
  'read-file',
  'write-file',
  'kv-get',
  'kv-set',
  'kv-list',
  'kv-delete',
  'notify',
  'export-file',
])

export function isValidHandlerName(value: unknown): value is CategoryAHandlerName {
  return typeof value === 'string' && VALID_HANDLER_NAMES.has(value)
}

/**
 * recipe.yaml の api: セクションをバリデーションする.
 * パース後のオブジェクトが ApiSection の形を満たすか検証する。
 *
 * @returns null if valid, error message string if invalid
 * @see recipe-system.md §12-4-1 (block conditions)
 */
export function validateApiSection(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null // api: 未指定は許可（handler なしレシピ）
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'api: must be an object'
  }

  const obj = raw as Record<string, unknown>

  // scopes validation
  if (!Array.isArray(obj.scopes)) {
    return 'api.scopes must be an array'
  }
  for (const scope of obj.scopes) {
    if (!isValidScope(scope)) {
      return `api.scopes contains invalid scope: "${String(scope)}"`
    }
  }

  // calls validation
  if (!Array.isArray(obj.calls)) {
    return 'api.calls must be an array'
  }
  const seenIds = new Set<string>()
  const declaredScopes = new Set(obj.scopes as string[])

  for (let i = 0; i < obj.calls.length; i++) {
    const call = obj.calls[i] as Record<string, unknown>
    if (typeof call !== 'object' || call === null || Array.isArray(call)) {
      return `api.calls[${i}] must be an object`
    }

    // id
    if (typeof call.id !== 'string' || call.id.length === 0) {
      return `api.calls[${i}].id must be a non-empty string`
    }
    if (seenIds.has(call.id)) {
      return `api.calls[${i}].id "${call.id}" is duplicated`
    }
    seenIds.add(call.id)

    // handler
    if (!isValidHandlerName(call.handler)) {
      return `api.calls[${i}].handler "${String(call.handler)}" is not a valid Category A handler`
    }

    // args (optional)
    if (call.args !== undefined && (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args))) {
      return `api.calls[${i}].args must be an object if specified`
    }

    // Static integrity check: handler の required scope が declared scopes に含まれているか
    // §12-4-1: handler が必要とする scope が api.scopes に宣言されていない場合ブロック
    const handlerName = call.handler as CategoryAHandlerName
    const requiredScopes = HANDLER_REQUIRED_SCOPES[handlerName]

    // scope 不要な handler（notify, export-file）はスキップ
    if (requiredScopes.length > 0) {
      const hasMatchingScope = requiredScopes.some((s: Scope) => declaredScopes.has(s))
      if (!hasMatchingScope) {
        return `api.calls[${i}] handler "${handlerName}" requires one of [${requiredScopes.join(', ')}] but api.scopes declares [${[...declaredScopes].join(', ')}]`
      }
    }
  }

  return null
}

/**
 * バリデーション済み raw オブジェクトを ApiSection 型にキャストする.
 * validateApiSection() が null を返した場合のみ使用すること。
 */
export function parseApiSection(raw: Record<string, unknown>): ApiSection {
  return {
    scopes: raw.scopes as Scope[],
    calls: (raw.calls as Array<Record<string, unknown>>).map((c) => ({
      id: c.id as string,
      handler: c.handler as CategoryAHandlerName,
      args: c.args as Record<string, unknown> | undefined,
    })),
  }
}
