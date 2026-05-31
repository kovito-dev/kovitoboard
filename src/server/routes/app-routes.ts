/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * App extension API router
 *
 * GET /api/app/menu-entries — Return the user-defined menu entries
 *                              parsed from `app/menu.ts`. Empty array
 *                              when the file is absent.
 *
 * Background: the renderer used to load `app/menu.ts` directly via
 * Vite's `import.meta.glob`, but the dev server resolves the glob
 * exactly once when the parent module is first evaluated. Files
 * created later (e.g. by a recipe install) were therefore invisible
 * until the supervisor restarted the dev server. Routing through this
 * endpoint lets the renderer always see the latest contents.
 *
 * @stable v0.1.0
 */
import { Router } from 'express'
import { join } from 'path'
import type { FileAccessLayer } from '../fs-layer'
import {
  assignProvisionalMenuOrder,
  computeMenuOrderSnapshotFromEntries,
  readUserMenuEntries,
  type AppManifestLookup,
  type MenuEntryWithPage,
  type RecipeManifestLookup,
  type TrustLevelLookup,
} from '../services/menu-extractor'
import { getAppManifestPath, readAppManifest } from '../services/app-manifest'
import { readSetting } from '../setting-manager'
import { resolveProjectRoot } from '../config'
import { isWithin } from '../pathResolver'
import type { RecipeManifestStore } from '../recipeManifestStore'
import { serverLogger } from '../logger'
import { isRecipePageTrustLevel } from '../recipe/apiTypes'

/**
 * Build the app extension router.
 *
 * `manifestStore` is required so `/menu-entries` can attach the
 * active recipe's `trustLevel` to each entry. Without it the
 * renderer would have to call back for every entry it renders,
 * which would re-introduce the cross-request latency we already
 * pay once at supervisor startup.
 */
export function createAppRouter(
  fs: FileAccessLayer,
  manifestStore: RecipeManifestStore,
  kovitoboardRoot: string,
): Router {
  const router = Router()

  // Defence-in-depth: `recipeManifestStore.validateManifest` already
  // refuses to load a recipe manifest that carries the reserved
  // `'KB-trusted'` literal, but the wire boundary fails closed too —
  // any value that slips through (e.g. a manifest minted by an older
  // version, or an in-memory mutation after load) is coerced to
  // `null` by the `isRecipePageTrustLevel` guard before reaching the
  // extractor, whose `TrustLevelLookup` contract already statically
  // excludes the forbidden literal.
  const trustLookup: TrustLevelLookup = (appId) => {
    const value = manifestStore.get(appId)?.trustLevel
    if (isRecipePageTrustLevel(value)) return value
    if (value === 'KB-trusted') {
      serverLogger.warn(
        { appId },
        'Refusing to serve KB-trusted on a recipe-page menu entry; coercing to null. ' +
          'KB-trusted is reserved for KB-core surfaces — investigate the manifest source.',
      )
    }
    return null
  }

  // Defence-in-depth: resolve the per-row `app/<appId>` directory
  // through `realpath` and classify the result into three states.
  //
  //   - `'within'`   : the canonical directory exists and stays
  //                    inside `<canonicalProjectRoot>/app`. Safe
  //                    to read the manifest from it.
  //   - `'missing'`  : the per-app directory simply does not
  //                    exist (`ENOENT`). A legitimate legacy
  //                    `menu.ts` row with no on-disk app
  //                    subtree -- not an anomaly.
  //   - `'anomalous'`: every other failure mode (`realpathSync`
  //                    throws for any reason other than `ENOENT`,
  //                    or the resolved path escapes
  //                    `<canonicalProjectRoot>/app`). The row
  //                    cannot be trusted; every destructive UI
  //                    action must be suppressed.
  //
  // Separating `missing` from `anomalous` matters because the
  // renderer suppresses Remove for `anomalous` rows. Treating a
  // perfectly ordinary legacy row whose `app/<appId>/` does not
  // exist as an anomaly would make it undeletable from the new
  // Apps screen.
  function appBoundaryState(
    appId: string,
  ): 'within' | 'missing' | 'anomalous' {
    const projectRoot = resolveProjectRoot(fs)
    let realProjectRoot: string
    try {
      realProjectRoot = fs.realpathSync(projectRoot)
    } catch {
      return 'anomalous'
    }
    const appBoundary = join(realProjectRoot, 'app')
    try {
      const realAppDir = fs.realpathSync(join(projectRoot, 'app', appId))
      return isWithin(realAppDir, appBoundary) ? 'within' : 'anomalous'
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined
      // `ENOENT` is the ordinary "this app has no per-app
      // directory yet" outcome -- treat it as legitimate missing
      // so the renderer keeps Remove available for the row.
      // Every other error (`ELOOP`, `EACCES`, broken symlink
      // chains, permission failures) is opaque and treated as
      // anomalous so the renderer fails closed.
      return code === 'ENOENT' ? 'missing' : 'anomalous'
    }
  }

  // v0.2.1 Apps screen needs each menu row's `AppManifest`-sourced
  // UI fields (source badge / displayName / menuOrder /
  // userMenuLabel). The lookup returns a quad-state result so
  // the wire can carry the explicit `manifestState`
  // discriminator end-to-end and the renderer can split the
  // four meanings -- `present` (normal), `unreadable`
  // (partial-residue recovery), `missing` (legacy hand-edited),
  // and `anomalous` (canonical directory failed the realpath
  // boundary check). Earlier wirings conflated several of those
  // states on `source === null` and produced destructive-
  // routing risks; the structured result closes that surface.
  const manifestLookup: AppManifestLookup = (appId) => {
    const boundary = appBoundaryState(appId)
    if (boundary === 'anomalous') return { state: 'anomalous' }
    if (boundary === 'missing') return { state: 'missing' }
    const projectRoot = resolveProjectRoot(fs)
    const manifestPath = getAppManifestPath(projectRoot, appId)
    if (!fs.existsSync(manifestPath)) return { state: 'missing' }
    const manifest = readAppManifest(fs, projectRoot, appId)
    if (manifest === null) return { state: 'unreadable' }
    return { state: 'present', manifest }
  }

  // Partial-residue fallback for the source badge + recipe
  // lineage. Returns the persisted `RecipeManifest` only when
  // the AppManifest reads as `'unreadable'` -- the contract
  // mirrors that of the lookup above, and the boundary check
  // is re-applied here so a crafted symlink cannot bypass the
  // first lookup's anomaly classification.
  //
  // The lookup deliberately does NOT fire when the AppManifest
  // file is entirely absent. Without that gate, a hand-edited
  // `app/menu.ts` row whose `appId` happens to collide with a
  // stale `recipes-installed/<appId>/manifest.json` would
  // inherit recipe lineage that does not belong to it. A
  // recipe-history evidence join that distinguishes
  // "ever-installed-here" from "stale-residue collision" is the
  // deferred follow-up tracked in the PR's Out-of-Scope list.
  const recipeManifestLookup: RecipeManifestLookup = (appId) => {
    if (appBoundaryState(appId) !== 'within') return null
    const manifestPath = getAppManifestPath(resolveProjectRoot(fs), appId)
    if (!fs.existsSync(manifestPath)) {
      return null
    }
    return manifestStore.get(appId)
  }

  router.get('/menu-entries', (_req, res) => {
    // Active server locale for recipe nav base-label resolution
    // (app-directory-extension.md v1.7.1 §6.8.2.1 / i18n-architecture
    // v1.1 §6.6). Invalid / null / unset falls back to OSS default.
    const locale = readSetting(fs)?.locale ?? 'en'
    const entries: MenuEntryWithPage[] = readUserMenuEntries(
      fs,
      trustLookup,
      manifestLookup,
      recipeManifestLookup,
      locale,
      kovitoboardRoot,
    )
    // The wire ships every entry the parser produced; anomalies
    // are NOT filtered out -- they ride with `manifestState ===
    // 'anomalous'` and the renderer suppresses every destructive
    // action for that state via `AppActionsPopover`. Filtering
    // anomalies here turned out to be too strict: a perfectly
    // valid non-canonical menu.ts entry (id "foo" pointing at
    // `app/pages/Foo.tsx` while `app/foo/` does not exist) would
    // disappear from both the sidebar and the new Apps screen,
    // breaking unrelated `menu.ts` shapes that the legacy
    // extractor already tolerated. Carrying the state on the
    // wire instead lets the renderer keep the row visible while
    // refusing to act on it.
    //
    // Surface the current menu-order snapshot in a response
    // header so the renderer can seed `snapshotVersionRef`
    // before the user's very first reorder lands. The spec pins
    // the wire body to `MenuEntryWithPage[]`, so we route the
    // snapshot through a custom header instead of reshaping the
    // JSON payload. The PUT side recomputes the snapshot from
    // the live manifests at write time; the value the renderer
    // seeds with comes from the persisted-only `menuOrder`
    // values BEFORE provisional indices are injected, so the
    // two snapshots agree on the first reorder.
    res.setHeader(
      'X-Apps-Menu-Snapshot',
      computeMenuOrderSnapshotFromEntries(entries),
    )
    // Apply the spec's transient provisional `menuOrder`
    // assignment AFTER snapshot computation so the wire payload
    // still has a stable sort key for the renderer's first
    // paint even when the persisted manifests carry
    // `menuOrder: null`.
    assignProvisionalMenuOrder(entries)
    res.json(entries)
  })

  return router
}
