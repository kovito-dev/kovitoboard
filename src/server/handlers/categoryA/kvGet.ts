/**
 * kv-get handler — Retrieves a value by key from the KV store.
 *
 * If TTL is set and the entry has expired, returns null.
 * Returns { value: null } for non-existent keys (not an error).
 *
 * @see recipe-system.md §12-2-1 kv-get
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  KvGetInput,
  KvGetOutput,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'
import { getKvStorePath, readKvStore, isExpired } from './kvHelpers.js'

export const kvGetHandler: HandlerDef<KvGetInput, KvGetOutput> = {
  name: 'kv-get',
  requiredScopes: HANDLER_REQUIRED_SCOPES['kv-get'],

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

    return null
  },

  execute: async (
    input: KvGetInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<KvGetOutput>> => {
    const storePath = getKvStorePath(context)

    try {
      const store = readKvStore(storePath)
      const entry = store[input.key]

      if (!entry || isExpired(entry)) {
        return handlerOk({ value: null })
      }

      return handlerOk({
        value: entry.value,
        existsAt: entry.expiresAt,
      })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to read KV store: ${(err as Error).message}`)
    }
  },
}
