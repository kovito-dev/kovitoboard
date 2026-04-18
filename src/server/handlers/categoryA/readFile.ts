/**
 * read-file handler — ファイルの内容を読み取って返す.
 *
 * encoding として utf-8 または base64 をサポートする。
 * サイズ上限は 10MB。パス検証は dispatcher 側で完了済み。
 *
 * @see recipe-system.md §12-2-1 read-file
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  HandlerDef,
  ReadFileInput,
  ReadFileOutput,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'

export const readFileHandler: HandlerDef<ReadFileInput, ReadFileOutput> = {
  name: 'read-file',
  requiredScopes: HANDLER_REQUIRED_SCOPES['read-file'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.path !== 'string' || obj.path.length === 0) {
      return 'path must be a non-empty string'
    }

    if (obj.encoding !== undefined &&
        obj.encoding !== 'utf-8' &&
        obj.encoding !== 'base64') {
      return 'encoding must be "utf-8" or "base64"'
    }

    return null
  },

  execute: async (
    input: ReadFileInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<ReadFileOutput>> => {
    const absPath = path.join(context.projectRoot, input.path)
    const encoding = input.encoding ?? 'utf-8'

    // ファイルの存在・サイズチェック
    let stat: fs.Stats
    try {
      stat = fs.statSync(absPath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return handlerError('NotFound', `File not found: ${input.path}`)
      }
      return handlerError('Internal', `Failed to access file: ${input.path}`)
    }

    if (stat.isDirectory()) {
      return handlerError('InvalidArgs', `Path is a directory, not a file: ${input.path}`)
    }

    if (stat.size > HANDLER_LIMITS.READ_FILE_MAX_SIZE) {
      return handlerError(
        'SizeExceeded',
        `File size ${stat.size} exceeds limit of ${HANDLER_LIMITS.READ_FILE_MAX_SIZE} bytes`,
      )
    }

    // ファイル読み取り
    try {
      const content = fs.readFileSync(absPath, { encoding })
      return handlerOk({
        content,
        size: stat.size,
        encoding,
      })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to read file: ${(err as Error).message}`)
    }
  },
}
