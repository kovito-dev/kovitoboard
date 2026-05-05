/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard Recipe Bridge API — window.kb type declarations.
 *
 * Available only while a recipe page (recipes/{id}/pages/*.tsx) is mounted.
 * Do not use from core UI components.
 *
 * May migrate to iframe isolation in v0.2.0, but the call signature
 * is kept stable so recipe code requires no changes.
 *
 * @see recipe-backend-critical-reviews.md §4 (Q-K1)
 * @stable v0.1.0
 */

interface KbHandlerResponse<T> {
  ok: true
  data: T
}

interface KbHandlerError {
  ok: false
  error: { code: string; message: string }
}

type KbCallResult<T = unknown> = KbHandlerResponse<T> | KbHandlerError

/**
 * Logger surface exposed to recipe pages via `window.kb.log`.
 * Mirrors the pino-shaped call convention used everywhere else in
 * KovitoBoard: each method accepts either a string message or a
 * structured-data object plus an optional message.
 *
 * Records emitted via `window.kb.log` land in `.kovitoboard/logs/server.*.log`
 * tagged with `component: "app.<recipeId>"` (the prefix is added by
 * the KB renderer side; recipe authors only see the recipe name).
 *
 * @see DEC-017 v1.3 §11 (user-extension logging contract)
 */
interface KbLogger {
  debug(msgOrData: string | object, msg?: string): void
  info(msgOrData: string | object, msg?: string): void
  warn(msgOrData: string | object, msg?: string): void
  error(msgOrData: string | object, msg?: string): void
}

declare global {
  interface Window {
    /**
     * KovitoBoard Recipe Bridge API.
     *
     * Available ONLY inside recipe-authored pages (recipes/{id}/pages/*.tsx).
     * Do NOT use from core UI components — the API is injected only during
     * recipe page mount and will be undefined elsewhere.
     *
     * Future: this may migrate to an iframe-based bridge. Keep the call
     * signature stable so recipe code continues to work without changes.
     */
    kb?: {
      call: <T = unknown>(
        callId: string,
        input?: Record<string, unknown>,
      ) => Promise<KbCallResult<T>>
      /**
       * Structured logger bound to this recipe. Records are emitted as
       * `app.<recipeId>` and merged with the rest of the KB log stream.
       *
       * @see DEC-017 v1.3 §11
       */
      log: KbLogger
      /**
       * Publish a screen-context payload for the Ambient Session
       * Sidebar (DEC-020 / EU8 §2.4 β-method). Apps and recipes call
       * this from a useEffect to surface internal state (selected ids,
       * active filter, etc.) so the agent can reason about state the
       * DOM does not show.
       *
       * Each call replaces the previous payload (no merge). The payload
       * must be a plain JSON-serializable object and serialize to at
       * most 100 KB; oversized or non-serializable payloads are
       * rejected silently with a console warning, leaving the previous
       * payload intact.
       *
       * Available app-wide from app start (separate lifecycle from
       * `call` and `log`, which are scoped to recipe page mount).
       */
      exposeContext: (payload: Record<string, unknown>) => void
    }
  }
}

export {}
