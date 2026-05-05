/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * System-only message detection.
 *
 * A "system-only" message is a user-typed event whose body is entirely
 * consumed by Claude Code's framing tags (`<task-notification>`,
 * `<command-name>`, `<local-command-stdout>`, etc.). Filtering at the
 * display layer (not the parser) keeps the underlying transcript intact
 * while controlling visibility in chat surfaces.
 *
 * Shared by `ChatTimeline` and `AmbientSidebar` so both surfaces apply
 * the same hide-rules.
 */
import type { ParsedEvent } from '../types'

const SYSTEM_ONLY_PATTERNS = [
  /^<local-command-caveat>[\s\S]*$/,
  /^<command-name>[\s\S]*$/,
  /^<local-command-stdout>[\s\S]*$/,
  /^<task-notification>[\s\S]*<\/task-notification>\s*$/,
  /^This session is being continued from a previous conversation/,
]

export function isSystemOnlyMessage(event: ParsedEvent): boolean {
  if (event.type !== 'user') return false
  const text = event.content.text
  if (!text) return false
  return SYSTEM_ONLY_PATTERNS.some((p) => p.test(text.trim()))
}
