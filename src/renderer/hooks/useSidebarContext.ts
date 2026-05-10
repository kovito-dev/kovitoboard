/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { t } from '../i18n'
import type { AppMenuEntry } from '../types/app-types'
import { resolveAppId } from './usePinnedAgent'

/**
 * useSidebarContext — derive screen-context information for the ambient
 * sidebar from the current route (DEC-020 / EU8 Phase 3).
 *
 * Provides:
 *   - Stable screen identifiers (`appId`, `activeMenu`)
 *   - A human-readable `screenLabel` for builtin pages (i18n) and user
 *     extension apps (resolved from the menu entry definitions)
 *   - A pre-formatted `kbcontext` Markdown code-block for prepending to
 *     each outgoing message
 *   - A one-shot `systemPromptPreamble` to send with the very first
 *     message in a sidebar-origin session, telling the agent how to
 *     read the structured context blocks
 *
 * Why we build the kbcontext on the renderer rather than the BE:
 *   The HTTP layer (`/api/sessions/new`, `/api/sessions/:id/send`)
 *   would otherwise have to rewrite caller-supplied messages, blurring
 *   the contract. Building the block on the client keeps the BE I/O
 *   contract honest and lets the sidebar evolve its context shape
 *   without server-side migrations.
 *
 * Spec references:
 *   - §2.3 (kbcontext block format)
 *   - §2.5 (appId resolution rules)
 *   - §4.5 (system prompt preamble — finalized wording, architect
 *           confirmed 2026-04-27)
 */

export interface SidebarContext {
  /** Current URL path. */
  url: string
  /** Active top-level menu (`agents` / `sessions` / `recipes` / `ext/<id>`). */
  activeMenu: string | null
  /** Stable identifier for the current screen. See spec §2.5. */
  appId: string | null
  /** Human-readable label, e.g. "Recipes" or the extension's `label`. */
  screenLabel: string
  /**
   * Markdown code-block to prepend to outgoing messages so the agent
   * can parse the screen context. Empty string when appId is null
   * (caller skips the block in that case).
   */
  kbcontextBlock: string
  /**
   * Single-shot preamble for the first message of a sidebar-origin
   * session. Tells the agent how to interpret the rule-line
   * sentinel-wrapped sections (`kbcontext` / `a11y` / `selected` /
   * `exposed-context`) the composer will attach. The identifier names
   * match the `KbAuthoredType` wire values emitted by
   * `wrapWithSentinel(...)`. English-only by design — this is
   * developer-facing diagnostic prose, not user-visible UI text.
   */
  systemPromptPreamble: string
}

/** Resolve the active menu the same way App.tsx does. */
function resolveActiveMenu(pathname: string): string | null {
  if (pathname.startsWith('/sessions')) return 'sessions'
  if (pathname.startsWith('/recipes')) return 'recipes'
  if (pathname.startsWith('/ext/')) {
    const parts = pathname.split('/')
    return `ext/${parts[2] ?? ''}`
  }
  if (pathname.startsWith('/agents')) return 'agents'
  return null
}

/** Resolve a friendly screen label from appId + user extension entries. */
function resolveScreenLabel(
  appId: string | null,
  userMenuEntries: AppMenuEntry[],
): string {
  if (!appId) return t('screen.unknown')
  if (appId === 'agents') return t('screen.agents')
  if (appId === 'sessions') return t('screen.sessions')
  if (appId === 'recipes') return t('screen.recipes')
  if (appId.startsWith('ext/')) {
    const id = appId.slice('ext/'.length)
    const entry = userMenuEntries.find((e) => e.id === id)
    if (entry) return entry.label
    return appId
  }
  return appId
}

/**
 * Build the kbcontext key/value block (spec §2.3). The block is
 * wrapped in a rule-line sentinel by the caller (`composePayload`)
 * so the previous ` ```kbcontext ` fence is no longer emitted on the
 * wire — the sentinel carries the kind identifier instead.
 */
function buildKbcontextBlock(params: {
  url: string
  activeMenu: string | null
  appId: string | null
  screenLabel: string
}): string {
  if (!params.appId) return ''
  const lines = [
    `url: ${params.url}`,
    params.activeMenu ? `activeMenu: ${params.activeMenu}` : null,
    `appId: ${params.appId}`,
    `screenLabel: ${params.screenLabel}`,
  ].filter((l): l is string => l !== null)
  return lines.join('\n')
}

/**
 * One-shot preamble for new sidebar-origin sessions. Architect-finalized
 * wording (kovito-hq 2026-04-27, spec v0.1.0-ambient-sidebar.md §4.5;
 * reworded for v0.2.0 to match the rule-line sentinel envelope after
 * the K-15 legacy-fence removal — spec `kb-authored-sentinel.md` v1.3
 * §11.3).
 *
 * Each block is described inline so the agent can attribute information
 * back to its source: `kbcontext` (route/menu), `a11y` (accessibility
 * tree of visible elements), `selected` (an element the user explicitly
 * picked), `exposed-context` (state the host app declared via
 * `window.kb.exposeContext`).
 *
 * Identifier names follow the `KbAuthoredType` wire identifiers emitted
 * by `wrapWithSentinel(...)` so the agent-facing copy matches the
 * `KovitoBoard:<kind>` value it actually sees on the wire.
 */
export const SYSTEM_PROMPT_PREAMBLE = [
  'This conversation was started from the KovitoBoard Ambient Session Sidebar.',
  'The user is working in another KB screen while talking to you.',
  '',
  'User messages may include rule-line sentinel sections labelled',
  '`kbcontext`, `a11y`, `selected`, or `exposed-context`. They describe',
  'the screen the user is currently looking at: respectively, the route',
  'and active menu, the accessibility tree of visible elements, an',
  'element the user explicitly selected, and state the host app exposed',
  'via `window.kb.exposeContext`.',
  '',
  'Treat these sections as authoritative context for the current screen.',
  'When the user says "this", "this screen", or "this information",',
  'consult them first. You may also draw on them proactively when',
  'answering would benefit from knowing what is on screen.',
].join('\n')

export function useSidebarContext(userMenuEntries: AppMenuEntry[]): SidebarContext {
  const location = useLocation()

  return useMemo<SidebarContext>(() => {
    const url = location.pathname + location.search
    const activeMenu = resolveActiveMenu(location.pathname)
    const appId = resolveAppId(location.pathname)
    const screenLabel = resolveScreenLabel(appId, userMenuEntries)
    const kbcontextBlock = buildKbcontextBlock({ url, activeMenu, appId, screenLabel })

    return {
      url,
      activeMenu,
      appId,
      screenLabel,
      kbcontextBlock,
      systemPromptPreamble: SYSTEM_PROMPT_PREAMBLE,
    }
  }, [location.pathname, location.search, userMenuEntries])
}
