/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * export-file handler — Relays file export (download) to the browser.
 *
 * In v0.1.0, the browser-side File System Access API is used, so
 * the backend simply relays content / suggestedName as-is.
 * Frontend dialog integration will be added in Phase K.
 *
 * @see recipe-system.md §12-2-1 export-file
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  ExportFileInput,
  ExportFileOutput,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'

export const exportFileHandler: HandlerDef<ExportFileInput, ExportFileOutput> = {
  name: 'export-file',
  requiredScopes: HANDLER_REQUIRED_SCOPES['export-file'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.suggestedName !== 'string' || obj.suggestedName.length === 0) {
      return 'suggestedName must be a non-empty string'
    }

    if (typeof obj.content !== 'string') {
      return 'content must be a string'
    }

    // Content size check
    const encoding = obj.encoding === 'base64' ? 'base64' : 'utf-8'
    const contentBytes = Buffer.byteLength(obj.content as string, encoding)
    if (contentBytes > HANDLER_LIMITS.EXPORT_FILE_MAX_SIZE) {
      return `content size ${contentBytes} exceeds limit of ${HANDLER_LIMITS.EXPORT_FILE_MAX_SIZE} bytes`
    }

    if (obj.mimeType !== undefined && typeof obj.mimeType !== 'string') {
      return 'mimeType must be a string'
    }

    if (obj.encoding !== undefined &&
        obj.encoding !== 'utf-8' &&
        obj.encoding !== 'base64') {
      return 'encoding must be "utf-8" or "base64"'
    }

    return null
  },

  execute: async (
    input: ExportFileInput,
    _context: HandlerContext,
  ): Promise<HandlerResponse<ExportFileOutput>> => {
    try {
      // In Phase K (frontend dialog integration), this will be replaced with
      // an implementation that sends content to the browser via WebSocket and
      // receives the result of the user's save operation.
      // Currently returns content and suggestedName as-is.
      // The frontend is expected to use the File System Access API for saving.
      return handlerOk({
        saved: false,
        savedPath: undefined,
      })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to export file: ${(err as Error).message}`)
    }
  },
}
