/**
 * injectKb — レシピページ mount 時に window.kb を注入するブートストラップ.
 *
 * レシピ由来ページ（app/pages/*.tsx）のマウント直前に呼び出し、
 * アンマウント時にクリーンアップする。
 *
 * @see recipe-backend-critical-reviews.md §4 (Q-K1)
 * @stable v0.1.0
 */

import { createKbBridge } from '../lib/kbBridge'

/**
 * window.kb を注入する.
 *
 * @param recipeId - レシピ ID（クロージャに保持）
 * @returns cleanup function（アンマウント時に呼ぶ）
 */
export function injectKb(recipeId: string): () => void {
  window.kb = createKbBridge(recipeId)
  console.log(`[injectKb] window.kb injected for recipe "${recipeId}"`)

  return () => {
    window.kb = undefined
    console.log(`[injectKb] window.kb cleaned up for recipe "${recipeId}"`)
  }
}
