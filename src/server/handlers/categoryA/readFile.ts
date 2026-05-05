/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * read-file handler — Reads and returns the contents of a file.
 *
 * Supports utf-8 and base64 encodings.
 * Maximum file size is 10MB. Path validation is handled by the dispatcher.
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

    // Check file existence and size
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

    // Read file contents
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
