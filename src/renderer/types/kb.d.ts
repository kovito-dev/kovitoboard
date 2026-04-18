/**
 * KovitoBoard Recipe Bridge API — window.kb 型宣言.
 *
 * レシピページ（recipes/{id}/pages/*.tsx）の mount 中のみ有効。
 * コア UI コンポーネントからは使用しない。
 *
 * 将来 v0.2.0 で iframe 隔離に移行する可能性があるが、
 * call 署名は stable に保つためレシピコードの変更は不要。
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
