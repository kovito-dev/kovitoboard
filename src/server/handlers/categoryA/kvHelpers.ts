/**
 * KV ストアの共通ヘルパー関数.
 *
 * kv-get / kv-set / kv-list / kv-delete が共有する
 * ストアファイルの読み書きロジックを集約する。
 *
 * ストアは app/data/{recipeId}/_kv.json に単一 JSON ファイルとして保存する。
 * v0.1.0 は低頻度想定のため、操作ごとにファイルを読み書きする（インメモリキャッシュなし）。
 *
 * @see recipe-system.md §12-2-1 kv-*
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type { HandlerContext } from '../types.js'

/**
 * KV ストア内の 1 エントリの形式.
 */
export interface KvEntry {
  value: string
  /** ISO 8601 形式。省略時は無期限 */
  expiresAt?: string
}

/**
 * KV ストアの内部形式（JSON ファイルの構造）.
 */
export type KvStore = Record<string, KvEntry>

/**
 * KV ストアファイルのパスを返す.
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
 * KV ストアを読み込む.
 * ファイルが存在しない場合は空のストアを返す。
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
 * KV ストアを書き出す.
 * 親ディレクトリが存在しない場合は自動作成する。
 */
export function writeKvStore(storePath: string, store: KvStore): void {
  const dir = path.dirname(storePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

/**
 * エントリの TTL が期限切れかを判定する.
 * expiresAt が未設定の場合は期限切れでない（無期限）。
 */
export function isExpired(entry: KvEntry): boolean {
  if (!entry.expiresAt) return false
  return new Date(entry.expiresAt).getTime() <= Date.now()
}

/**
 * 期限切れエントリを除去したストアを返す（ガベージコレクション）.
 * 読み取り時に呼び出し、期限切れエントリを遅延削除する。
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
