/**
 * write-file handler — Writes content to a file.
 *
 * Supports utf-8 and base64 encodings.
 * When createDirs is true, intermediate directories are created automatically.
 * Maximum size is 10MB. Path validation is handled by the dispatcher.
 *
 * @see recipe-system.md §12-2-1 write-file
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  HandlerDef,
  WriteFileInput,
  WriteFileOutput,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'

export const writeFileHandler: HandlerDef<WriteFileInput, WriteFileOutput> = {
  name: 'write-file',
  requiredScopes: HANDLER_REQUIRED_SCOPES['write-file'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.path !== 'string' || obj.path.length === 0) {
      return 'path must be a non-empty string'
    }

    if (typeof obj.content !== 'string') {
      return 'content must be a string'
    }

    if (obj.encoding !== undefined &&
        obj.encoding !== 'utf-8' &&
        obj.encoding !== 'base64') {
      return 'encoding must be "utf-8" or "base64"'
    }

    if (obj.createDirs !== undefined && typeof obj.createDirs !== 'boolean') {
      return 'createDirs must be a boolean'
    }

    return null
  },

  execute: async (
    input: WriteFileInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<WriteFileOutput>> => {
    const absPath = path.join(context.projectRoot, input.path)
    const encoding = input.encoding ?? 'utf-8'
    const createDirs = input.createDirs ?? false

    // Size check (byte length of content string)
    const contentBytes = Buffer.byteLength(input.content, encoding === 'base64' ? 'base64' : 'utf-8')
    if (contentBytes > HANDLER_LIMITS.WRITE_FILE_MAX_SIZE) {
      return handlerError(
        'SizeExceeded',
        `Content size ${contentBytes} exceeds limit of ${HANDLER_LIMITS.WRITE_FILE_MAX_SIZE} bytes`,
      )
    }

    // Create intermediate directories
    const dir = path.dirname(absPath)
    if (createDirs) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (err: unknown) {
        return handlerError('Internal', `Failed to create directories: ${(err as Error).message}`)
      }
    } else {
      // When createDirs is false, verify parent directory exists
      if (!fs.existsSync(dir)) {
        return handlerError(
          'NotFound',
          `Parent directory does not exist: ${path.dirname(input.path)}. Set createDirs: true to auto-create.`,
        )
      }
    }

    // Write file
    try {
      if (encoding === 'base64') {
        const buffer = Buffer.from(input.content, 'base64')
        fs.writeFileSync(absPath, buffer)
        return handlerOk({ written: buffer.length })
      } else {
        fs.writeFileSync(absPath, input.content, { encoding: 'utf-8' })
        return handlerOk({ written: contentBytes })
      }
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to write file: ${(err as Error).message}`)
    }
  },
}
