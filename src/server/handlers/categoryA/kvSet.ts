/**
 * kv-set handler — KV ストアにキーと値を保存する.
 *
 * ttlSeconds が指定された場合、expiresAt フィールドを設定する。
 * ストア合計サイズが 100MB を超える場合はエラーを返す。
 *
 * @see recipe-system.md §12-2-1 kv-set
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  KvSetInput,
  KvSetOk,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'
import {
  getKvStorePath,
  readKvStore,
  writeKvStore,
  purgeExpired,
} from './kvHelpers.js'
import type { KvEntry } from './kvHelpers.js'

export const kvSetHandler: HandlerDef<KvSetInput, KvSetOk> = {
  name: 'kv-set',
  requiredScopes: HANDLER_REQUIRED_SCOPES['kv-set'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.key !== 'string' || obj.key.length === 0) {
      return 'key must be a non-empty string'
    }

    if (obj.key.length > HANDLER_LIMITS.KV_KEY_MAX_LENGTH) {
      return `key length ${obj.key.length} exceeds limit of ${HANDLER_LIMITS.KV_KEY_MAX_LENGTH}`
    }

    if (typeof obj.value !== 'string') {
      return 'value must be a string'
    }

    const valueBytes = Buffer.byteLength(obj.value, 'utf-8')
    if (valueBytes > HANDLER_LIMITS.KV_VALUE_MAX_SIZE) {
      return `value size ${valueBytes} exceeds limit of ${HANDLER_LIMITS.KV_VALUE_MAX_SIZE} bytes`
    }

    if (obj.ttlSeconds !== undefined) {
      if (typeof obj.ttlSeconds !== 'number' || obj.ttlSeconds <= 0 || !Number.isFinite(obj.ttlSeconds)) {
        return 'ttlSeconds must be a positive finite number'
      }
    }

    return null
  },

  execute: async (
    input: KvSetInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<KvSetOk>> => {
    const storePath = getKvStorePath(context)

    try {
      // ストアを読み込み、期限切れエントリを除去
      const rawStore = readKvStore(storePath)
      const store = purgeExpired(rawStore)

      // 新しいエントリを作成
      const entry: KvEntry = { value: input.value }
      if (input.ttlSeconds !== undefined) {
        const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000)
        entry.expiresAt = expiresAt.toISOString()
      }

      // エントリをセット
      store[input.key] = entry

      // ストア全体のサイズチェック
      const serialized = JSON.stringify(store, null, 2)
      const storeSize = Buffer.byteLength(serialized, 'utf-8')
      if (storeSize > HANDLER_LIMITS.KV_STORE_MAX_SIZE) {
        return handlerError(
          'SizeExceeded',
          `KV store size ${storeSize} would exceed limit of ${HANDLER_LIMITS.KV_STORE_MAX_SIZE} bytes`,
        )
      }

      // 書き出し
      writeKvStore(storePath, store)

      return handlerOk({ ok: true as const })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to write KV store: ${(err as Error).message}`)
    }
  },
}
