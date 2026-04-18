/**
 * injectKb — Bootstrap that injects window.kb when a recipe page mounts.
 *
 * Called just before a recipe-authored page (app/pages/*.tsx) mounts,
 * and cleaned up on unmount.
 *
 * @see recipe-backend-critical-reviews.md §4 (Q-K1)
 * @stable v0.1.0
 */

import { createKbBridge } from '../lib/kbBridge'

/**
 * Inject window.kb.
 *
 * @param recipeId - Recipe ID (captured in a closure)
 * @returns cleanup function (call on unmount)
 */
export function injectKb(recipeId: string): () => void {
  window.kb = createKbBridge(recipeId)
  console.log(`[injectKb] window.kb injected for recipe "${recipeId}"`)

  return () => {
    window.kb = undefined
    console.log(`[injectKb] window.kb cleaned up for recipe "${recipeId}"`)
  }
}
