/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * RecipePageHost — mounts a recipe-authored page (`recipes/<id>/pages/*`)
 * with `window.kb.call` / `window.kb.log` bound to its recipe id.
 *
 * Why a wrapper rather than calling `injectKb` from `useEffect` directly
 * inside the recipe page:
 *
 *   React fires effects in child → parent order. If the recipe page is
 *   the only place that initializes `window.kb`, its first render
 *   completes (and any synchronous `kb.call` triggered by the page's own
 *   initial `useEffect` has already executed) before a parent-side
 *   `useEffect` could attach the bridge.
 *
 *   We instead mutate `window.kb` synchronously during render: on every
 *   render of this wrapper we make sure the bridge matches the current
 *   `appId` prop, so a new Page instance always sees the right
 *   bridge before its own initial effect fires.
 *
 * Why a render-time mutation rather than a useState lazy initializer:
 *
 *   React Router v6 reconciles `<Suspense><RecipePageHost/></Suspense>`
 *   at the same tree position across two `<Route>` siblings, so
 *   navigating /ext/todo → /ext/document-viewer changes
 *   `appId`/`Page` props but does NOT remount RecipePageHost. A
 *   useState lazy initializer only runs on first mount, so the bridge
 *   stayed bound to the originally-mounted recipe and the new page's
 *   `kb.call` arrived at the dispatcher under the wrong recipe id.
 *
 *   The render-time mutation is safe because `window.kb` is global
 *   state outside React's render reconciliation; we are not setting
 *   any React state here.
 *
 * Host bootstrap sentinel (v0.2.0 / spec v1.7 §6.10.6.13 H-CR1):
 *
 *   On every mount we POST a record to `/api/audit/host-bootstrap`
 *   reflecting whether `globalThis.__kbHostBootstrapComplete === true`.
 *   The post is host-emitted (not recipe-cooperative), so a malicious
 *   recipe cannot opt out of being observed. The audit log entry is
 *   the operational truth used by L1 E2E to confirm the bootstrap
 *   fence actually held for every fixture mount.
 */

import { useEffect, useRef, type ComponentType } from 'react'
import { injectKb } from './injectKb'
import { hostFetchWithInternalAuth } from './hostBootstrap'
import { createLogger } from '../lib/logger'
import { TrustProvider } from './TrustContext'
import { TrustMarker } from '../components/TrustMarker'
import type { RecipePageTrustLevel } from '../../shared/recipe-types'

interface Props {
  appId: string
  Page: ComponentType
  /**
   * Trust-axis value resolved from the active recipe manifest,
   * narrowed to {@link RecipePageTrustLevel} so `'KB-trusted'` is
   * statically excluded at the recipe-page boundary. `null` is the
   * legitimate "no manifest registered yet" state — the trust
   * marker hides itself rather than rendering a misleading badge.
   *
   * Propagated to children via the trust context so any KB-provided
   * widget rendered inside the recipe page can read the value
   * without prop drilling.
   *
   * @see docs/design/handoffs/v02x-phase1-trust-marker-preamble-warning-request.md v1.1 §3.2
   */
  trustLevel: RecipePageTrustLevel | null
}

const sentinelLog = createLogger('host-bootstrap-sentinel')

interface KbHostBootstrapGlobal {
  __kbHostBootstrapComplete?: boolean
}

/**
 * Emit a host-bootstrap sentinel record for this mount.
 *
 * Reads `globalThis.__kbHostBootstrapComplete` and POSTs the result
 * to `/api/audit/host-bootstrap`. The post is fire-and-forget; the
 * audit log itself is the canonical truth for L1 E2E. Logs locally
 * as well so operators see violations in real time.
 */
function emitHostBootstrapSentinel(
  appId: string,
  recipePath: string,
): void {
  const completed =
    (globalThis as unknown as KbHostBootstrapGlobal)
      .__kbHostBootstrapComplete === true
  const event = completed
    ? 'host-bootstrap-verified'
    : 'host-bootstrap-violation'
  if (!completed) {
    sentinelLog.error(
      { appId, recipePath },
      'host bootstrap violation: recipe page mounted before host bootstrap completed',
    )
  }
  void hostFetchWithInternalAuth('/api/audit/host-bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event,
      recipePath,
      appId,
      when: 'before-recipe-render',
    }),
  }).catch(() => {
    /* best-effort — operators see the failure via the logger */
  })
}

export function RecipePageHost({ appId, Page, trustLevel }: Props) {
  // `current` holds the recipe id we last bound `window.kb` to and the
  // cleanup returned by that injectKb call.
  const ref = useRef<{ appId: string; cleanup: () => void } | null>(null)
  // Idempotence: emit the sentinel exactly once per mount target,
  // not per render. Strict Mode + React Router reconciliation could
  // otherwise duplicate the audit entry.
  const sentinelEmittedForAppId = useRef<string | null>(null)

  if (ref.current === null) {
    // First render of this wrapper instance — bind the bridge.
    ref.current = { appId, cleanup: injectKb(appId) }
  } else if (ref.current.appId !== appId) {
    // Same wrapper instance, different recipe (route swap that React
    // Router reconciled in place). Tear down the old bridge and bind
    // the new recipe's bridge synchronously, so the wrapped page's
    // first effect sees the correct `window.kb`.
    ref.current.cleanup()
    ref.current = { appId, cleanup: injectKb(appId) }
  }

  useEffect(() => {
    if (sentinelEmittedForAppId.current === appId) return
    sentinelEmittedForAppId.current = appId
    // `recipePath` is currently the appId — we keep them as separate
    // fields so future routing changes (e.g. /ext/<appId>/<page>)
    // can distinguish the two without breaking log readers.
    emitHostBootstrapSentinel(appId, appId)
  }, [appId])

  // Final cleanup on unmount. We deliberately ignore re-renders here
  // (the `[]` dep) because the prop-change branch above already keeps
  // the bridge in sync.
  useEffect(() => {
    return () => {
      ref.current?.cleanup()
      ref.current = null
    }
  }, [])

  // The `/ext/<appId>` router contract is that every recipe page
  // route is wrapped in `RecipePageHost`. The trust marker + context
  // are rendered from the host wrapper so the renderer guarantees
  // they are *attempted* on every recipe mount.
  //
  // Honest claim (recipe-system.md v1.7.3 §6.10.6.11
  // "v0.2.x-known-limitation: same-realm transport interception"):
  // this is a visibility signal, not a structural boundary. Recipe
  // code runs in the same DOM / JS / CSS scope, so a hostile recipe
  // can hide or remove `[data-testid="recipe-trust-header"]` via
  // global CSS, direct DOM mutation, or runtime patching of
  // `React.createElement`. v0.3.0 isolation work
  // (recipe-system.md v1.7.3 §6.10.6.12) is where the structural
  // version of this defence will live; until then the marker
  // reduces forgeability for honest-but-mistaken recipes and
  // surfaces the trust level to attentive users.
  return (
    <TrustProvider value={trustLevel}>
      <div className="flex flex-1 flex-col">
        <header
          data-testid="recipe-trust-header"
          className="flex items-center justify-end gap-2 px-4 pt-2"
        >
          <TrustMarker level={trustLevel} />
        </header>
        <div className="flex-1">
          <Page />
        </div>
      </div>
    </TrustProvider>
  )
}
