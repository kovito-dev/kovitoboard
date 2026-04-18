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
    }
  }
}

export {}
