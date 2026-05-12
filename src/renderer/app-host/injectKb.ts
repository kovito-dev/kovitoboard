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
 * v0.2.0 opt-in mechanism (`app-directory-extension.md` v1.2.1
 * §10.5.2) needs an appId to identify the active recipe, and that
 * id is the same closure captured here. The capture bridge is
 * dropped on cleanup along with `call` and `log`.
 *
 * @param appId - KB-local app identifier (captured in a closure)
 * @param manifestCaches - Optional client-side caches that let the
 *   capture bridge short-circuit obvious rejections without a
 *   server round-trip. When omitted, every call defers to the
 *   server-side gate — the server is the authority either way
 *   (`app-directory-extension.md` §10.5.2: "client side check is
 *   the auxiliary; server side verification is authoritative"). The
 *   two caches map directly to the v1.5 manifest fields
 *   `captureRequires` (step 3) and `approvedCaptures` (step 4).
 * @returns cleanup function (call on unmount)
 */
export function injectKb(
  appId: string,
  manifestCaches: {
    captureRequires?: readonly CaptureKind[]
    approvedCaptures?: readonly CaptureKind[]
  } = {},
): () => void {
  const bridge = createKbBridge(appId)
  // Recipe-scoped logger. The `app.` prefix is the user-extension
  // namespace required by DEC-017 v1.3 §11; recipe authors don't see
  // it explicitly — we add it here so the recipe id alone is enough
  // identification on the recipe side.
  const recipeLogger = createLogger(`app.${appId}`)
  const captureBridge = createCaptureBridge({
    appId,
    // Forward the optional caches as-is. `undefined` on either axis
    // keeps that step in server-only mode (the v0.2.x default
    // because RecipePageHost has no manifest fetch yet); an array
    // opts the bridge into the matching local fast-path refusal.
    captureRequires: manifestCaches.captureRequires,
    approvedCaptures: manifestCaches.approvedCaptures,
    log: recipeLogger,
  })

  // Kick off the capture-token issuance as soon as the bridge is
  // installed. We deliberately fire-and-forget: subsequent
  // `window.kb.capture.*` calls observe the cached token (or `null`
  // on grandfather / failure paths) and fail-fast appropriately, so
  // an awaited issue here would only delay page mount without
  // changing the observable contract. Promise rejections are
  // impossible — `issueToken` always resolves and routes failures
  // through the closure-state machine + warn log. The defensive
  // `.catch` exists only as a future-proofing seam against accidental
  // surface changes.
  captureBridge.issueToken().catch(() => {
    /* unreachable in current implementation; see issueToken contract */
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
    // Expose only the capture methods recipe code is allowed to
    // call. `issueToken` / `revokeToken` stay on the closure-side
    // bridge object so recipe authors cannot mint or revoke tokens
    // outside the mount lifecycle.
    capture: {
      a11y: captureBridge.a11y,
      exposedContext: captureBridge.exposedContext,
    },
  }
  window.kb = self
  ownLog.info({ appId }, 'window.kb injected')

  return () => {
    // Revoke the capture token unconditionally — even when a
    // sibling bridge has already replaced `window.kb` for the next
    // recipe page. The sibling-replacement guard protects only the
    // global-object mutation (we must not clobber the sibling's
    // bridge), but the OLD recipe's token is still bound to its
    // OLD appId on the server, so leaving it live would let the
    // bridge-replacement race exfiltrate the old token's lifetime
    // up to TTL_MS. Fire-and-forget: `revokeToken` swallows
    // network failures internally and is idempotent, so a
    // double-cleanup during React useEffect races is safe.
    captureBridge.revokeToken().catch(() => {
      /* unreachable; revokeToken always resolves */
    })
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
