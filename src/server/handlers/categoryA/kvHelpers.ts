/**
 * Common helper functions for the KV store.
 *
 * Consolidates store file read/write logic shared by
 * kv-get / kv-set / kv-list / kv-delete handlers.
 *
 * The store is persisted as a single JSON file at app/data/{recipeId}/_kv.json.
 * In v0.1.0, assuming low frequency access, the file is read/written on each
 * operation (no in-memory cache).
 *
 * @see recipe-system.md §12-2-1 kv-*
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type { HandlerContext } from '../types.js'

/**
 * Shape of a single entry in the KV store.
 */
export interface KvEntry {
  value: string
  /** ISO 8601 format. Omitted means no expiration */
  expiresAt?: string
}

/**
 * Internal representation of the KV store (JSON file structure).
 */
export type KvStore = Record<string, KvEntry>

/**
 * Returns the file path for the KV store.
 */
export function getKvStorePath(context: HandlerContext): string {
  return path.join(
    context.projectRoot,
    'app',
    'data',
    context.recipeId,
    '_kv.json',
  )
}

/**
 * Reads the KV store from disk.
 * Returns an empty store if the file does not exist.
 */
export function readKvStore(storePath: string): KvStore {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8')
    return JSON.parse(raw) as KvStore
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {}
    }
    throw err
  }
}

/**
 * Writes the KV store to disk.
 * Automatically creates parent directories if they do not exist.
 */
export function writeKvStore(storePath: string, store: KvStore): void {
  const dir = path.dirname(storePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

/**
 * Checks whether an entry's TTL has expired.
 * Returns false if expiresAt is not set (no expiration).
 */
export function isExpired(entry: KvEntry): boolean {
  if (!entry.expiresAt) return false
  return new Date(entry.expiresAt).getTime() <= Date.now()
}

/**
 * Returns a store with expired entries removed (garbage collection).
 * Called on read to lazily purge expired entries.
 */
export function purgeExpired(store: KvStore): KvStore {
  const cleaned: KvStore = {}
  for (const [key, entry] of Object.entries(store)) {
    if (!isExpired(entry)) {
      cleaned[key] = entry
    }
  }
  return cleaned
}
