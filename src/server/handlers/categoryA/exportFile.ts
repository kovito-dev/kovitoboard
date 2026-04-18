/**
 * export-file handler — ファイルのエクスポート（ダウンロード）を中継する.
 *
 * v0.1.0 ではブラウザ側の File System Access API を使うため、
 * BE 側は content / suggestedName をそのまま返す中継役。
 * FE 側のダイアログ実装は Phase K で統合する。
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

    // content サイズチェック
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
      // Phase K で FE 側のダイアログ統合時に、WebSocket 経由でブラウザに
      // content を送信し、ユーザーの保存操作結果を受け取る実装に差し替え。
      // 現時点では content と suggestedName をそのまま返す。
      // FE 側が受け取って File System Access API で保存を行う想定。
      return handlerOk({
        saved: false,
        savedPath: undefined,
      })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to export file: ${(err as Error).message}`)
    }
  },
}
