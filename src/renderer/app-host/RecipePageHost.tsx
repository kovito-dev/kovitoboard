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
 *   `kb.call` arrived at the dispatcher under the wrong recipe id —
 *   surfaced to the user as
 *   `Call "list-docs" is not declared in recipe "todo"`.
 *
 *   The render-time mutation is safe because `window.kb` is global
 *   state outside React's render reconciliation; we are not setting
 *   any React state here.
 */

import { useEffect, useRef, type ComponentType } from 'react'
import { injectKb } from './injectKb'

interface Props {
  appId: string
  Page: ComponentType
}

export function RecipePageHost({ appId, Page }: Props) {
  // `current` holds the recipe id we last bound `window.kb` to and the
  // cleanup returned by that injectKb call.
  const ref = useRef<{ appId: string; cleanup: () => void } | null>(null)

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

  // Final cleanup on unmount. We deliberately ignore re-renders here
  // (the `[]` dep) because the prop-change branch above already keeps
  // the bridge in sync.
  useEffect(() => {
    return () => {
      ref.current?.cleanup()
      ref.current = null
    }
  }, [])

  return <Page />
}
