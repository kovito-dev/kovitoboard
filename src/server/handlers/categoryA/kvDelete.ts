/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * kv-delete handler — Deletes a key from the KV store.
 *
 * Idempotent: deleting a non-existent key returns { deleted: false } (not an error).
 *
 * @see recipe-system.md §12-2-1 kv-delete
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  KvDeleteInput,
  KvDeleteOutput,
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

export const kvDeleteHandler: HandlerDef<KvDeleteInput, KvDeleteOutput> = {
  name: 'kv-delete',
  requiredScopes: HANDLER_REQUIRED_SCOPES['kv-delete'],

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
    input: KvDeleteInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<KvDeleteOutput>> => {
    const storePath = getKvStorePath(context)

    try {
      const rawStore = readKvStore(storePath)
      const store = purgeExpired(rawStore)

      const existed = input.key in store
      if (existed) {
        delete store[input.key]
        writeKvStore(storePath, store)
      }

      return handlerOk({ deleted: existed })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to update KV store: ${(err as Error).message}`)
    }
  },
}
