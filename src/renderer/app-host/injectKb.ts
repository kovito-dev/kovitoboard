/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * injectKb — Bootstrap that injects window.kb when a recipe page mounts.
 *
 * Called just before a recipe-authored page (app/pages/*.tsx) mounts,
 * and cleaned up on unmount. Exposes both the API bridge
 * (`window.kb.call`) and the structured logger (`window.kb.log`) bound
 * to the recipe; the latter routes records through the same WebSocket
 * transport as the rest of the renderer (DEC-017 v1.3 §11), tagging
 * each record with `component: "app.<appId>"`.
 *
 * @see recipe-backend-critical-reviews.md §4 (Q-K1)
 * @see DEC-017 v1.3 §11 (user-extension logging contract)
 * @stable v0.1.0
 */

import { createKbBridge } from '../lib/kbBridge'
import { setExposedContext } from '../lib/exposeContext'
import { createLogger } from '../lib/logger'
import { installAmbientKbBridge } from './installAmbientKbBridge'

const ownLog = createLogger('injectKb')

/**
 * Inject window.kb for recipe page lifecycle.
 *
 * Layers `call` and `log` on top of the always-on
 * `exposeContext` channel that installAmbientKbBridge bootstraps at
 * app start (DEC-020 / EU8 Phase 5). The cleanup function restores
 * the bootstrap shape so `exposeContext` remains usable from any
 * page even after the recipe unmounts.
 *
 * @param appId - KB-local app identifier (captured in a closure)
 * @returns cleanup function (call on unmount)
 */
export function injectKb(appId: string): () => void {
  const bridge = createKbBridge(appId)
  // Recipe-scoped logger. The `app.` prefix is the user-extension
  // namespace required by DEC-017 v1.3 §11; recipe authors don't see
  // it explicitly — we add it here so the recipe id alone is enough
  // identification on the recipe side.
  const recipeLogger = createLogger(`app.${appId}`)

  // Preserve the existing exposeContext when present (it is bootstrapped
  // at app start). When missing — e.g. unit tests that skip the
  // bootstrap — fall back to the same store binding.
  const existingExpose = window.kb?.exposeContext
  // Capture our own kb object so the cleanup below can tell whether
  // it is still the active one. Navigating between two recipe pages
  // (e.g. /ext/todo → /ext/document-viewer) sequences renders such
  // that the new RecipePageHost's useState lazy initializer runs —
  // and replaces window.kb with the new recipe's bridge — *before*
  // the old RecipePageHost's useEffect cleanup fires. If the cleanup
  // unconditionally reset window.kb to the ambient bridge it would
  // clobber the new recipe's bridge that the renderer just installed,
  // and the next page's useEffect would call kb.call on the old
  // recipe id (or on the noop ambient call). The `=== self` guard
  // makes cleanup a no-op once a sibling has already replaced us.
  const self = {
    ...bridge,
    log: recipeLogger,
    exposeContext: existingExpose ?? ((payload: Record<string, unknown>) => {
      setExposedContext(payload)
    }),
  }
  window.kb = self
  ownLog.info({ appId }, 'window.kb injected')

  return () => {
    if (window.kb !== self) {
      ownLog.debug({ appId }, 'window.kb cleanup skipped (sibling replaced us)')
      return
    }
    // Reset to the ambient bridge shape (noop `call` / fallback `log`
    // / always-on `exposeContext`) so non-recipe screens keep working
    // after the recipe page unmounts. We clear `window.kb` first
    // because `installAmbientKbBridge` is bootstrap-shaped: it
    // preserves any pre-existing `call` / `log` for defensive
    // ordering, which would otherwise leak the recipe-scoped bridge
    // back to subsequent pages. Going through undefined forces it to
    // lay down the ambient defaults.
    window.kb = undefined
    installAmbientKbBridge()
    ownLog.info({ appId }, 'window.kb cleaned up')
  }
}
