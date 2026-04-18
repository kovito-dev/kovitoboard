/**
 * notify handler — ユーザーに通知を送る.
 *
 * v0.1.0 では UI トーストのみ（OS 通知は実装しない）。
 * Phase E 時点では WebSocket 未統合のため、console.log で代替する。
 * Phase J/K で WebSocket 統合時に kb-notification イベントを送信する実装に差し替え。
 *
 * @see recipe-system.md §12-2-1 notify
 * @stable v0.1.0
 */

import type {
  HandlerDef,
  NotifyInput,
  NotifyOk,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'

export const notifyHandler: HandlerDef<NotifyInput, NotifyOk> = {
  name: 'notify',
  requiredScopes: HANDLER_REQUIRED_SCOPES['notify'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.title !== 'string' || obj.title.length === 0) {
      return 'title must be a non-empty string'
    }

    if (obj.title.length > HANDLER_LIMITS.NOTIFY_TITLE_MAX_LENGTH) {
      return `title length ${obj.title.length} exceeds limit of ${HANDLER_LIMITS.NOTIFY_TITLE_MAX_LENGTH}`
    }

    if (typeof obj.body !== 'string' || obj.body.length === 0) {
      return 'body must be a non-empty string'
    }

    if (obj.body.length > HANDLER_LIMITS.NOTIFY_BODY_MAX_LENGTH) {
      return `body length ${obj.body.length} exceeds limit of ${HANDLER_LIMITS.NOTIFY_BODY_MAX_LENGTH}`
    }

    if (obj.level !== undefined && obj.level !== 'info' && obj.level !== 'warning') {
      return 'level must be "info" or "warning"'
    }

    return null
  },

  execute: async (
    input: NotifyInput,
    _context: HandlerContext,
  ): Promise<HandlerResponse<NotifyOk>> => {
    const level = input.level ?? 'info'

    try {
      // TODO: Phase J/K で WebSocket 統合時に kb-notification イベントを送信する実装に差し替え
      // 現時点では console.log で代替
      const prefix = level === 'warning' ? '[WARN]' : '[INFO]'
      console.log(`[notify] ${prefix} ${input.title}: ${input.body}`)

      return handlerOk({ ok: true as const })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to send notification: ${(err as Error).message}`)
    }
  },
}
