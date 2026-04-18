/**
 * kv-list handler — KV ストアのキー一覧を返す.
 *
 * prefix フィルタと limit をサポートする。
 * limit のデフォルトは 100、最大 1000。
 * 期限切れエントリは結果から除外する。
 *
 * @see recipe-system.md §12-2-1 kv-list
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  KvListInput,
  KvListOutput,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'
import { getKvStorePath, readKvStore, purgeExpired } from './kvHelpers.js'

export const kvListHandler: HandlerDef<KvListInput, KvListOutput> = {
  name: 'kv-list',
  requiredScopes: HANDLER_REQUIRED_SCOPES['kv-list'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (obj.prefix !== undefined && typeof obj.prefix !== 'string') {
      return 'prefix must be a string'
    }

    if (obj.limit !== undefined) {
      if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1) {
        return 'limit must be a positive integer'
      }
      if (obj.limit > HANDLER_LIMITS.KV_LIST_MAX_LIMIT) {
        return `limit ${obj.limit} exceeds maximum of ${HANDLER_LIMITS.KV_LIST_MAX_LIMIT}`
      }
    }

    return null
  },

  execute: async (
    input: KvListInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<KvListOutput>> => {
    const storePath = getKvStorePath(context)
    const prefix = input.prefix ?? ''
    const limit = input.limit ?? HANDLER_LIMITS.KV_LIST_DEFAULT_LIMIT

    try {
      const rawStore = readKvStore(storePath)
      const store = purgeExpired(rawStore)

      // prefix フィルタ
      let keys = Object.keys(store)
      if (prefix.length > 0) {
        keys = keys.filter((key) => key.startsWith(prefix))
      }

      // ソート（一貫した結果のため）
      keys.sort()

      // limit + hasMore
      const hasMore = keys.length > limit
      const resultKeys = keys.slice(0, limit)

      return handlerOk({
        keys: resultKeys,
        hasMore,
      })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to read KV store: ${(err as Error).message}`)
    }
  },
}
