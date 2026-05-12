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
import { createCaptureBridge } from '../lib/captureBridge'
import type { CaptureKind } from '../lib/captureBridge'

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
 * `capture` is layered onto the recipe-scoped bridge as well: the
 * v0.2.0 opt-in mechanism (`app-directory-extension.md` v1.2
 * §10.5.2) needs an appId to identify the active recipe, and that
 * id is the same closure captured here. The capture bridge is
 * dropped on cleanup along with `call` and `log`.
 *
 * @param appId - KB-local app identifier (captured in a closure)
 * @param approvedCaptures - Optional client-side cache of the
 *   recipe's `manifest.approvedCaptures`. When supplied, the
 *   capture bridge short-circuits obvious rejections without a
 *   server round-trip. When omitted, every call defers to the
 *   server-side gate — the server is the authority either way
 *   (`app-directory-extension.md` §10.5.2: "client side check is
 *   the auxiliary; server side verification is authoritative").
 * @returns cleanup function (call on unmount)
 */
export function injectKb(
  appId: string,
  approvedCaptures?: readonly CaptureKind[],
): () => void {
  const bridge = createKbBridge(appId)
  // Recipe-scoped logger. The `app.` prefix is the user-extension
  // namespace required by DEC-017 v1.3 §11; recipe authors don't see
  // it explicitly — we add it here so the recipe id alone is enough
  // identification on the recipe side.
  const recipeLogger = createLogger(`app.${appId}`)
  const captureBridge = createCaptureBridge({
    appId,
    // Forward the optional cache as-is. `undefined` keeps the bridge
    // in server-only mode (the v0.2.x default), an array opts in to
    // the local fast-path refusal.
    approvedCaptures,
    log: recipeLogger,
  })

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
    capture: captureBridge,
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
