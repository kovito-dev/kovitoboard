/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Pure helpers backing the Q5 / SS-4 session status bar.
 *
 * Extracted into a util module so the formatting and lookup logic can
 * be unit tested without dragging in the React renderer.
 */
import type { ParsedEvent } from '../types'

/**
 * Context-window sizes per Claude family. Anthropic publishes 200K
 * tokens for Opus / Sonnet / Haiku across the 3.x and 4.x lines as of
 * 2026-05; we keep this as a hardcoded map per architect §6.4 so KB
 * does not have to fetch model metadata at runtime. Future families
 * can override the default by adding a longer prefix entry — the
 * lookup picks the longest matching prefix.
 */
export const CONTEXT_WINDOW_BY_MODEL_PREFIX: Array<{ prefix: string; tokens: number }> = [
  { prefix: 'claude-3-5-haiku', tokens: 200_000 },
  { prefix: 'claude-3-5-sonnet', tokens: 200_000 },
  { prefix: 'claude-3-7-sonnet', tokens: 200_000 },
  { prefix: 'claude-3-haiku', tokens: 200_000 },
  { prefix: 'claude-3-opus', tokens: 200_000 },
  { prefix: 'claude-3-sonnet', tokens: 200_000 },
  { prefix: 'claude-haiku', tokens: 200_000 },
  { prefix: 'claude-opus', tokens: 200_000 },
  { prefix: 'claude-sonnet', tokens: 200_000 },
]

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/**
 * Resolve the context-window size for a given model string. Picks the
 * longest matching entry from {@link CONTEXT_WINDOW_BY_MODEL_PREFIX};
 * falls back to {@link DEFAULT_CONTEXT_WINDOW_TOKENS} when nothing
 * matches (e.g. unknown future models or `default` from
 * Claude Code's per-agent model field).
 */
export function resolveContextWindow(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW_TOKENS
  const lower = model.toLowerCase()
  let best: { prefix: string; tokens: number } | null = null
  for (const entry of CONTEXT_WINDOW_BY_MODEL_PREFIX) {
    if (lower.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry
    }
  }
  return best?.tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

/**
 * Find the most recent assistant event with usage metadata.
 *
 * Returns model plus the three input-side token counters that together
 * make up the prompt occupying Claude's context window:
 *
 * - `inputTokens` — fresh tokens charged for this turn
 * - `cacheCreationTokens` — tokens written into the prompt cache this turn
 * - `cacheReadTokens` — tokens served from the prompt cache this turn
 *
 * Anthropic's API splits these so callers can reason about cache cost
 * separately, but for "how full is my context window" the three are
 * additive — every cached token still occupies a slot in the prompt
 * the model sees. Reporting only `inputTokens` produced misleadingly
 * tiny figures (e.g. "10 / 200.0K") once the cache started warming
 * up, because warm reads dominate later turns and `inputTokens`
 * collapses to the small delta.
 *
 * Total context usage is computed by callers via
 * `inputTokens + cacheCreationTokens + cacheReadTokens`; see
 * {@link computeContextTokens}.
 */
export function findLatestAssistantWithUsage(
  events: ParsedEvent[],
): {
  model?: string
  inputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
} | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'assistant') continue
    const meta = event.metadata
    if (!meta) continue
    const hasUsage =
      typeof meta.inputTokens === 'number' ||
      typeof meta.cacheCreationTokens === 'number' ||
      typeof meta.cacheReadTokens === 'number'
    if (meta.model || hasUsage) {
      return {
        model: meta.model,
        inputTokens: meta.inputTokens,
        cacheCreationTokens: meta.cacheCreationTokens,
        cacheReadTokens: meta.cacheReadTokens,
      }
    }
  }
  return null
}

/**
 * Sum the three input-side token counters into the total context-window
 * occupancy for a turn. Returns `null` when every counter is missing,
 * so callers can distinguish "no usage data" from "zero tokens used".
 */
export function computeContextTokens(usage: {
  inputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}): number | null {
  const parts = [usage.inputTokens, usage.cacheCreationTokens, usage.cacheReadTokens]
  let total = 0
  let hasAny = false
  for (const value of parts) {
    if (typeof value === 'number') {
      total += value
      hasAny = true
    }
  }
  return hasAny ? total : null
}

/**
 * Format a token count for display: 12345 → "12.3K", 1234567 → "1.2M".
 * Keeps the bar narrow on mobile / compact composers.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

/**
 * Format an elapsed-time delta (in milliseconds) into a compact
 * human-readable string. Below an hour we show "Mm" minutes; once
 * hours are involved we show "Hh Mm". This matches typical session
 * lengths without overflowing the bar.
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) return '0m'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return `${hours}h ${minutes}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return `${days}d ${remHours}h`
}
