/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Pure helpers for the "Connect a Chrome extension" pairing UI
 * (spec `chrome-extension-pairing-ui.md` v1.0). Extracted from
 * `SettingsExtensionPairing.tsx` so the defensive response validation (§6.1)
 * and the TTL countdown formatting (§7.3) are unit-testable without rendering.
 */

const PAIRING_CODE_RE = /^[0-9a-f]{32}$/

export interface IssuedCode {
  pairingCode: string
  /** Wall-clock ms when this code expires (Date.now() + ttlMs, §7.3). */
  expiresAt: number
}

/**
 * Validate the 200 body before display (§6.1). Returns null when invalid:
 * a non-32-hex / missing `pairingCode`, or a `ttlMs` that is not a finite
 * positive number. NaN / Infinity pass `typeof === 'number'`, so they are
 * rejected explicitly via `Number.isFinite` to avoid corrupting `expiresAt`.
 *
 * `now` is injectable so the anchored `expiresAt` is deterministic in tests.
 */
export function parseIssueResponse(body: unknown, now: number = Date.now()): IssuedCode | null {
  if (typeof body !== 'object' || body === null) return null
  const { pairingCode, ttlMs } = body as { pairingCode?: unknown; ttlMs?: unknown }
  if (typeof pairingCode !== 'string' || !PAIRING_CODE_RE.test(pairingCode)) return null
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return null
  return { pairingCode, expiresAt: now + ttlMs }
}

/** Format remaining ms as mm:ss using ceil so the last second shows 00:01. */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000)
  const mm = Math.floor(totalSeconds / 60)
  const ss = totalSeconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
