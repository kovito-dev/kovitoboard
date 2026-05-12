/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * injectKb — Bootstrap that injects window.kb when a recipe page mounts.
 *
 * Called just before a recipe-authored page (app/pages/*.tsx) mounts,
 * and cleaned up on unmount. Exposes the API bridge
 * (`window.kb.call`), the structured logger (`window.kb.log`), and
 * the capture surface (`window.kb.capture`) bound to the recipe.
 *
 * Capture lifecycle (v0.2.0 / spec v1.7 §6.10.6):
 *   - mount: `captureBridgeRegistry.openMount(appId)` performs
 *     `POST /api/app/capture-mount/open` + `POST /api/app/capture-token/issue`
 *     under host-only `X-KB-Internal-Auth` (recipe code never sees
 *     the internal token, I-CR4 / I-CR7).
 *   - capture call: the recipe-visible bridge attaches the cached
 *     token via `X-KB-Capture-Token`. On 403 capture-token-* the
 *     bridge asks the registry for a refresh + retries once.
 *   - unmount: `captureBridgeRegistry.closeMount(mountId)` performs
 *     `POST /api/app/capture-mount/close` which atomically drops
 *     both the mount and the bound token on the server (H-CR4).
 *
 * @see recipe-system.md v1.7 §6.10.6
 * @see app-directory-extension.md v1.4 §10.5.2
 * @stable v0.1.0
 */

import { createKbBridge } from '../lib/kbBridge'
import { setExposedContext } from '../lib/exposeContext'
import { createLogger } from '../lib/logger'
import { installAmbientKbBridge } from './installAmbientKbBridge'
import { createCaptureBridge } from '../lib/captureBridge'
import type { CaptureKind, CaptureBridge } from '../lib/captureBridge'
import { openMount, closeMount } from './captureBridgeRegistry'

const ownLog = createLogger('injectKb')

/**
 * Inject window.kb for recipe page lifecycle.
 *
 * The mount-time orchestration (open + issue) fires fire-and-forget
 * so the recipe page does not block on capture bootstrap. Capture
 * calls observe the cached `{ mountId, token }` once the orchestration
 * resolves; until then they fail-fast with the opaque
 * `CaptureNotApprovedError` (same envelope as a permanently-disabled
 * capture, so recipe authors cannot use the timing to fingerprint
 * grandfather state).
 *
 * @param appId - KB-local app identifier (captured in a closure)
 * @param manifestCaches - Optional client-side caches that let the
 *   capture bridge short-circuit obvious rejections without a
 *   server round-trip.
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
  // namespace required by DEC-017 v1.3 §11.
  const recipeLogger = createLogger(`app.${appId}`)

  // The capture bridge starts in `mountId: null, initialToken: null`
  // mode — every capture call fails-fast with the opaque error
  // envelope. Once the host-mediated open + issue resolves we swap
  // the cached values into the same bridge instance via a
  // shared-state ref so recipe code does not need to refetch
  // `window.kb`.
  let captureBridge: CaptureBridge = createCaptureBridge({
    appId,
    mountId: null,
    initialToken: null,
    captureRequires: manifestCaches.captureRequires,
    approvedCaptures: manifestCaches.approvedCaptures,
    log: recipeLogger,
  })

  let cleanedUp = false
  let liveMountId: string | null = null

  // Kick off the host-mediated mount-open + token-issue. If
  // the orchestration succeeds we replace the bridge with a
  // mountId-bound one (the recipe-visible methods are still
  // accessible via the `window.kb.capture` proxy we set below).
  void openMount(appId, recipeLogger)
    .then((result) => {
      if (cleanedUp) {
        if (result.kind === 'live') {
          // Late response — unmount already fired. Close the mount
          // on the server to release the slot.
          void closeMount(result.mountId, recipeLogger)
        }
        return
      }
      if (result.kind === 'live') {
        liveMountId = result.mountId
        // Replace the bridge with a mountId-bound instance. The
        // proxy object on `window.kb.capture` is updated below.
        const liveBridge = createCaptureBridge({
          appId,
          mountId: result.mountId,
          initialToken: result.token,
          captureRequires: manifestCaches.captureRequires,
          approvedCaptures: manifestCaches.approvedCaptures,
          log: recipeLogger,
        })
        captureBridge.dispose()
        captureBridge = liveBridge
        if (window.kb !== undefined && window.kb === self) {
          window.kb = {
            ...self,
            capture: {
              a11y: liveBridge.a11y,
              exposedContext: liveBridge.exposedContext,
            },
          }
        }
        ownLog.info({ appId, mountId: result.mountId }, 'capture-mount: live')
      } else if (result.kind === 'grandfather') {
        ownLog.info({ appId }, 'capture-mount: grandfather (no capture for this recipe)')
      } else {
        ownLog.warn({ appId, reason: result.reason }, 'capture-mount: failed')
      }
    })
    .catch((err) => {
      ownLog.warn({ appId, err }, 'capture-mount: unexpected error')
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
  // the old RecipePageHost's useEffect cleanup fires.
  const self = {
    ...bridge,
    log: recipeLogger,
    exposeContext: existingExpose ?? ((payload: Record<string, unknown>) => {
      setExposedContext(payload)
    }),
    // Expose only the capture methods recipe code is allowed to
    // call. `dispose` stays on the closure-side bridge object so
    // recipe authors cannot tear down the registration manually.
    capture: {
      a11y: (...args: Parameters<CaptureBridge['a11y']>) => captureBridge.a11y(...args),
      exposedContext: (...args: Parameters<CaptureBridge['exposedContext']>) =>
        captureBridge.exposedContext(...args),
    },
  }
  window.kb = self
  ownLog.info({ appId }, 'window.kb injected')

  return () => {
    cleanedUp = true
    // Close the mount unconditionally — even when a sibling bridge
    // has already replaced `window.kb` for the next recipe page. The
    // server-side `/capture-mount/close` atomically drops the mount
    // + bound token in a single synchronous slice (H-CR4), so a
    // double-close during a React cleanup race is harmless.
    if (liveMountId !== null) {
      void closeMount(liveMountId, recipeLogger)
    }
    captureBridge.dispose()
    if (window.kb !== self) {
      ownLog.debug({ appId }, 'window.kb cleanup skipped (sibling replaced us)')
      return
    }
    // Reset to the ambient bridge shape (noop `call` / fallback `log`
    // / always-on `exposeContext`).
    window.kb = undefined
    installAmbientKbBridge()
    ownLog.info({ appId }, 'window.kb cleaned up')
  }
}
