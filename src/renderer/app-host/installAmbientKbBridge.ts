/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * installAmbientKbBridge — bootstrap the always-on portion of
 * `window.kb` for the Ambient Session Sidebar (DEC-020 / EU8 §2.4
 * β-method).
 *
 * The historic `window.kb` object (`call`, `log`) is bound to recipe
 * page lifecycle by app-host/injectKb.ts. The ambient sidebar's
 * `exposeContext` API needs to be reachable from any page (including
 * builtin screens and user extension apps), not just recipes, so we
 * seed `window.kb` with a minimal object at app start. injectKb merges
 * `call` / `log` on top of this seed when a recipe page mounts and
 * preserves `exposeContext` on cleanup.
 *
 * `call` and `log` are intentionally absent here — invoking them
 * outside a recipe page is a programmer error and should fail loudly
 * via the existing TypeScript optional checks.
 *
 * Architect Q6 review (DEC-006 extension necessity, kovito-hq
 * 2026-04-27): NO EXTENSION REQUIRED. The `noopCall` returned here
 * operates at the layer *before* DEC-006 §12-3 scope enforcement —
 * specifically, it gates on whether a recipe id is in scope at all.
 * Because handler dispatch presupposes a resolved recipe id, refusing
 * `kb.call` outside a mounted recipe page is strictly stronger than
 * scope checking: scope violations cannot reach the dispatcher because
 * the call never gets there. DEC-006 §12-3 and DEC-020 v1.1 §6 both
 * remain as written; no DEC amendment is needed. See spec
 * `docs/specs/v0.1.0-ambient-sidebar.md` §4.2 Q6 for the full
 * rationale.
 */

import { setExposedContext } from '../lib/exposeContext'
import { createLogger } from '../lib/logger'
import { getLocale } from '../i18n'

const log = createLogger('installAmbientKbBridge')

/**
 * `kb.call` outside of recipe scope is a programmer error: handler
 * dispatch requires the recipe id captured by injectKb's closure.
 * Returning an error result keeps the type contract honest while
 * surfacing the misuse loudly.
 */
async function noopCall(): Promise<{ ok: false; error: { code: string; message: string } }> {
  log.warn('window.kb.call invoked outside recipe page scope')
  return {
    ok: false,
    error: {
      code: 'NotInRecipeScope',
      message: 'window.kb.call is only available while a recipe page is mounted',
    },
  }
}

/**
 * `kb.log` outside of recipe scope: route the record through the
 * generic renderer logger under a fallback component name so messages
 * are not silently lost.
 */
const fallbackRecipeLog = createLogger('app.unknown')

export function installAmbientKbBridge(): void {
  // Preserve any pre-existing fields (defensive: tests that pre-seed
  // window.kb, future bootstrap order changes).
  const existing = window.kb
  window.kb = {
    call: existing?.call ?? noopCall,
    log: existing?.log ?? fallbackRecipeLog,
    exposeContext: (payload: Record<string, unknown>) => {
      setExposedContext(payload)
    },
    // Snapshot the active locale at bridge install time so non-recipe
    // surfaces also expose a stable `window.kb.locale`. Recipe pages
    // read this when they cannot import the host i18n catalog directly
    // (app-directory-extension.md v1.7 §5.4.1 / §5.4.4).
    locale: getLocale(),
  }
}
