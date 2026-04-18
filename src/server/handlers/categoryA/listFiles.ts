/**
 * list-files handler — ディレクトリ内のファイル・フォルダ一覧を返す.
 *
 * BFS でディレクトリを探索し、エントリ一覧を返す。
 * 除外パスは filterExcludedEntries で結果から除去する。
 * パス検証は dispatcher 側で完了済みのため、handler 内では行わない。
 *
 * @see recipe-system.md §12-2-1 list-files
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  HandlerDef,
  ListFilesInput,
  ListFilesOutput,
  FileEntry,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'
import { filterExcludedEntries } from '../../scopeValidator.js'

/**
 * input.path が own-data scope に該当するかを判定する.
 * own-data scope のパス形式: "app/data/{recipeId}/..." or 相対パスが own-data 領域
 */
function isOwnDataPath(inputPath: string, context: HandlerContext): boolean {
  return context.approvedScopes.includes('own-data') &&
    inputPath.startsWith('app/data/')
}

/**
 * 探索のベースパスを解決する.
 */
function resolveBasePath(inputPath: string, context: HandlerContext): string {
  if (isOwnDataPath(inputPath, context)) {
    // own-data の場合、projectRoot/app/data/recipeId/ 配下に限定
    // inputPath が "app/data/..." の形で来るので、projectRoot と結合
    return path.join(context.projectRoot, inputPath)
  }
  return path.join(context.projectRoot, inputPath)
}

/**
 * BFS でディレクトリを探索し、FileEntry の配列を返す.
 */
function listDirectory(
  basePath: string,
  recursive: boolean,
  maxDepth: number,
  maxEntries: number,
): FileEntry[] {
  const entries: FileEntry[] = []

  // BFS キュー: [absolutePath, currentDepth]
  const queue: Array<[string, number]> = [[basePath, 0]]

  while (queue.length > 0 && entries.length < maxEntries) {
    const [currentDir, depth] = queue.shift()!

    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      // ディレクトリが読めない場合はスキップ（権限不足等）
      continue
    }

    for (const dirent of dirEntries) {
      if (entries.length >= maxEntries) break

      const entryAbsPath = path.join(currentDir, dirent.name)
      const relativePath = path.relative(basePath, entryAbsPath)

      let stat: fs.Stats
      try {
        stat = fs.statSync(entryAbsPath)
      } catch {
        // stat が取れない場合はスキップ
        continue
      }

      entries.push({
        name: dirent.name,
        path: relativePath,
        isDirectory: dirent.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })

      // 再帰探索: ディレクトリかつ depth 制限内なら BFS キューに追加
      if (recursive && dirent.isDirectory() && depth < maxDepth) {
        queue.push([entryAbsPath, depth + 1])
      }
    }
  }

  return entries
}

export const listFilesHandler: HandlerDef<ListFilesInput, ListFilesOutput> = {
  name: 'list-files',
  requiredScopes: HANDLER_REQUIRED_SCOPES['list-files'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.path !== 'string' || obj.path.length === 0) {
      return 'path must be a non-empty string'
    }

    if (obj.recursive !== undefined && typeof obj.recursive !== 'boolean') {
      return 'recursive must be a boolean'
    }

    return null
  },

  execute: async (
    input: ListFilesInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<ListFilesOutput>> => {
    const basePath = resolveBasePath(input.path, context)
    const recursive = input.recursive ?? false

    // ディレクトリの存在チェック
    try {
      const stat = fs.statSync(basePath)
      if (!stat.isDirectory()) {
        return handlerError('InvalidArgs', `Path is not a directory: ${input.path}`)
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return handlerError('NotFound', `Directory not found: ${input.path}`)
      }
      return handlerError('Internal', `Failed to access directory: ${input.path}`)
    }

    // own-data かどうかで最大深度を切り替え
    const maxDepth = isOwnDataPath(input.path, context)
      ? HANDLER_LIMITS.LIST_FILES_MAX_DEPTH_OWN
      : HANDLER_LIMITS.LIST_FILES_MAX_DEPTH_OTHER

    try {
      const rawEntries = listDirectory(
        basePath,
        recursive,
        maxDepth,
        HANDLER_LIMITS.LIST_FILES_MAX_ENTRIES,
      )

      // 除外パスを除去（エントリの path を一時的に絶対パスに変換してフィルタ）
      const entriesWithAbsPaths = rawEntries.map((entry) => ({
        ...entry,
        path: path.join(basePath, entry.path),
      }))
      const filtered = filterExcludedEntries(entriesWithAbsPaths, context.projectRoot)

      // 結果を相対パスに戻す
      const result: FileEntry[] = filtered.map((entry) => ({
        ...entry,
        path: path.relative(basePath, entry.path),
      }))

      return handlerOk({ entries: result })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to list files: ${(err as Error).message}`)
    }
  },
}
