/**
 * Handler Registry — Category A handler 9 個の登録・名前解決.
 *
 * 各 handler モジュールを一覧管理し、handler 名から実装を取得する。
 * Phase E で個々の handler が実装された後、ここに登録する。
 *
 * @see recipe-system.md §12-2
 * @stable v0.1.0
 */

import type { CategoryAHandlerName, HandlerDef } from './types.js'

// =========================================
// Registry
// =========================================

const handlers = new Map<CategoryAHandlerName, HandlerDef>()

/**
 * handler 実装を登録する.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHandler(handler: HandlerDef<any, any>): void {
  if (handlers.has(handler.name)) {
    console.warn(`[handler-registry] Handler "${handler.name}" is already registered, overwriting`)
  }
  handlers.set(handler.name, handler)
}

/**
 * handler 名から実装を取得する.
 */
export function getHandler(name: CategoryAHandlerName): HandlerDef | undefined {
  return handlers.get(name)
}

/**
 * 登録済みの全 handler 名を返す.
 */
export function getRegisteredHandlerNames(): CategoryAHandlerName[] {
  return [...handlers.keys()]
}

/**
 * テスト用: レジストリをクリアする.
 */
export function clearRegistry(): void {
  handlers.clear()
}
